//! The command bus against a kind cluster with kwok: each friction a plan
//! names, each action seen in its object afterwards, and the kubectl line of
//! each plan, run here, doing what the plan does.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test bus_live -- --ignored

mod actions;
mod apply;
mod bus;
mod shell;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::api::{DeleteParams, PostParams};
use kube::config::Kubeconfig;
use kube::{Api, Config};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{Execute, Gvr, IpcError, OperationEvent, Plan, PlanRequest, ResourceRef};

pub const WAIT: Duration = Duration::from_secs(60);

pub fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{nanos}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

#[test]
fn names_made_at_the_same_instant_differ() {
    let names: std::collections::HashSet<String> = (0..20_000).map(|_| unique()).collect();
    assert_eq!(names.len(), 20_000);
}

/// The test cluster: its context and an admin client.
pub struct Cluster {
    pub path: PathBuf,
    pub context: String,
    pub admin: kube::Client,
}

impl Cluster {
    pub async fn connect() -> Self {
        let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG")
            .into();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        assert!(
            context.starts_with("kind-") || context.starts_with("kwok-"),
            "refusing context {context:?}: only kind and kwok clusters"
        );
        let config = Config::from_custom_kubeconfig(kubeconfig, &Default::default())
            .await
            .unwrap();
        Cluster {
            path,
            context,
            admin: kube::Client::try_from(config).unwrap(),
        }
    }

    pub async fn namespace(&self, prefix: &str) -> String {
        let namespace = format!("core-bus-{prefix}-{}", unique());
        Api::<Namespace>::all(self.admin.clone())
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
            )
            .await
            .unwrap();
        namespace
    }

    pub async fn delete(&self, namespace: &str) {
        let deleted = Api::<Namespace>::all(self.admin.clone())
            .delete(namespace, &DeleteParams::default())
            .await;
        if let Err(kube::Error::Api(status)) = &deleted
            && status.code == 404
        {
            return;
        }
        deleted.unwrap();
    }

    pub async fn config_map(&self, namespace: &str, name: &str) -> String {
        Api::<ConfigMap>::namespaced(self.admin.clone(), namespace)
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap(),
            )
            .await
            .unwrap()
            .metadata
            .uid
            .unwrap()
    }

    /// The uid of the object `name` of `api`, none once it is gone.
    pub async fn uid<K>(api: &Api<K>, name: &str) -> Option<String>
    where
        K: kube::Resource + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
    {
        api.get_opt(name)
            .await
            .unwrap()
            .and_then(|object| object.meta().uid.clone())
    }
}

/// A core that reads only a copy of the test's kubeconfig, which a test may
/// rewrite, with a space for its context.
pub async fn core(dir: &Path, cluster: &Cluster) -> (Arc<Core>, PathBuf) {
    let kubeconfig = dir.join("config");
    std::fs::copy(&cluster.path, &kubeconfig).unwrap();
    (
        core_over(dir, &kubeconfig, &cluster.context).await,
        kubeconfig,
    )
}

pub async fn core_over(dir: &Path, kubeconfig: &Path, context: &str) -> Arc<Core> {
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    core.state.open_space(context);
    let (status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        let kubeconfig = kubeconfig.to_owned();
        async move {
            let _status = status;
            core.run(followed, Some(kubeconfig)).await;
        }
    });
    core.catalog.contexts().await;
    core
}

pub async fn eventually<F, Done>(what: &str, mut check: F)
where
    F: FnMut() -> Done,
    Done: std::future::Future<Output = bool>,
{
    let waited = tokio::time::timeout(WAIT, async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
    assert!(waited.await.is_ok(), "{what} within 60 s");
}

pub fn reference(
    group: &str,
    version: &str,
    resource: &str,
    namespace: Option<&str>,
    name: &str,
) -> ResourceRef {
    ResourceRef {
        gvr: Gvr {
            group: group.to_owned(),
            version: version.to_owned(),
            resource: resource.to_owned(),
        },
        namespaced: namespace.is_some(),
        namespace: namespace.map(str::to_owned),
        name: name.to_owned(),
    }
}

pub async fn plan(core: &Core, request: PlanRequest) -> Result<Plan, IpcError> {
    core.command_plan("main", request).await
}

pub fn target(resource: &str, namespace: Option<&str>, name: &str) -> ResourceRef {
    reference("", "v1", resource, namespace, name)
}

pub async fn plan_delete(
    core: &Core,
    cluster: &Cluster,
    target: ResourceRef,
) -> Result<Plan, IpcError> {
    let request = PlanRequest::Delete {
        space: cluster.context.clone(),
        targets: vec![target],
    };
    core.command_plan("main", request).await
}

/// Runs a plan and gathers its events until the last.
pub async fn run(
    core: &Core,
    plan: &Plan,
    typed: Option<&str>,
) -> Result<Vec<OperationEvent>, IpcError> {
    let (sender, mut events) = mpsc::unbounded_channel();
    core.command_execute(
        "main",
        Execute {
            plan: plan.id,
            typed: typed.map(str::to_owned),
        },
        move |event| sender.send(event).is_ok(),
    )
    .await?;
    let mut told = Vec::new();
    tokio::time::timeout(WAIT, async {
        while let Some(event) = events.recv().await {
            let last = !matches!(event, OperationEvent::Running { .. });
            told.push(event);
            if last {
                return;
            }
        }
    })
    .await
    .expect("the run ends within 60 s");
    Ok(told)
}

/// The plan's kubectl line, run by a shell over `kubeconfig` only.
pub fn kubectl(plan: &Plan, kubeconfig: &Path) -> String {
    let output = Command::new("sh")
        .arg("-c")
        .arg(&plan.kubectl)
        .env("KUBECONFIG", kubeconfig)
        .output()
        .expect("kubectl runs");
    assert!(
        output.status.success(),
        "{}: {}",
        plan.kubectl,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

pub fn audit(dir: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(dir.join("audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
