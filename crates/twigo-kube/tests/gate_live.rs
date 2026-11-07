//! The gate on a real API server: what it stops never gets there, by the
//! server's own count of objects.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use k8s_openapi::api::authorization::v1::SelfSubjectAccessReview;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod};
use kube::api::{DeleteParams, ListParams, PatchParams, PostParams, WatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use twigo_ipc::{BlockReason, ErrorKind, Mode};
use twigo_kube::client::{Actor, Clients, Gate, Options};
use twigo_kube::errors;
use twigo_policy::Policy;

struct Cluster {
    config: Config,
    admin: Client,
    namespace: String,
}

impl Cluster {
    async fn new(prefix: &str) -> Self {
        let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
        let kubeconfig = Kubeconfig::read_from(path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        assert!(
            context.starts_with("kind-") || context.starts_with("kwok-"),
            "refusing context {context:?}: these tests write, so they run only against kind and kwok clusters"
        );
        let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
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
        let namespaces: Api<Namespace> = Api::all(admin.clone());
        let object = serde_json::from_value(json!({"metadata": {"name": namespace}})).unwrap();
        namespaces
            .create(&PostParams::default(), &object)
            .await
            .unwrap();
        Self {
            config,
            admin,
            namespace,
        }
    }

    fn clients(&self, policy: &Arc<Policy>) -> Clients {
        let gate = policy.gate("c", Actor::Ui);
        Clients::new(&self.config, gate, Options::default()).unwrap()
    }

    fn maps(&self, client: &Client) -> Api<ConfigMap> {
        Api::namespaced(client.clone(), &self.namespace)
    }

    /// What the API server holds, asked of it through clients no mode limits.
    async fn names(&self) -> Vec<String> {
        self.maps(&self.admin)
            .list(&ListParams::default())
            .await
            .unwrap()
            .items
            .into_iter()
            .filter_map(|map| map.metadata.name)
            .filter(|name| name != "kube-root-ca.crt")
            .collect()
    }

    async fn delete(&self) {
        let namespaces: Api<Namespace> = Api::all(self.admin.clone());
        namespaces
            .delete(&self.namespace, &DeleteParams::default())
            .await
            .unwrap();
    }
}

fn map(name: &str) -> ConfigMap {
    serde_json::from_value(json!({"metadata": {"name": name}, "data": {"a": "1"}})).unwrap()
}

fn is_blocked(error: &kube::Error) -> bool {
    errors::request(error).kind == ErrorKind::Permissions
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_read_only_context_writes_nothing_to_the_api_server() {
    let cluster = Cluster::new("gate-read-only").await;
    let existing = map("existing");
    cluster
        .maps(&cluster.admin)
        .create(&PostParams::default(), &existing)
        .await
        .unwrap();

    let policy = Policy::open();
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    let clients = cluster.clients(&policy);
    let maps = cluster.maps(&clients.api);

    let create = maps.create(&PostParams::default(), &map("created")).await;
    assert!(is_blocked(&create.unwrap_err()));
    let replace = maps
        .patch(
            "existing",
            &PatchParams::apply("twigo-test"),
            &kube::api::Patch::Apply(map("existing")),
        )
        .await;
    assert!(is_blocked(&replace.unwrap_err()));
    let delete = maps.delete("existing", &DeleteParams::default()).await;
    assert!(is_blocked(&delete.unwrap_err()));
    let collection = maps
        .delete_collection(&DeleteParams::default(), &ListParams::default())
        .await;
    assert!(is_blocked(&collection.unwrap_err()));
    assert_eq!(cluster.names().await, ["existing"]);

    // A dry run goes all the way and leaves nothing.
    let dry_run = PostParams {
        dry_run: true,
        ..PostParams::default()
    };
    let previewed = maps.create(&dry_run, &map("previewed")).await.unwrap();
    assert_eq!(previewed.metadata.name.as_deref(), Some("previewed"));
    assert_eq!(cluster.names().await, ["existing"]);

    cluster.delete().await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn reads_work_in_every_mode() {
    let cluster = Cluster::new("gate-reads").await;
    cluster
        .maps(&cluster.admin)
        .create(&PostParams::default(), &map("seen"))
        .await
        .unwrap();
    for mode in [Mode::ReadWrite, Mode::Guarded, Mode::ReadOnly] {
        let policy = Policy::open();
        policy.set_mode("c", Some(mode)).unwrap();
        let clients = cluster.clients(&policy);
        let api = &clients.api;

        api.apiserver_version().await.unwrap();
        api.list_api_groups().await.unwrap();
        let maps = cluster.maps(api);
        maps.get("seen").await.unwrap();
        let listed = maps.list(&ListParams::default()).await.unwrap();
        let version = listed.metadata.resource_version.unwrap();
        maps.list_metadata(&ListParams::default()).await.unwrap();
        let params = WatchParams::default().timeout(1);
        drop(maps.watch(&params, &version).await.unwrap());
        let pods: Api<Pod> = Api::namespaced(api.clone(), &cluster.namespace);
        pods.list(&ListParams::default()).await.unwrap();

        let reviews: Api<SelfSubjectAccessReview> = Api::all(api.clone());
        let review = serde_json::from_value(json!({"spec": {
            "resourceAttributes": {"verb": "list", "resource": "pods"}
        }}))
        .unwrap();
        let answered = reviews
            .create(&PostParams::default(), &review)
            .await
            .unwrap();
        assert!(answered.status.unwrap().allowed, "{mode:?}");
    }
    cluster.delete().await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_unlock_lets_writes_through_until_it_relocks() {
    let cluster = Cluster::new("gate-unlock").await;
    let policy = Policy::open();
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    let clients = cluster.clients(&policy);
    let maps = cluster.maps(&clients.api);

    assert!(
        maps.create(&PostParams::default(), &map("first"))
            .await
            .is_err()
    );
    assert_eq!(cluster.names().await, Vec::<String>::new());

    policy.unlock("c").unwrap();
    maps.create(&PostParams::default(), &map("second"))
        .await
        .unwrap();
    assert_eq!(cluster.names().await, ["second"]);

    policy.relock("c");
    let third = maps.create(&PostParams::default(), &map("third")).await;
    assert!(is_blocked(&third.unwrap_err()));
    assert_eq!(cluster.names().await, ["second"]);

    cluster.delete().await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn another_actor_s_clients_reach_the_same_server_under_their_own_rules() {
    let cluster = Cluster::new("gate-actors").await;
    let policy = Policy::open();
    policy.set_mode("c", Some(Mode::Guarded)).unwrap();
    let clients = cluster.clients(&policy);
    let terminal = clients.actor(Actor::Terminal).unwrap();

    let maps = cluster.maps(&terminal.api);
    maps.list(&ListParams::default()).await.unwrap();
    let refused = maps
        .create(&PostParams::default(), &map("theirs"))
        .await
        .unwrap_err();
    let blocked = errors::request(&refused).blocked.unwrap();
    assert_eq!(blocked.reason, BlockReason::NoApproval);

    cluster
        .maps(&clients.api)
        .create(&PostParams::default(), &map("ours"))
        .await
        .unwrap();
    assert_eq!(cluster.names().await, ["ours"]);

    cluster.delete().await;
}

/// Why the gate does not take `dryRun=All` at its word: what kube-apiserver
/// does with it, through clients no mode limits.
#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_api_server_does_not_always_treat_dry_run_as_a_dry_run() {
    let cluster = Cluster::new("gate-dry-run").await;
    let namespace = cluster.namespace.clone();
    let send = |method: &str, path: String, body: &str| {
        http::Request::builder()
            .method(method)
            .uri(format!("/api/v1/namespaces/{namespace}/{path}"))
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(body.as_bytes().to_vec())
            .unwrap()
    };

    // A delete with a body reads its options from the body, not the query.
    cluster
        .maps(&cluster.admin)
        .create(&PostParams::default(), &map("doomed"))
        .await
        .unwrap();
    cluster
        .admin
        .request_text(send(
            "DELETE",
            "configmaps/doomed?dryRun=All".to_owned(),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(cluster.names().await, Vec::<String>::new());

    // A dry run of a token mints one.
    let accounts: Api<k8s_openapi::api::core::v1::ServiceAccount> =
        Api::namespaced(cluster.admin.clone(), &namespace);
    let account = serde_json::from_value(json!({"metadata": {"name": "minted"}})).unwrap();
    accounts
        .create(&PostParams::default(), &account)
        .await
        .unwrap();
    let minted = cluster
        .admin
        .request_text(send(
            "POST",
            "serviceaccounts/minted/token?dryRun=All".to_owned(),
            r#"{"apiVersion":"authentication.k8s.io/v1","kind":"TokenRequest","spec":{}}"#,
        ))
        .await
        .unwrap();
    let minted: serde_json::Value = serde_json::from_str(&minted).unwrap();
    assert!(
        minted["status"]["token"]
            .as_str()
            .is_some_and(|token| !token.is_empty()),
        "{minted}"
    );

    // A dry run of a Secret answers with its values.
    let secrets: Api<k8s_openapi::api::core::v1::Secret> =
        Api::namespaced(cluster.admin.clone(), &namespace);
    let secret =
        serde_json::from_value(json!({"metadata": {"name": "s"}, "data": {"k": "c2VjcmV0"}}))
            .unwrap();
    secrets
        .create(&PostParams::default(), &secret)
        .await
        .unwrap();
    let answer = cluster
        .admin
        .request_text(
            http::Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/api/v1/namespaces/{namespace}/secrets/s?dryRun=All"
                ))
                .header(http::header::CONTENT_TYPE, "application/merge-patch+json")
                .body(b"{}".to_vec())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(answer.contains("c2VjcmV0"), "{answer}");

    // Each of them, through the gate.
    let policy = Policy::open();
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    let clients = cluster.clients(&policy);
    cluster
        .maps(&cluster.admin)
        .create(&PostParams::default(), &map("kept"))
        .await
        .unwrap();
    let refused = clients
        .api
        .request_text(send(
            "DELETE",
            "configmaps/kept?dryRun=All".to_owned(),
            "{}",
        ))
        .await
        .unwrap_err();
    assert!(is_blocked(&refused));
    assert_eq!(cluster.names().await, ["kept"]);
    let refused = clients
        .api
        .request_text(send(
            "POST",
            "serviceaccounts/minted/token?dryRun=All".to_owned(),
            r#"{"apiVersion":"authentication.k8s.io/v1","kind":"TokenRequest","spec":{}}"#,
        ))
        .await
        .unwrap_err();
    assert!(is_blocked(&refused));
    let agent = clients.actor(Actor::Agent).unwrap();
    let refused = agent
        .api
        .request_text(
            http::Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/api/v1/namespaces/{}/secrets/s?dryRun=All",
                    cluster.namespace
                ))
                .header(http::header::CONTENT_TYPE, "application/merge-patch+json")
                .body(b"{}".to_vec())
                .unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        errors::request(&refused).blocked.unwrap().reason,
        BlockReason::NoApproval
    );

    cluster.delete().await;
}
