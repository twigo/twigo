//! The hub against a kind cluster, on every supported release: the list
//! path, a forced `410 Gone`, a ServiceAccount that may not list
//! cluster-wide, and an Object upstream through an edit.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::AsyncBufReadExt;
use k8s_openapi::api::authentication::v1::TokenRequest;
use k8s_openapi::api::core::v1::{Namespace, Pod, ServiceAccount};
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use kube::api::{DeleteParams, Patch, PatchParams, PostParams};
use kube::config::{AuthInfo, KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde_json::json;
use twigo_ipc::{Part, PartState, Parts};
use twigo_kube::client::{Clients, Gate, Options};

use super::*;
use crate::decode::{Decode, Event};
use crate::request::{self, Collection, Format, WatchFrom};
use crate::upstream::{self, Upstream};

const POD_COLUMNS: [&str; 9] = [
    "Name",
    "Ready",
    "Status",
    "Restarts",
    "Age",
    "IP",
    "Node",
    "Nominated Node",
    "Readiness Gates",
];

pub(crate) struct Live {
    pub(crate) config: Config,
    pub(crate) context: String,
    pub(crate) admin: kube::Client,
}

pub(crate) async fn live() -> Live {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: these tests create namespaces and RBAC, so they run only against kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let admin = Clients::new(&config, Gate::unrestricted(), Options::default())
        .unwrap()
        .api;
    Live {
        config,
        context,
        admin,
    }
}

impl Live {
    /// Changes `pod` until the server answers a watch of `path` from
    /// version 1 with 410. The watch cache keeps every event since it
    /// listed, near the start of a young cluster, until its buffer is full
    /// while its oldest event is older than 75 s (`watch_cache_history.go`
    /// of Kubernetes v1.37.0, `resizeCacheLocked` and `GetIntervalLocked`).
    async fn expire_version_1(&self, namespace: &str, pod: &str, path: &str) {
        let pods = Api::<Pod>::namespaced(self.admin.clone(), namespace);
        let expired = async {
            for round in 0u32.. {
                let watch =
                    request::watch(&Collection::table(path), WatchFrom::ResourceVersion("1"), 5);
                let mut lines = Box::pin(self.admin.request_stream(watch).await.unwrap());
                let mut first = Vec::new();
                lines.read_until(b'\n', &mut first).await.unwrap();
                if let Event::Error(status) = TableDecoder::new("pods")
                    .decode_event(&first, jiff::Timestamp::now())
                    .unwrap()
                {
                    assert_eq!(status.code, 410);
                    return;
                }
                drop(lines);
                for change in 0..100 {
                    let patch = json!({ "metadata": { "labels": { "churn": format!("{round}-{change}") } } });
                    pods.patch(pod, &PatchParams::default(), &Patch::Merge(&patch))
                        .await
                        .unwrap();
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(180), expired)
            .await
            .expect("the watch cache lets version 1 go within three minutes");
    }

    /// The hub over clients of `config`, the admin's unless given.
    pub(crate) fn hub(&self, config: Option<&Config>) -> (Hub, Arc<Clients>) {
        let clients = Arc::new(
            Clients::new(
                config.unwrap_or(&self.config),
                Gate::unrestricted(),
                Options::default(),
            )
            .unwrap(),
        );
        let connect: Connect = {
            let clients = Arc::clone(&clients);
            Arc::new(move |_context| {
                let clients = Arc::clone(&clients);
                Box::pin(async move { Ok(clients) })
            })
        };
        (Hub::new(connect), clients)
    }

    /// The config of `live`'s cluster over the token of a new service account.
    async fn as_account(&self, home: &str, name: &str) -> Config {
        let accounts = Api::<ServiceAccount>::namespaced(self.admin.clone(), home);
        let account: ServiceAccount =
            serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
        accounts
            .create(&PostParams::default(), &account)
            .await
            .unwrap();
        let request: TokenRequest =
            serde_json::from_value(json!({ "spec": { "audiences": [] } })).unwrap();
        let token = accounts
            .create_token_request(name, &PostParams::default(), &request)
            .await
            .unwrap()
            .status
            .unwrap()
            .token
            .expect("a token");
        let mut config = self.config.clone();
        config.auth_info = AuthInfo {
            token: Some(token.into()),
            ..AuthInfo::default()
        };
        config
    }

    async fn allow_pods_in(&self, namespace: &str, home: &str, account: &str) {
        let role: Role = serde_json::from_value(json!({
            "metadata": { "name": "pods" },
            "rules": [{ "apiGroups": [""], "resources": ["pods"], "verbs": ["list", "watch"] }]
        }))
        .unwrap();
        Api::<Role>::namespaced(self.admin.clone(), namespace)
            .create(&PostParams::default(), &role)
            .await
            .unwrap();
        let binding: RoleBinding = serde_json::from_value(json!({
            "metadata": { "name": format!("{account}-pods") },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "pods" },
            "subjects": [{ "kind": "ServiceAccount", "name": account, "namespace": home }]
        }))
        .unwrap();
        Api::<RoleBinding>::namespaced(self.admin.clone(), namespace)
            .create(&PostParams::default(), &binding)
            .await
            .unwrap();
    }

    async fn allow_everywhere(
        &self,
        name: &str,
        resource: &str,
        verbs: &[&str],
        home: &str,
        account: &str,
    ) {
        let role: ClusterRole = serde_json::from_value(json!({
            "metadata": { "name": name },
            "rules": [{ "apiGroups": [""], "resources": [resource], "verbs": verbs }]
        }))
        .unwrap();
        Api::<ClusterRole>::all(self.admin.clone())
            .create(&PostParams::default(), &role)
            .await
            .unwrap();
        let binding: ClusterRoleBinding = serde_json::from_value(json!({
            "metadata": { "name": name },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": name },
            "subjects": [{ "kind": "ServiceAccount", "name": account, "namespace": home }]
        }))
        .unwrap();
        Api::<ClusterRoleBinding>::all(self.admin.clone())
            .create(&PostParams::default(), &binding)
            .await
            .unwrap();
    }

    async fn revoke_everywhere(&self, name: &str) {
        Api::<ClusterRoleBinding>::all(self.admin.clone())
            .delete(name, &DeleteParams::default())
            .await
            .unwrap();
        Api::<ClusterRole>::all(self.admin.clone())
            .delete(name, &DeleteParams::default())
            .await
            .unwrap();
    }

    async fn minor(&self) -> u32 {
        let info = self.admin.apiserver_version().await.unwrap();
        info.minor.trim_end_matches('+').parse().unwrap()
    }

    async fn namespace(&self, prefix: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let name = format!("{prefix}-{nanos}");
        let namespace: Namespace =
            serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
        Api::<Namespace>::all(self.admin.clone())
            .create(&PostParams::default(), &namespace)
            .await
            .unwrap();
        name
    }

    async fn delete_namespace(&self, name: &str) {
        Api::<Namespace>::all(self.admin.clone())
            .delete(name, &DeleteParams::default())
            .await
            .unwrap();
    }

    async fn pod(&self, namespace: &str, name: &str) {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": {
                "nodeName": "kwok-node-0",
                "containers": [{ "name": "app", "image": "fake" }]
            }
        }))
        .unwrap();
        Api::<Pod>::namespaced(self.admin.clone(), namespace)
            .create(&PostParams::default(), &pod)
            .await
            .unwrap();
    }

    fn query(&self, namespaces: &[&str]) -> Query {
        Query {
            context: self.context.clone(),
            resource: Resource {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
                namespaced: true,
            },
            format: RowFormat::Table,
            namespaces: namespaces.iter().map(|&name| name.to_owned()).collect(),
            selectors: Selectors::default(),
        }
    }
}

