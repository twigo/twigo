//! Exec credentials against a kind cluster: the context's user runs a
//! plugin that prints the token of a ServiceAccount from a file and counts
//! its runs, and each request asks the API server who it is.

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use k8s_openapi::api::authentication::v1::{SelfSubjectReview, TokenRequest};
use k8s_openapi::api::core::v1::{Namespace, ServiceAccount};
use kube::api::{DeleteParams, PostParams};
use kube::config::{
    AuthInfo, ExecConfig, ExecInteractiveMode, KubeConfigOptions, Kubeconfig, NamedAuthInfo,
};
use kube::{Api, Client, Config};
use serde_json::json;
use tempfile::TempDir;
use tokio::sync::watch;
use twigo_env::ShellEnv;
use twigo_kube::client::{Clients, Gate, Options};
use twigo_kube::credentials::{Exec, Provider, Registry, Source, Timeouts};

struct Live {
    admin: Client,
    kubeconfig: Kubeconfig,
    namespace: String,
    dir: TempDir,
}

impl Live {
    async fn start(prefix: &str) -> Self {
        let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
        let kubeconfig = Kubeconfig::read_from(path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        assert!(
            context.starts_with("kind-") || context.starts_with("kwok-"),
            "refusing context {context:?}: these tests create ServiceAccounts, so they run only against kind and kwok clusters"
        );
        let config =
            Config::from_custom_kubeconfig(kubeconfig.clone(), &KubeConfigOptions::default())
                .await
                .unwrap();
        let admin = Clients::new(&config, Gate::unrestricted(), Options::default())
            .unwrap()
            .api;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let namespace = format!("{prefix}-{nanos}");
        let created: Namespace =
            serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap();
        Api::<Namespace>::all(admin.clone())
            .create(&PostParams::default(), &created)
            .await
            .unwrap();
        let live = Self {
            admin,
            kubeconfig,
            namespace,
            dir: tempfile::tempdir().unwrap(),
        };
        std::fs::write(
            live.dir.path().join("plugin"),
            format!(
                "#!/bin/sh\necho run >> '{runs}'\n[ -n \"$PLUGIN_SLEEPS\" ] && exec sleep 1000\nprintf '{{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{{\"token\":\"%s\"}}}}' \"$(cat '{token}')\"\n",
                runs = live.path("runs").display(),
                token = live.path("token").display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(live.path("plugin"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        live
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn runs(&self) -> usize {
        std::fs::read_to_string(self.path("runs"))
            .map(|runs| runs.lines().count())
            .unwrap_or(0)
    }

    async fn service_account(&self, name: &str) -> String {
        let accounts = Api::<ServiceAccount>::namespaced(self.admin.clone(), &self.namespace);
        let account: ServiceAccount =
            serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
        accounts
            .create(&PostParams::default(), &account)
            .await
            .unwrap();
        let request: TokenRequest =
            serde_json::from_value(json!({ "spec": { "audiences": [] } })).unwrap();
        accounts
            .create_token_request(name, &PostParams::default(), &request)
            .await
            .unwrap()
            .status
            .unwrap()
            .token
            .unwrap()
    }

    /// The plugin prints this token from now on.
    fn prints(&self, token: &str) {
        std::fs::write(self.path("token"), token).unwrap();
    }

    /// Clients whose user runs the plugin, with `env` in its entry, and the
    /// plugin's source.
    async fn clients(&self, env: &[(&str, &str)], timeouts: Timeouts) -> (Clients, Arc<Source>) {
        let mut kubeconfig = self.kubeconfig.clone();
        let user = AuthInfo {
            exec: Some(ExecConfig {
                api_version: Some("client.authentication.k8s.io/v1".to_owned()),
                command: Some(self.path("plugin").display().to_string()),
                interactive_mode: Some(ExecInteractiveMode::Never),
                env: Some(
                    env.iter()
                        .map(|(name, value)| {
                            [
                                ("name".to_owned(), (*name).to_owned()),
                                ("value".to_owned(), (*value).to_owned()),
                            ]
                            .into_iter()
                            .collect()
                        })
                        .collect(),
                ),
                ..ExecConfig::default()
            }),
            ..AuthInfo::default()
        };
        kubeconfig.auth_infos = vec![NamedAuthInfo {
            name: "plugin".to_owned(),
            auth_info: Some(user.clone()),
            other: Default::default(),
        }];
        let context = kubeconfig.current_context.clone().unwrap();
        for named in &mut kubeconfig.contexts {
            if named.name == context
                && let Some(context) = &mut named.context
            {
                context.user = Some("plugin".to_owned());
            }
        }
        let cluster = kubeconfig.clusters[0].cluster.clone().unwrap();
        let exec = Exec::of("plugin", &user, &cluster).unwrap().unwrap();
        let shell: ShellEnv = std::env::vars_os()
            .collect::<Vec<(OsString, OsString)>>()
            .into_iter()
            .collect();
        let registry = Registry::new(
            watch::channel(Some(Arc::new(shell))).1,
            watch::channel(true).1,
            timeouts,
        );
        let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
            .await
            .unwrap();
        let source = registry.source(exec);
        let clients = Clients::new(
            &config,
            Gate::unrestricted(),
            Options {
                provider: Some(Provider::Exec(Arc::clone(&source))),
                ..Options::default()
            },
        )
        .unwrap();
        (clients, source)
    }

    async fn stop(self) {
        Api::<Namespace>::all(self.admin.clone())
            .delete(&self.namespace, &DeleteParams::default())
            .await
            .unwrap();
    }
}

/// Who the API server takes the client for.
async fn whoami(client: &Client) -> Result<String, kube::Error> {
    let review: SelfSubjectReview = serde_json::from_value(json!({})).unwrap();
    let answer = Api::<SelfSubjectReview>::all(client.clone())
        .create(&PostParams::default(), &review)
        .await?;
    Ok(answer.status.unwrap().user_info.unwrap().username.unwrap())
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn ten_concurrent_first_requests_run_the_plugin_once() {
    let live = Live::start("exec-once").await;
    let token = live.service_account("first").await;
    live.prints(&token);
    let (clients, _source) = live.clients(&[], Timeouts::default()).await;
    let answers = join_all((0..10).map(|_| whoami(&clients.api))).await;
    let expected = format!("system:serviceaccount:{}:first", live.namespace);
    for answer in answers {
        assert_eq!(answer.unwrap(), expected);
    }
    assert_eq!(live.runs(), 1);
    live.stop().await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_revoked_token_gets_one_401_one_new_run_and_success() {
    let live = Live::start("exec-revoked").await;
    let revoked = live.service_account("revoked").await;
    live.prints(&revoked);
    let (clients, _source) = live.clients(&[], Timeouts::default()).await;
    whoami(&clients.api).await.unwrap();
    assert_eq!(live.runs(), 1);

    Api::<ServiceAccount>::namespaced(live.admin.clone(), &live.namespace)
        .delete("revoked", &DeleteParams::default())
        .await
        .unwrap();
    let mut direct = Config::new(clients_url(&live));
    direct.root_cert = live_root(&live).await;
    direct.auth_info.token = Some(revoked.clone().into());
    let direct = Clients::new(&direct, Gate::unrestricted(), Options::default())
        .unwrap()
        .api;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match whoami(&direct).await {
            Err(kube::Error::Api(status)) if status.code == 401 => break,
            _ if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(500)).await,
            other => panic!("the revoked token still works: {other:?}"),
        }
    }

    let fresh = live.service_account("fresh").await;
    live.prints(&fresh);
    assert_eq!(
        whoami(&clients.api).await.unwrap(),
        format!("system:serviceaccount:{}:fresh", live.namespace)
    );
    assert_eq!(live.runs(), 2, "one new run after the 401");
    live.stop().await;
}

fn clients_url(live: &Live) -> http::Uri {
    let server = live.kubeconfig.clusters[0]
        .cluster
        .as_ref()
        .unwrap()
        .server
        .clone()
        .unwrap();
    server.parse().unwrap()
}

async fn live_root(live: &Live) -> Option<Vec<Vec<u8>>> {
    Config::from_custom_kubeconfig(live.kubeconfig.clone(), &KubeConfigOptions::default())
        .await
        .unwrap()
        .root_cert
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_plugin_past_its_timeout_ends_in_timeout_and_a_cancel_ends_it_sooner() {
    let live = Live::start("exec-timeout").await;
    let timeouts = Timeouts {
        unattended: Duration::from_secs(3),
        sign_in: Duration::from_secs(3),
    };
    let (clients, _source) = live.clients(&[("PLUGIN_SLEEPS", "1")], timeouts).await;
    let started = Instant::now();
    let error = whoami(&clients.api).await.unwrap_err();
    let waited = started.elapsed();
    assert!(
        error.to_string().contains("did not answer in 3 s"),
        "{error}"
    );
    assert!(
        waited >= Duration::from_secs(3) && waited < Duration::from_secs(10),
        "{waited:?}"
    );

    let (clients, source) = live.clients(&[("PLUGIN_SLEEPS", "2")], timeouts).await;
    let request = tokio::spawn({
        let api = clients.api.clone();
        async move { whoami(&api).await }
    });
    while live.runs() < 2 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let started = Instant::now();
    source.cancel();
    let error = request.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("was cancelled"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(2));
    live.stop().await;
}
