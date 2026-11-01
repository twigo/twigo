//! The churn generator: bumps the restart count of random pods of the `bench/bench` Deployment
//! (`bench/pods.sh`) through the status subresource at a steady rate, and logs every change.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::Pod;
use kube::api::{ListParams, Patch, PatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior};
use twigo_kube::client::Clients;

use crate::stats::Spread;

const NAMESPACE: &str = "bench";
const SELECTOR: &str = "app=bench";
const CONTAINER: &str = "app";
const IN_FLIGHT: usize = 64;
/// The API client has no read timeout, so a patch the server never answers would hold its pod.
const PATCH_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Options {
    pub kubeconfig: PathBuf,
    pub rate: f64,
    pub seconds: Option<f64>,
    pub log: PathBuf,
}

/// One line of the log: what changed, and when it was sent and answered, in Unix milliseconds.
#[derive(Serialize)]
struct Change<'a> {
    pod: &'a str,
    restarts: i32,
    sent: f64,
    answered: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// A patch's outcome, sent from its task to the loop that logs it.
struct Answer {
    index: usize,
    restarts: i32,
    sent: f64,
    answered: f64,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub pods: usize,
    pub rate: f64,
    pub seconds: f64,
    pub changes: usize,
    pub errors: usize,
    pub changes_per_second: f64,
    pub latency_ms: Option<Spread>,
}

pub fn allowed_context(context: &str) -> bool {
    context.starts_with("kind-") || context.starts_with("kwok-")
}

/// A JSON patch that sets the first container's restart count, once that container is `app`.
pub fn restart_patch(restarts: i32) -> json_patch::Patch {
    serde_json::from_value(json!([
        { "op": "test", "path": "/status/containerStatuses/0/name", "value": CONTAINER },
        { "op": "replace", "path": "/status/containerStatuses/0/restartCount", "value": restarts },
    ]))
    .expect("a valid JSON patch")
}

fn unix_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs_f64()
        * 1000.0
}

async fn pods(api: &Api<Pod>) -> Result<Vec<(Arc<str>, i32)>, kube::Error> {
    let mut pods = Vec::new();
    let mut params = ListParams::default().labels(SELECTOR).limit(500);
    loop {
        let page = api.list(&params).await?;
        for pod in page.items {
            let name = pod.metadata.name.unwrap_or_default();
            let restarts = pod
                .status
                .and_then(|status| status.container_statuses)
                .and_then(|statuses| statuses.into_iter().find(|s| s.name == CONTAINER))
                .map(|status| status.restart_count);
            if let Some(restarts) = restarts {
                pods.push((name.into(), restarts));
            }
        }
        match page.metadata.continue_ {
            Some(token) if !token.is_empty() => params = params.continue_token(&token),
            _ => return Ok(pods),
        }
    }
}

pub async fn run(options: Options) -> Result<Summary, String> {
    let kubeconfig = Kubeconfig::read_from(&options.kubeconfig).map_err(|e| e.to_string())?;
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    if !allowed_context(&context) {
        return Err(format!(
            "refusing context {context:?}: only kind and kwok clusters"
        ));
    }
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .map_err(|e| e.to_string())?;
    let client = Clients::new(config).map_err(|e| e.to_string())?.api;
    let api: Api<Pod> = Api::namespaced(client, NAMESPACE);

    let pods = pods(&api).await.map_err(|e| e.to_string())?;
    if pods.is_empty() {
        return Err(format!(
            "no running pods match {SELECTOR} in {NAMESPACE}: run bench/pods.sh first"
        ));
    }
    let mut log = BufWriter::new(File::create(&options.log).map_err(|e| e.to_string())?);
    let stop = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let patch = move |name: Arc<str>, restarts: i32| {
        let api = api.clone();
        async move {
            let patch = Patch::Json::<()>(restart_patch(restarts));
            api.patch_status(&name, &PatchParams::default(), &patch)
                .await
                .map(drop)
                .map_err(|error| error.to_string())
        }
    };
    let summary = churn(pods, options.rate, options.seconds, stop, patch, &mut log).await?;
    log.flush().map_err(|e| e.to_string())?;
    Ok(summary)
}

