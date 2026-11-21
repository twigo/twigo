//! A panic before the log opens goes to stderr, in the log's own shape.

use std::process::Command;

use serde_json::Value;

const CHILD: &str = "TWIGO_HOOK_TEST_CHILD";

#[test]
fn a_panic_before_the_log_opens_is_a_json_line_on_stderr() {
    if std::env::var_os(CHILD).is_some() {
        twigo_log::install_hook("1.2.3");
        let _ = std::panic::catch_unwind(|| panic!("before the log"));
        return;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_panic_before_the_log_opens_is_a_json_line_on_stderr",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    let record = stderr
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|line| line["fields"]["message"] == "panic")
        .unwrap_or_else(|| panic!("a record in {stderr}"));
    assert_eq!(record["fields"]["payload"], "before the log");
    assert_eq!(record["fields"]["version"], "1.2.3");
}
