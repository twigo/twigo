use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;
use twigo_log::{Facts, Level, Log};

const CHILD: &str = "TWIGO_LOG_TEST_DIRECTORY";

fn child() -> Option<PathBuf> {
    std::env::var_os(CHILD).map(PathBuf::from)
}

fn start(directory: &Path) -> Log {
    Log::start(directory, &Facts::detect("1.2.3", None, None))
}

fn rerun(test: &str, directory: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture"])
        .env_remove("TWIGO_LOG")
        .env(CHILD, directory);
    command
}

fn passed(output: &Output) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("1 passed"), "{stdout}");
}

fn lines(directory: &Path) -> Vec<Value> {
    std::fs::read_to_string(directory.join("twigo.log"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("a JSON line"))
        .collect()
}

#[test]
fn a_failing_log_never_panics_on_a_broken_stderr() {
    const TEST: &str = "a_failing_log_never_panics_on_a_broken_stderr";
    if let Some(directory) = child() {
        std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
        start(&directory.join("a-file/logs"));
        start(&directory.join("logs"));
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("a-file"), "").unwrap();
    let logs = directory.path().join("logs");
    std::fs::create_dir(&logs).unwrap();
    std::fs::write(logs.join("twigo.log"), "the previous run\n").unwrap();
    std::fs::write(logs.join("twigo.4.log"), "an older run\n").unwrap();
    std::fs::create_dir(logs.join("twigo.5.log")).unwrap();
    std::fs::write(logs.join("twigo.5.log/kept"), "").unwrap();

    let mut child = rerun(TEST, directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stderr.take());
    drop(child.stdin.take());
    passed(&child.wait_with_output().unwrap());
}

#[test]
fn a_narrow_twigo_log_still_writes_the_facts_line() {
    const TEST: &str = "a_narrow_twigo_log_still_writes_the_facts_line";
    if let Some(directory) = child() {
        start(&directory);
        return;
    }
    for filter in ["warn", "twigo_kube::credentials=debug", "off"] {
        let directory = tempfile::tempdir().unwrap();
        let output = rerun(TEST, directory.path())
            .env("TWIGO_LOG", filter)
            .output()
            .unwrap();
        passed(&output);
        let lines = lines(directory.path());
        let [facts] = &lines[..] else {
            panic!("only the facts line under {filter}: {lines:?}");
        };
        assert_eq!(facts["fields"]["message"], "Twigo started");
        assert_eq!(facts["fields"]["filter"], filter);
    }
}

fn messages(lines: &[Value]) -> Vec<(&str, &str)> {
    lines
        .iter()
        .map(|line| {
            (
                line["target"].as_str().unwrap(),
                line["fields"]["message"].as_str().unwrap(),
            )
        })
        .collect()
}

fn emit() {
    tracing::debug!(target: "twigo_core::catalog", "a debug line");
    tracing::info!(target: "twigo_core::catalog", "an info line");
    tracing::info!(target: "kube_client::client", "a library's info line");
}

#[test]
fn a_valid_twigo_log_applies_and_an_invalid_one_is_said_and_the_default_applies() {
    const TEST: &str =
        "a_valid_twigo_log_applies_and_an_invalid_one_is_said_and_the_default_applies";
    if let Some(directory) = child() {
        start(&directory);
        emit();
        return;
    }
    let run = |filter: &str| {
        let directory = tempfile::tempdir().unwrap();
        let output = rerun(TEST, directory.path())
            .env("TWIGO_LOG", filter)
            .output()
            .unwrap();
        passed(&output);
        lines(directory.path())
    };

    let lines = run("warn,twigo=debug");
    assert_eq!(lines[0]["fields"]["filter"], "warn,twigo=debug");
    assert_eq!(
        messages(&lines)[1..],
        [
            ("twigo_core::catalog", "a debug line"),
            ("twigo_core::catalog", "an info line"),
        ]
    );

    let lines = run("twigo=loud");
    assert_eq!(lines[0]["fields"]["filter"], "warn,twigo=info");
    assert_eq!(
        messages(&lines)[1..],
        [
            (
                "twigo_log",
                "TWIGO_LOG is not a filter, so the default applies"
            ),
            ("twigo_core::catalog", "an info line"),
        ]
    );
    assert_eq!(lines[1]["level"], "WARN");
    assert!(
        lines[1]["fields"]["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
    );
}

#[test]
fn a_log_that_cannot_open_leaves_the_app_running_with_its_lines_on_stderr() {
    const TEST: &str = "a_log_that_cannot_open_leaves_the_app_running_with_its_lines_on_stderr";
    if let Some(directory) = child() {
        start(&directory.join("a-file/logs"));
        emit();
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("a-file"), "").unwrap();
    let output = rerun(TEST, directory.path()).output().unwrap();
    passed(&output);
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("cannot be opened"), "{stderr}");
    let lines: Vec<Value> = stderr
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    assert_eq!(
        messages(&lines),
        [
            ("twigo_log::facts", "Twigo started"),
            ("twigo_core::catalog", "an info line"),
        ]
    );
}

#[test]
fn a_started_log_takes_each_event_and_each_log_record_once_and_follows_its_level() {
    const TEST: &str =
        "a_started_log_takes_each_event_and_each_log_record_once_and_follows_its_level";
    let Some(directory) = child() else {
        let directory = tempfile::tempdir().unwrap();
        passed(&rerun(TEST, directory.path()).output().unwrap());
        return;
    };
    let log = start(&directory);

    tracing::warn!(target: "kube_client::client", "a request failed");
    tracing_log::log::warn!(target: "tao::platform", "a window went away");
    tracing_log::log::info!(target: "tao::platform", "below the libraries' filter");
    tracing::debug!(target: "twigo_core::catalog", "before");
    log.set_level(Level::DEBUG);
    tracing_log::log::debug!(target: "twigo_core::catalog", "a log record after");
    tracing_log::log::debug!(target: "tao::platform", "a library stays at warn");

    let written: Vec<(String, String)> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a JSON line"))
        .map(|line| {
            (
                line["target"].as_str().unwrap().to_owned(),
                line["fields"]["message"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let pair = |target: &str, message: &str| (target.to_owned(), message.to_owned());
    assert_eq!(
        written,
        [
            pair("twigo_log::facts", "Twigo started"),
            pair("kube_client::client", "a request failed"),
            pair("tao::platform", "a window went away"),
            pair("twigo_log", "the log level changed"),
            pair("twigo_core::catalog", "a log record after"),
        ]
    );
}
