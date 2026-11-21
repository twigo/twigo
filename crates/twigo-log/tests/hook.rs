//! The hook is the process's, so each test file has one.

use std::path::Path;

use serde_json::Value;
use twigo_log::{Facts, Log};

#[test]
fn a_panic_of_a_spawned_task_is_recorded_before_the_hook_returns() {
    let directory = tempfile::tempdir().unwrap();
    twigo_log::install_hook("9.9.9");
    let log = Log::start(directory.path(), &Facts::detect("9.9.9", None, None));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("hook-test-worker")
        .build()
        .unwrap();
    let panicking = line!() + 3;
    let ended = runtime.block_on(async {
        tokio::spawn(async {
            panic!("an invalid value: 7");
        })
        .await
    });
    assert!(ended.unwrap_err().is_panic());

    let panics = panics(log.path());
    let [panic] = &panics[..] else {
        panic!("one record: {panics:?}");
    };
    let fields = &panic["fields"];
    assert_eq!(panic["level"], "ERROR");
    assert_eq!(fields["payload"], "an invalid value: 7");
    assert_eq!(fields["thread"], "hook-test-worker");
    assert_eq!(fields["version"], "9.9.9");
    let location = fields["location"].as_str().unwrap();
    assert!(
        location.ends_with(&format!("hook.rs:{panicking}:13")),
        "{location}"
    );
    assert!(
        fields["task"].as_str().is_some_and(|id| !id.is_empty()),
        "{fields}"
    );
    assert!(!fields["backtrace"].as_str().unwrap().is_empty());
}

fn panics(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a JSON line"))
        .filter(|line| line["fields"]["message"] == "panic")
        .collect()
}