async fn until<T: Item>(
    subscription: &mut Subscription<T>,
    wanted: impl Fn(&Subscription<T>) -> bool,
) {
    let reached = async {
        while !wanted(subscription) {
            subscription.changed().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(60), reached)
        .await
        .unwrap_or_else(|_| {
            panic!(
                "not within a minute; the state is {:?}",
                subscription.state()
            )
        });
}

fn ready<T: Item>(subscription: &Subscription<T>) -> bool {
    subscription.state() == ViewState::Ready
}

fn names(subscription: &Subscription<Row>) -> Vec<String> {
    let mut names: Vec<String> = subscription
        .items()
        .iter()
        .map(|row| row.meta.name.to_string())
        .collect();
    names.sort();
    names
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn lists_stream_on_1_37_and_come_in_pages_before() {
    let live = live().await;
    let namespace = live.namespace("hub-list").await;
    for name in ["p1", "p2", "p3"] {
        live.pod(&namespace, name).await;
    }
    let (hub, clients) = live.hub(None);
    let mut pods = hub.rows(live.query(&[&namespace])).await.unwrap();
    until(&mut pods, ready).await;
    assert_eq!(names(&pods), ["p1", "p2", "p3"]);
    let columns: Vec<String> = pods
        .columns()
        .unwrap()
        .iter()
        .map(|column| column.name.to_string())
        .collect();
    assert_eq!(columns, POD_COLUMNS);
    let streams = hub.inner.cluster(&live.context).streams(&clients, "", "v1");
    assert_eq!(streams, live.minor().await >= 37);

    live.pod(&namespace, "p4").await;
    until(&mut pods, |pods| names(pods).len() == 4).await;
    live.delete_namespace(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_watch_resumed_from_a_compacted_version_relists() {
    let live = live().await;
    let namespace = live.namespace("hub-gone").await;
    live.pod(&namespace, "p1").await;
    live.pod(&namespace, "p2").await;
    let (hub, _clients) = live.hub(None);
    let key = Key {
        context: live.context.clone(),
        resource: live.query(&[]).resource,
        format: Format::Table,
        scope: Scope::Namespace(namespace.clone()),
        selectors: Selectors::default(),
    };
    let env = || Env {
        connect: Arc::clone(&hub.inner.connect),
        clock: Arc::clone(&hub.inner.clock),
        cluster: hub.inner.cluster(&live.context),
        waiting: Arc::new(|_| {}),
    };
    let upstream = Arc::new(Upstream::<Row>::new());
    let mut state = upstream.state();
    let first = tokio::spawn(upstream::run(
        env(),
        key.spec(),
        TableDecoder::new(&key.resource.name()),
        Arc::clone(&upstream),
    ));
    state
        .wait_for(|state| *state == ViewState::Ready)
        .await
        .unwrap();
    first.abort();
    let p1 = |upstream: &Upstream<Row>| {
        let found = upstream.store.items(|row| &*row.meta.name == "p1");
        Arc::clone(&found[0])
    };
    let listed = p1(&upstream);
    let pods = Api::<Pod>::namespaced(live.admin.clone(), &namespace);
    pods.delete("p2", &DeleteParams::default().grace_period(0))
        .await
        .unwrap();
    let gone = async {
        while pods.get_opt("p2").await.unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(60), gone)
        .await
        .expect("kwok lets the pod go within a minute");

    // What makes it a forced 410: the server answers a watch from "1" so.
    live.expire_version_1(&namespace, "p1", &key.spec().path)
        .await;

    let resumed = tokio::spawn(upstream::resume(
        env(),
        key.spec(),
        TableDecoder::new(&key.resource.name()),
        Arc::clone(&upstream),
        "1",
    ));
    // The watch from "1" is accepted, then gets 410 in its body.
    let mut version = upstream.store.version();
    let relisted = async {
        while upstream.store.len() != 1 {
            version.changed().await.unwrap();
        }
    };
    tokio::time::timeout(Duration::from_secs(60), relisted)
        .await
        .expect("p2 dropped within a minute");
    assert!(
        !Arc::ptr_eq(&listed, &p1(&upstream)),
        "a relist, not a watch, dropped it"
    );
    assert_eq!(*state.borrow(), ViewState::Ready);
    resumed.abort();
    live.delete_namespace(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_service_account_without_a_cluster_wide_list_keeps_an_upstream_per_namespace() {
    let live = live().await;
    let mut namespaces = Vec::new();
    for _ in 0..5 {
        namespaces.push(live.namespace("hub-sa").await);
    }
    let home = &namespaces[0];
    for namespace in &namespaces {
        live.allow_pods_in(namespace, home, "viewer").await;
        live.pod(namespace, "p").await;
    }
    let config = live.as_account(home, "viewer").await;

    let (hub, _clients) = live.hub(Some(&config));
    let five: Vec<&str> = namespaces.iter().map(String::as_str).collect();
    let mut pods = hub.rows(live.query(&five)).await.unwrap();
    until(&mut pods, ready).await;
    let mut scopes: Vec<Scope> = namespaces
        .iter()
        .map(|namespace| Scope::Namespace(namespace.clone()))
        .collect();
    scopes.sort_by_key(|scope| format!("{scope:?}"));
    assert_eq!(hub.scopes(), scopes, "one upstream per namespace");
    assert_eq!(pods.items().len(), 5);

    let verb = if live.minor().await >= 37 {
        "watch"
    } else {
        "list"
    };
    let forbidden = ViewState::Forbidden {
        verb: verb.to_owned(),
        resource: "pods".to_owned(),
    };

    let refused = live.namespace("hub-sa").await;
    live.pod(&refused, "p").await;
    let mut six = five.clone();
    six.push(&refused);
    let mut partly = hub.rows(live.query(&six)).await.unwrap();
    let named = Parts {
        count: 6,
        omitted: 0,
        unready: vec![PartState {
            part: Part::Namespace {
                name: refused.clone(),
            },
            state: forbidden.clone(),
            shown: false,
        }],
    };
    until(&mut partly, |partly| {
        let shown = partly.drain_shown();
        shown.status == ViewState::Ready && shown.parts == named
    })
    .await;
    assert_eq!(partly.items().len(), 5);
    drop(partly);
    live.delete_namespace(&refused).await;

    let mut all = hub.rows(live.query(&[])).await.unwrap();
    until(&mut all, |all| all.state() == forbidden).await;

    // One that may list pods everywhere shares one cluster-wide upstream.
    let everywhere = format!("{home}-pods");
    live.allow_everywhere(&everywhere, "pods", &["list", "watch"], home, "lister")
        .await;
    let config = live.as_account(home, "lister").await;
    let (hub, clients) = live.hub(Some(&config));
    // The authorizer learns of the binding a moment later.
    let allowed = async {
        let all = Api::<Pod>::all(clients.api.clone());
        while all
            .list(&kube::api::ListParams::default().limit(1))
            .await
            .is_err()
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(30), allowed)
        .await
        .expect("the binding counts within half a minute");
    let mut wide = hub.rows(live.query(&five)).await.unwrap();
    until(&mut wide, ready).await;
    assert_eq!(hub.scopes(), [Scope::Cluster], "the review allowed it");
    assert_eq!(wide.items().len(), 5, "filtered to the five");

    live.revoke_everywhere(&everywhere).await;
    for namespace in &namespaces {
        live.delete_namespace(namespace).await;
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_service_account_that_may_list_namespaces_reads_all_of_those_it_may_list_pods_in() {
    let live = live().await;
    let namespaces = [
        live.namespace("hub-all").await,
        live.namespace("hub-all").await,
        live.namespace("hub-all").await,
    ];
    let (home, others) = (&namespaces[0], &namespaces[1..]);
    for namespace in &namespaces {
        live.pod(namespace, "p").await;
    }
    let read = [home, &others[0]];
    for namespace in read {
        live.allow_pods_in(namespace, home, "namer").await;
    }
    let name = format!("{home}-namespaces");
    live.allow_everywhere(
        &name,
        "namespaces",
        &["get", "list", "watch"],
        home,
        "namer",
    )
    .await;
    let config = live.as_account(home, "namer").await;

    let (hub, clients) = live.hub(Some(&config));
    // The authorizer learns of the bindings a moment later.
    let allowed = async {
        let one = kube::api::ListParams::default().limit(1);
        for namespace in read {
            let pods = Api::<Pod>::namespaced(clients.api.clone(), namespace);
            while pods.list(&one).await.is_err() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        let namespace_api = Api::<Namespace>::all(clients.api.clone());
        while namespace_api.list(&one).await.is_err() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(30), allowed)
        .await
        .expect("the bindings count within half a minute");
    let namespace_api = Api::<Namespace>::all(clients.api.clone());
    let every = kube::api::ListParams::default();
    let before = namespace_api.list(&every).await.unwrap().items.len();
    let mut all = hub.rows(live.query(&[])).await.unwrap();
    until(&mut all, |all| {
        let shown = all.drain_shown();
        shown.status == ViewState::Ready && shown.parts.count == 2 && shown.parts.unready.is_empty()
    })
    .await;
    let after = namespace_api.list(&every).await.unwrap().items.len();
    let scopes = hub.scopes();
    assert!(
        read.iter()
            .all(|namespace| scopes.contains(&Scope::Namespace((*namespace).clone()))),
        "an upstream for each of the two"
    );
    assert_eq!(all.items().len(), 2, "their pods");
    // The other tests of this binary make and delete namespaces meanwhile.
    let left_out = usize::try_from(all.drain_shown().parts.omitted).unwrap() + 2;
    assert!(
        (before.min(after)..=before.max(after)).contains(&left_out),
        "the namespaces of the cluster less the two read: {left_out}, counted {before} then {after}"
    );

    live.revoke_everywhere(&name).await;
    for namespace in &namespaces {
        live.delete_namespace(namespace).await;
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_object_upstream_follows_an_edit() {
    let live = live().await;
    let namespace = live.namespace("hub-object").await;
    live.pod(&namespace, "p1").await;
    let (hub, _clients) = live.hub(None);
    let resource = live.query(&[]).resource;
    let mut pod = hub
        .object(&live.context, resource, Some(namespace.clone()), "p1")
        .unwrap();
    until(&mut pod, |pod| ready(pod) && pod.items().len() == 1).await;

    let patch = json!({ "metadata": { "labels": { "edited": "yes" } } });
    Api::<Pod>::namespaced(live.admin.clone(), &namespace)
        .patch("p1", &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .unwrap();
    until(&mut pod, |pod| {
        pod.items().iter().any(|object| {
            object
                .meta
                .labels
                .iter()
                .any(|(key, value)| &**key == "edited" && &**value == "yes")
        })
    })
    .await;
    let object = &pod.items()[0];
    let json: serde_json::Value = serde_json::from_str(object.json.get()).unwrap();
    assert_eq!(json["spec"]["nodeName"], "kwok-node-0");
    live.delete_namespace(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_events_upstream_follows_the_events_of_one_object() {
    let live = live().await;
    let namespace = live.namespace("hub-events").await;
    live.pod(&namespace, "p1").await;
    live.pod(&namespace, "p2").await;
    let pods = Api::<Pod>::namespaced(live.admin.clone(), &namespace);
    let uid = |pod: Pod| pod.metadata.uid.unwrap();
    let (first, second) = (
        uid(pods.get("p1").await.unwrap()),
        uid(pods.get("p2").await.unwrap()),
    );
    let events: Api<kube::api::DynamicObject> = Api::namespaced_with(
        live.admin.clone(),
        &namespace,
        &kube::api::ApiResource {
            group: "events.k8s.io".to_owned(),
            version: "v1".to_owned(),
            api_version: "events.k8s.io/v1".to_owned(),
            kind: "Event".to_owned(),
            plural: "events".to_owned(),
        },
    );
    let report = |name: &str, pod: &str, uid: &str| {
        serde_json::from_value::<kube::api::DynamicObject>(json!({
            "apiVersion": "events.k8s.io/v1",
            "kind": "Event",
            "metadata": { "name": name },
            "eventTime": "2026-11-02T10:00:00.000000Z",
            "reportingController": "twigo.io/test",
            "reportingInstance": "test",
            "action": "Probe",
            "reason": "Probed",
            "type": "Normal",
            "note": format!("about {pod}"),
            "regarding": { "apiVersion": "v1", "kind": "Pod", "namespace": namespace, "name": pod, "uid": uid },
        }))
        .unwrap()
    };
    events
        .create(&PostParams::default(), &report("e1", "p1", &first))
        .await
        .unwrap();
    let (hub, _clients) = live.hub(None);
    let resource = Resource {
        group: "events.k8s.io".to_owned(),
        version: "v1".to_owned(),
        resource: "events".to_owned(),
        namespaced: true,
    };
    let mut selected = hub
        .selected(
            &live.context,
            resource,
            Some(namespace.clone()),
            Some(format!("regarding.uid={first}")),
        )
        .unwrap();
    until(&mut selected, |events| {
        ready(events) && events.items().len() == 1
    })
    .await;

    events
        .create(&PostParams::default(), &report("e2", "p2", &second))
        .await
        .unwrap();
    events
        .create(&PostParams::default(), &report("e3", "p1", &first))
        .await
        .unwrap();
    until(&mut selected, |events| events.items().len() == 2).await;
    let mut names: Vec<String> = selected
        .items()
        .iter()
        .map(|event| event.meta.name.to_string())
        .collect();
    names.sort();
    assert_eq!(names, ["e1", "e3"], "only the first pod's");
    live.delete_namespace(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_object_whose_name_a_selector_would_split_opens() {
    let live = live().await;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let name = format!("twigo-probe-{nanos},reader=x");
    let roles = Api::<ClusterRole>::all(live.admin.clone());
    let role: ClusterRole =
        serde_json::from_value(json!({ "metadata": { "name": name }, "rules": [] })).unwrap();
    roles.create(&PostParams::default(), &role).await.unwrap();
    let (hub, _clients) = live.hub(None);
    let resource = Resource {
        group: "rbac.authorization.k8s.io".to_owned(),
        version: "v1".to_owned(),
        resource: "clusterroles".to_owned(),
        namespaced: false,
    };
    let mut opened = hub.object(&live.context, resource, None, &name).unwrap();
    until(&mut opened, |role| ready(role) && role.items().len() == 1).await;
    assert_eq!(&*opened.items()[0].meta.name, name);
    roles.delete(&name, &DeleteParams::default()).await.unwrap();
}