/// Patches random pods at `rate` a second, at most `IN_FLIGHT` at once and never two for one
/// pod, until `seconds` pass or `stop` resolves; then logs the answers of the patches in flight.
async fn churn<P, F>(
    pods: Vec<(Arc<str>, i32)>,
    rate: f64,
    seconds: Option<f64>,
    stop: impl Future<Output = ()>,
    patch: P,
    log: &mut impl Write,
) -> Result<Summary, String>
where
    P: Fn(Arc<str>, i32) -> F,
    F: Future<Output = Result<(), String>> + Send + 'static,
{
    let (names, mut restarts): (Vec<Arc<str>>, Vec<i32>) = pods.into_iter().unzip();
    let bound = IN_FLIGHT.min(names.len());
    let (done, mut answers) = mpsc::unbounded_channel::<Answer>();
    let mut in_flight = HashSet::new();
    let mut ticker = tokio::time::interval(Duration::from_secs_f64(1.0 / rate));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let deadline = async {
        match seconds {
            Some(seconds) => tokio::time::sleep(Duration::from_secs_f64(seconds)).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(stop, deadline);

    let start = Instant::now();
    let (mut changes, mut errors, mut latencies) = (0, 0, Vec::new());
    let mut record = |answer: Answer| {
        let Answer {
            index,
            restarts,
            sent,
            answered,
            error,
        } = answer;
        if error.is_some() {
            errors += 1;
        } else {
            changes += 1;
            latencies.push(answered - sent);
        }
        let line = Change {
            pod: &names[index],
            restarts,
            sent,
            answered,
            error,
        };
        serde_json::to_writer(&mut *log, &line).map_err(|e| e.to_string())?;
        log.write_all(b"\n").map_err(|e| e.to_string())?;
        Ok::<_, String>(index)
    };

    loop {
        tokio::select! {
            biased;
            () = &mut stop => break,
            () = &mut deadline => break,
            Some(answer) = answers.recv() => {
                in_flight.remove(&record(answer)?);
            }
            _ = ticker.tick(), if in_flight.len() < bound => {
                let index = loop {
                    let index = fastrand::usize(..names.len());
                    if in_flight.insert(index) {
                        break index;
                    }
                };
                restarts[index] += 1;
                let restarts = restarts[index];
                let call = patch(names[index].clone(), restarts);
                let done = done.clone();
                tokio::spawn(async move {
                    let sent = unix_ms();
                    let error = match tokio::time::timeout(PATCH_TIMEOUT, call).await {
                        Ok(result) => result.err(),
                        Err(_) => Some(format!("no answer within {} s", PATCH_TIMEOUT.as_secs())),
                    };
                    let _ = done.send(Answer {
                        index,
                        restarts,
                        sent,
                        answered: unix_ms(),
                        error,
                    });
                });
            }
        }
    }
    let seconds = start.elapsed().as_secs_f64();
    drop(done);
    while let Some(answer) = answers.recv().await {
        record(answer)?;
    }
    Ok(Summary {
        pods: names.len(),
        rate,
        seconds,
        changes,
        errors,
        changes_per_second: changes as f64 / seconds,
        latency_ms: Spread::of(&latencies),
    })
}

pub fn kubeconfig(explicit: Option<&Path>) -> Result<PathBuf, String> {
    explicit
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("TWIGO_TEST_KUBECONFIG").map(PathBuf::from))
        .ok_or_else(|| {
            "pass --kubeconfig or set TWIGO_TEST_KUBECONFIG to a kind or kwok cluster".to_owned()
        })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn only_kind_and_kwok_contexts() {
        assert!(allowed_context("kind-twigo-bench"));
        assert!(allowed_context("kwok-bench"));
        assert!(!allowed_context("prod-eu"));
        assert!(!allowed_context("my-kind-cluster"));
        assert!(!allowed_context(""));
    }

    #[test]
    fn the_patch_tests_the_container_and_sets_its_restarts() {
        let mut pod = json!({
            "status": { "containerStatuses": [{ "name": "app", "restartCount": 3 }] }
        });
        json_patch::patch(&mut pod, &restart_patch(4)).unwrap();
        assert_eq!(pod["status"]["containerStatuses"][0]["restartCount"], 4);

        let mut other = json!({
            "status": { "containerStatuses": [{ "name": "sidecar", "restartCount": 3 }] }
        });
        assert!(json_patch::patch(&mut other, &restart_patch(4)).is_err());
    }

    #[tokio::test]
    async fn run_refuses_a_prod_context_before_connecting() {
        let dir = std::env::temp_dir().join(format!("twigo-bench-refuses-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let kubeconfig = dir.join("kubeconfig");
        std::fs::write(
            &kubeconfig,
            "apiVersion: v1
kind: Config
current-context: prod-eu
clusters:
- name: prod-eu
  cluster:
    server: https://127.0.0.1:1
contexts:
- name: prod-eu
  context:
    cluster: prod-eu
    user: prod-eu
users:
- name: prod-eu
  user:
    token: secret
",
        )
        .unwrap();
        let log = dir.join("churn.jsonl");

        let result = run(Options {
            kubeconfig,
            rate: 100.0,
            seconds: Some(1.0),
            log: log.clone(),
        })
        .await;

        assert_eq!(
            result.err().as_deref(),
            Some(r#"refusing context "prod-eu": only kind and kwok clusters"#)
        );
        assert!(!log.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn names(count: usize) -> Vec<(Arc<str>, i32)> {
        (0..count).map(|i| (format!("pod-{i}").into(), 0)).collect()
    }

    fn lines(log: &[u8]) -> Vec<serde_json::Value> {
        log.split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    #[derive(Default)]
    struct Calls {
        open: HashSet<Arc<str>>,
        overlaps: usize,
        most_open: usize,
        made: usize,
    }

    #[tokio::test(start_paused = true)]
    async fn never_two_patches_in_flight_for_one_pod() {
        let calls = Arc::new(Mutex::new(Calls::default()));
        let patch = {
            let calls = calls.clone();
            move |name: Arc<str>, _| {
                let calls = calls.clone();
                async move {
                    {
                        let mut calls = calls.lock().unwrap();
                        calls.made += 1;
                        if !calls.open.insert(name.clone()) {
                            calls.overlaps += 1;
                        }
                        calls.most_open = calls.most_open.max(calls.open.len());
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    calls.lock().unwrap().open.remove(&name);
                    Ok(())
                }
            }
        };
        let mut log = Vec::new();

        let summary = churn(
            names(3),
            1000.0,
            Some(1.0),
            std::future::pending(),
            patch,
            &mut log,
        )
        .await
        .unwrap();

        let calls = calls.lock().unwrap();
        assert_eq!(calls.overlaps, 0);
        assert_eq!(calls.most_open, 3);
        assert!(calls.made > 100);
        assert_eq!((summary.changes, summary.errors), (calls.made, 0));
        assert_eq!(lines(&log).len(), calls.made);
    }

    #[tokio::test(start_paused = true)]
    async fn after_a_stall_the_rate_resumes_without_the_backlog() {
        let made = Arc::new(Mutex::new(0usize));
        let patch = {
            let made = made.clone();
            move |_, _| {
                let first = {
                    let mut made = made.lock().unwrap();
                    *made += 1;
                    *made == 1
                };
                async move {
                    if first {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    Ok(())
                }
            }
        };
        let mut log = Vec::new();

        churn(
            names(1),
            100.0,
            Some(2.0),
            std::future::pending(),
            patch,
            &mut log,
        )
        .await
        .unwrap();

        let made = *made.lock().unwrap();
        assert!((95..=110).contains(&made), "{made} patches");
    }

    #[tokio::test(start_paused = true)]
    async fn the_deadline_ends_a_run_whose_patches_go_unanswered() {
        let mut log = Vec::new();

        let summary = churn(
            names(100),
            100.0,
            Some(2.0),
            std::future::pending(),
            |_, _| std::future::pending(),
            &mut log,
        )
        .await
        .unwrap();

        assert_eq!(summary.seconds, 2.0);
        assert_eq!((summary.changes, summary.errors), (0, IN_FLIGHT));
        let lines = lines(&log);
        assert_eq!(lines.len(), IN_FLIGHT);
        assert!(
            lines
                .iter()
                .all(|line| line["error"] == "no answer within 10 s")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stop_ends_a_run_waiting_on_its_only_pod() {
        let mut log = Vec::new();

        let summary = churn(
            names(1),
            100.0,
            None,
            tokio::time::sleep(Duration::from_millis(500)),
            |_, _| std::future::pending(),
            &mut log,
        )
        .await
        .unwrap();

        assert_eq!(summary.seconds, 0.5);
        assert_eq!((summary.changes, summary.errors), (0, 1));
        assert_eq!(lines(&log)[0]["pod"], "pod-0");
    }

    #[tokio::test(start_paused = true)]
    async fn stop_logs_the_answers_of_the_patches_in_flight() {
        let made = Arc::new(Mutex::new(0));
        let patch = {
            let made = made.clone();
            move |_, _| {
                let made = made.clone();
                async move {
                    *made.lock().unwrap() += 1;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    Ok(())
                }
            }
        };
        let mut log = Vec::new();

        let summary = churn(
            names(1000),
            100.0,
            None,
            tokio::time::sleep(Duration::from_secs(1)),
            patch,
            &mut log,
        )
        .await
        .unwrap();

        let made = *made.lock().unwrap();
        assert!(made > 90);
        assert_eq!((summary.changes, summary.errors), (made, 0));
        assert_eq!(lines(&log).len(), made);
    }
}
