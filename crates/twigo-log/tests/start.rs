//! `Log::start` sets the process's one subscriber and `log` logger.

use serde_json::Value;
use twigo_log::{Facts, Level, Log};

#[test]
fn a_started_log_takes_each_event_and_each_log_record_once_and_follows_its_level() {
    let directory = tempfile::tempdir().unwrap();
    let log = Log::start(directory.path(), &Facts::detect("1.2.3", None, None));

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
