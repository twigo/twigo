use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use twigo_log::{Facts, Log};

const CHILD: &str = "TWIGO_LOG_TEST_DIRECTORY";

fn start(directory: &Path) -> Log {
    Log::start(directory, &Facts::detect("1.2.3", None, None))
}

fn rerun(test: &str, directory: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture"])
        .env(CHILD, directory);
    command
}

#[test]
fn a_failing_log_never_panics_on_a_broken_stderr() {
    const TEST: &str = "a_failing_log_never_panics_on_a_broken_stderr";
    if let Some(directory) = std::env::var_os(CHILD).map(PathBuf::from) {
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
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("1 passed"), "{stdout}");
}
