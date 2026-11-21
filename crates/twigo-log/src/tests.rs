use serde_json::Value;
use tracing::dispatcher::with_default;
use tracing::{Dispatch, debug, info, warn};

use super::*;

fn open(directory: &Path, spec: &str) -> (Dispatch, Log) {
    let file = Rotating::open_new(&directory.join(FILE), LIMITS, rotating::to_stderr).unwrap();
    let (dispatch, filter) = subscriber(BoxMakeWriter::new(file.clone()), EnvFilter::new(spec));
    let log = Log {
        path: file.path().to_owned(),
        filter,
    };
    (dispatch, log)
}

fn lines(log: &Log) -> Vec<Value> {
    std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("a JSON line"))
        .collect()
}

#[test]
fn an_event_is_one_json_line_with_its_fields() {
    let directory = tempfile::tempdir().unwrap();
    let (dispatch, log) = open(directory.path(), DEFAULT_FILTER);
    with_default(&dispatch, || {
        warn!(
            context = "prod-eu",
            count = 3,
            "could not read the kubeconfig"
        );
    });
    let [line] = &lines(&log)[..] else {
        panic!("one line");
    };
    assert_eq!(line["level"], "WARN");
    assert_eq!(line["target"], "twigo_log::tests");
    assert_eq!(line["fields"]["message"], "could not read the kubeconfig");
    assert_eq!(line["fields"]["context"], "prod-eu");
    assert_eq!(line["fields"]["count"], 3);
    assert!(line["timestamp"].as_str().unwrap().ends_with('Z'), "{line}");
    assert!(
        line.get("spans").is_none() && line.get("span").is_none(),
        "{line}"
    );
}

#[test]
fn a_reload_changes_what_is_written_for_twigo_and_not_for_a_library() {
    let directory = tempfile::tempdir().unwrap();
    let (dispatch, log) = open(directory.path(), DEFAULT_FILTER);
    with_default(&dispatch, || {
        debug!(target: "twigo_core::catalog", "before");
        log.set_level(Level::DEBUG);
        debug!(target: "twigo_core::catalog", "after");
        debug!(target: "hyper_util::client", "a library stays at warn");
        log.set_level(Level::INFO);
        debug!(target: "twigo_core::catalog", "dropped again");
    });
    let written: Vec<_> = lines(&log)
        .into_iter()
        .map(|line| line["fields"]["message"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        written,
        ["the log level changed", "after", "the log level changed"]
    );
}

#[test]
fn the_first_line_of_a_run_holds_its_facts() {
    let directory = tempfile::tempdir().unwrap();
    let (dispatch, log) = open(directory.path(), DEFAULT_FILTER);
    let facts = Facts::detect("0.1.0", Some("caa6c91c"), Some("22625.2.8".to_owned()));
    with_default(&dispatch, || facts.log(DEFAULT_FILTER));
    let [line] = &lines(&log)[..] else {
        panic!("one line");
    };
    let fields = &line["fields"];
    assert_eq!(fields["version"], "0.1.0");
    assert_eq!(fields["commit"], "caa6c91c");
    assert_eq!(fields["os"], facts.os);
    assert_eq!(fields["os_version"], facts.os_version);
    assert_eq!(fields["arch"], std::env::consts::ARCH);
    assert_eq!(fields["engine"], facts.engine);
    assert_eq!(fields["engine_version"], "22625.2.8");
    assert_eq!(fields["filter"], DEFAULT_FILTER);
}

#[test]
fn a_new_launch_moves_the_previous_run_s_file_aside() {
    let directory = tempfile::tempdir().unwrap();
    let (dispatch, _first) = open(directory.path(), DEFAULT_FILTER);
    with_default(&dispatch, || info!(target: "twigo_core", "the first run"));
    let (dispatch, second) = open(directory.path(), DEFAULT_FILTER);
    with_default(&dispatch, || info!(target: "twigo_core", "the second run"));
    assert_eq!(lines(&second)[0]["fields"]["message"], "the second run");
    let moved = std::fs::read_to_string(directory.path().join("twigo.1.log")).unwrap();
    assert!(moved.contains("the first run"), "{moved}");
}
