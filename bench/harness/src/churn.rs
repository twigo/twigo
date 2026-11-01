//! The churn generator: bumps the restart count of random pods of the `bench/bench` Deployment
//! (`bench/pods.sh`) through the status subresource at a steady rate, and logs every change.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::Pod;
use kube::api::{ListParams, Patch, PatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{Semaphore, mpsc};
use tokio::time::MissedTickBehavior;
use twigo_kube::client::Clients;

use crate::stats::Spread;

const NAMESPACE: &str = "bench";
const SELECTOR: &str = "app=bench";
const CONTAINER: &str = "app";
const IN_FLIGHT: usize = 64;

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

async fn pods(api: &Api<Pod>) -> Result<Vec<(String, i32)>, kube::Error> {
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
                pods.push((name, restarts));
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

    let mut pods = pods(&api).await.map_err(|e| e.to_string())?;
    if pods.is_empty() {
        return Err(format!(
            "no running pods match {SELECTOR} in {NAMESPACE}: run bench/pods.sh first"
        ));
    }
    let names: Arc<[Arc<str>]> = pods.iter().map(|(name, _)| name.as_str().into()).collect();
    let mut log = BufWriter::new(File::create(&options.log).map_err(|e| e.to_string())?);

    let (done, mut answers) = mpsc::unbounded_channel::<Answer>();
    let permits = Arc::new(Semaphore::new(IN_FLIGHT));
    let mut in_flight = HashSet::new();
    let mut ticker = tokio::time::interval(Duration::from_secs_f64(1.0 / options.rate));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Burst);
    let deadline = options.seconds.map(Duration::from_secs_f64);
    let stop = tokio::signal::ctrl_c();
    tokio::pin!(stop);

    let start = Instant::now();
    let (mut changes, mut errors, mut latencies) = (0, 0, Vec::new());
    let mut record = |log: &mut BufWriter<File>, answer: Answer| {
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
            _ = &mut stop => break,
            Some(answer) = answers.recv() => {
                in_flight.remove(&record(&mut log, answer)?);
            }
            _ = ticker.tick() => {
                if deadline.is_some_and(|deadline| start.elapsed() >= deadline) {
                    break;
                }
                let permit = permits.clone().acquire_owned().await.expect("an open semaphore");
                let index = loop {
                    let index = fastrand::usize(..pods.len());
                    if in_flight.insert(index) {
                        break index;
                    }
                };
                pods[index].1 += 1;
                let restarts = pods[index].1;
                let (api, done, name) = (api.clone(), done.clone(), names[index].clone());
                tokio::spawn(async move {
                    let sent = unix_ms();
                    let patch = Patch::Json::<()>(restart_patch(restarts));
                    let result = api.patch_status(&name, &PatchParams::default(), &patch).await;
                    let error = result.err().map(|error| error.to_string());
                    let _ = done.send(Answer {
                        index,
                        restarts,
                        sent,
                        answered: unix_ms(),
                        error,
                    });
                    drop(permit);
                });
            }
        }
    }
    let seconds = start.elapsed().as_secs_f64();
    drop(done);
    while let Some(answer) = answers.recv().await {
        record(&mut log, answer)?;
    }
    log.flush().map_err(|e| e.to_string())?;
    Ok(Summary {
        pods: pods.len(),
        rate: options.rate,
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
}
