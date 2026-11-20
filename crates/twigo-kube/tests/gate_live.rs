//! The gate on a real API server: what it stops never gets there, by the
//! server's own count of objects.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use std::time::Duration;

use k8s_openapi::api::authorization::v1::SelfSubjectAccessReview;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod};
use k8s_openapi::api::flowcontrol::v1::FlowSchema;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding};
use kube::api::{DeleteParams, ListParams, PatchParams, PostParams, WatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use twigo_ipc::{BlockReason, ErrorKind, Mode, RequestClass};
use twigo_kube::client::{Actor, Clients, Gate, Options, Server};
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

/// How many of `user`'s requests the API server dispatched through the
/// FlowSchema named after them. The filter of API Priority and Fairness
/// runs after impersonation and before authorization, for every request
/// that is not long-running, the ones the aggregator proxies to another
/// server included
/// ([`DefaultBuildHandlerChain`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/server/config.go#L1036-L1076)),
/// while `apiserver_request_total` leaves those out: it counts at the
/// routes of kube-apiserver's own handlers, which a proxied request never
/// reaches (none for `metrics.k8s.io` on kind 1.37 after a `GET` of it,
/// 2026-11-19).
async fn dispatched(admin: &Client, user: &str) -> u64 {
    let request = http::Request::get("/metrics").body(Vec::new()).unwrap();
    let metrics = admin.request_text(request).await.unwrap();
    let schema = format!("flow_schema=\"{user}\"");
    metrics
        .lines()
        .filter(|line| {
            line.starts_with("apiserver_flowcontrol_dispatched_requests_total{")
                && line.contains(&schema)
        })
        .map(|line| line.rsplit(' ').next().unwrap().parse::<f64>().unwrap() as u64)
        .sum()
}

/// A dry run to a group whose APIService names a service is a write, so in
/// `read-only` it never reaches the API server. metrics-server's group takes
/// no writes, so its answer cannot tell a refusal by the gate from one by
/// the server: the test counts what the API server dispatched for a user of
/// its own, which may read APIServices and nothing more.
#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_dry_run_to_an_aggregated_group_never_reaches_the_server_in_read_only() {
    let cluster = Cluster::new("gate-aggregated").await;
    let user = cluster.namespace.clone();
    let named = |more: serde_json::Value| {
        let mut object = json!({ "metadata": { "name": user } });
        object
            .as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        object
    };
    let subject = json!({ "kind": "User", "name": user, "apiGroup": "rbac.authorization.k8s.io" });
    let roles: Api<ClusterRole> = Api::all(cluster.admin.clone());
    let role = named(json!({ "rules": [{
        "apiGroups": ["apiregistration.k8s.io"], "resources": ["apiservices"], "verbs": ["get"],
    }] }));
    roles
        .create(
            &PostParams::default(),
            &serde_json::from_value(role).unwrap(),
        )
        .await
        .unwrap();
    let bindings: Api<ClusterRoleBinding> = Api::all(cluster.admin.clone());
    let binding = named(json!({
        "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": user },
        "subjects": [subject],
    }));
    bindings
        .create(
            &PostParams::default(),
            &serde_json::from_value(binding).unwrap(),
        )
        .await
        .unwrap();
    let schemas: Api<FlowSchema> = Api::all(cluster.admin.clone());
    let schema = named(json!({ "spec": {
        "matchingPrecedence": 450,
        "priorityLevelConfiguration": { "name": "global-default" },
        "rules": [{
            "subjects": [{ "kind": "User", "user": { "name": user } }],
            "resourceRules": [{
                "verbs": ["*"], "apiGroups": ["*"], "resources": ["*"],
                "namespaces": ["*"], "clusterScope": true,
            }],
        }],
    } }));
    schemas
        .create(
            &PostParams::default(),
            &serde_json::from_value(schema).unwrap(),
        )
        .await
        .unwrap();

    let policy = Policy::open();
    policy.set_mode("c", Some(Mode::ReadWrite)).unwrap();
    let mut config = cluster.config.clone();
    config.auth_info.impersonate = Some(user.clone());
    let clients = Clients::new(&config, policy.gate("c", Actor::Ui), Options::default()).unwrap();
    let waited = tokio::time::timeout(Duration::from_secs(30), async {
        while dispatched(&cluster.admin, &user).await == 0 {
            let read = http::Request::get("/api/v1/namespaces/default/configmaps")
                .body(Vec::new())
                .unwrap();
            let _ = clients.api.request_text(read).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
    waited
        .await
        .expect("the API server takes up the FlowSchema within 30 s");
    assert_eq!(
        clients.server("metrics.k8s.io", "v1beta1").await,
        Some(Server::Aggregated)
    );

    let dry_run = || {
        http::Request::patch(format!(
            "/apis/metrics.k8s.io/v1beta1/namespaces/{}/pods/p?dryRun=All",
            cluster.namespace
        ))
        .header(http::header::CONTENT_TYPE, "application/merge-patch+json")
        .body(b"{}".to_vec())
        .unwrap()
    };
    let before = dispatched(&cluster.admin, &user).await;
    let answered = clients.api.request_text(dry_run()).await.unwrap_err();
    assert!(errors::gate(&answered).is_none(), "{answered}");
    assert_eq!(
        dispatched(&cluster.admin, &user).await,
        before + 1,
        "in read-write it reaches the server, which answers it: {answered}"
    );

    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    let refused = clients.api.request_text(dry_run()).await.unwrap_err();
    let blocked = errors::gate(&refused).expect("the gate refused it");
    assert_eq!(blocked.class, RequestClass::Write);
    assert_eq!(blocked.reason, BlockReason::Mode);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(dispatched(&cluster.admin, &user).await, before + 1);

    schemas
        .delete(&user, &DeleteParams::default())
        .await
        .unwrap();
    bindings
        .delete(&user, &DeleteParams::default())
        .await
        .unwrap();
    roles.delete(&user, &DeleteParams::default()).await.unwrap();
    cluster.delete().await;
}
