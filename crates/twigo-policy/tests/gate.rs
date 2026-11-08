//! The one table of what the gate does with each way to reach a cluster
//! (ARCHITECTURE 6.4). A step that adds a way to change a cluster adds its
//! row here: the request it sends, its class, and what each mode answers.

use http::header::{ACCEPT, UPGRADE};
use http::{Method, Request};
use twigo_ipc::{BlockReason, Mode, RequestClass};
use twigo_policy::{Actor, Attributes, Audit, Choices, Policy, PolicyFile};

const PODS: &str = "/api/v1/namespaces/a/pods";
const POD: &str = "/api/v1/namespaces/a/pods/p";
const DEPLOYMENT: &str = "/apis/apps/v1/namespaces/a/deployments/d";
const SECRETS: &str = "/api/v1/namespaces/a/secrets";
const JSON: &str = "application/json";
const TABLE: &str = "application/json;as=Table;g=meta.k8s.io;v=v1";
const METADATA: &str = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Answer {
    Pass,
    Block,
}
use Answer::{Block, Pass};

struct Row {
    what: &'static str,
    method: Method,
    uri: &'static str,
    accept: Option<&'static str>,
    upgrade: bool,
    class: RequestClass,
    /// The UI's answer in `read-write`, `guarded` and `read-only`.
    answers: [Answer; 3],
}

fn row(
    what: &'static str,
    method: Method,
    uri: &'static str,
    class: RequestClass,
    answers: [Answer; 3],
) -> Row {
    Row {
        what,
        method,
        uri,
        accept: None,
        upgrade: false,
        class,
        answers,
    }
}

const OPEN: [Answer; 3] = [Pass, Pass, Pass];
const NOT_READ_ONLY: [Answer; 3] = [Pass, Pass, Block];

fn table() -> Vec<Row> {
    use RequestClass::{DryRun, Exec, Forward, Read, SecretRead, Write};
    let get = Method::GET;
    let post = Method::POST;
    let put = Method::PUT;
    let patch = Method::PATCH;
    let delete = Method::DELETE;
    let accepting = |accept, row: Row| Row {
        accept: Some(accept),
        ..row
    };
    let upgrading = |row: Row| Row {
        upgrade: true,
        ..row
    };
    vec![
        // get, list, watch, logs, events, discovery
        row("get", get.clone(), POD, Read, OPEN),
        row("list", get.clone(), PODS, Read, OPEN),
        row("watch", get.clone(), "/api/v1/pods?watch=true", Read, OPEN),
        row(
            "watch by its old path",
            get.clone(),
            "/api/v1/watch/pods",
            Read,
            OPEN,
        ),
        row("head", Method::HEAD, POD, Read, OPEN),
        row(
            "logs",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/log?follow=true",
            Read,
            OPEN,
        ),
        row(
            "events",
            get.clone(),
            "/apis/events.k8s.io/v1/namespaces/a/events",
            Read,
            OPEN,
        ),
        row("discovery", get.clone(), "/apis", Read, OPEN),
        row("the version", get.clone(), "/version", Read, OPEN),
        row("openapi", get.clone(), "/openapi/v3/api/v1", Read, OPEN),
        row("the openapi index", get.clone(), "/openapi/v3", Read, OPEN),
        row(
            "an openapi document by its hash",
            get.clone(),
            "/openapi/v3/apis/apps/v1?hash=0A1B",
            Read,
            OPEN,
        ),
        // POSTs that only ask
        row(
            "access review",
            post.clone(),
            "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
            Read,
            OPEN,
        ),
        row(
            "rules review",
            post.clone(),
            "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews",
            Read,
            OPEN,
        ),
        row(
            "who am I",
            post.clone(),
            "/apis/authentication.k8s.io/v1/selfsubjectreviews",
            Read,
            OPEN,
        ),
        row(
            "a review of someone else",
            post.clone(),
            "/apis/authorization.k8s.io/v1/subjectaccessreviews",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a token review",
            post.clone(),
            "/apis/authentication.k8s.io/v1/tokenreviews",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a review in another group",
            post.clone(),
            "/apis/example.com/v1/selfsubjectaccessreviews",
            Write,
            NOT_READ_ONLY,
        ),
        // create, apply, patch, update, and their dry runs
        row(
            "create",
            post.clone(),
            "/api/v1/namespaces/a/configmaps",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "update",
            put.clone(),
            "/api/v1/namespaces/a/configmaps/c",
            Write,
            NOT_READ_ONLY,
        ),
        row("patch", patch.clone(), DEPLOYMENT, Write, NOT_READ_ONLY),
        row(
            "apply",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?fieldManager=twigo",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "create, dry run",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=All",
            DryRun,
            OPEN,
        ),
        row(
            "apply, dry run",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?dryRun=All&fieldManager=twigo",
            DryRun,
            OPEN,
        ),
        row(
            "a delete whose body the server would read instead of its dryRun",
            delete.clone(),
            "/api/v1/namespaces/a/pods/p?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a delete of a collection, the same",
            delete.clone(),
            "/api/v1/namespaces/a/pods?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a subresource that ignores dryRun and mints a token",
            post.clone(),
            "/api/v1/namespaces/a/serviceaccounts/s/token?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a dry run of a subresource, even one that honours it",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d/scale?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a dry run of a Secret, answered with what it stores",
            patch.clone(),
            "/api/v1/namespaces/a/secrets/s?dryRun=All",
            SecretRead,
            OPEN,
        ),
        row(
            "a dry run that creates a Secret",
            post.clone(),
            "/api/v1/namespaces/a/secrets?dryRun=All",
            SecretRead,
            OPEN,
        ),
        row(
            "dryRun with another value",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=all",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "dryRun with two values",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=All&dryRun=No",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "dryRun without a value",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=",
            Write,
            NOT_READ_ONLY,
        ),
        // delete, scale, rollout restart, cordon, drain, evict
        row("delete", delete.clone(), POD, Write, NOT_READ_ONLY),
        row(
            "delete a collection",
            delete.clone(),
            PODS,
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "delete a namespace",
            delete.clone(),
            "/api/v1/namespaces/a",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "finalize a namespace",
            put.clone(),
            "/api/v1/namespaces/a/finalize",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "scale, and its undo",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d/scale",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "rollout restart",
            patch.clone(),
            DEPLOYMENT,
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "cordon or uncordon, a drain's first step, and their undo",
            patch.clone(),
            "/api/v1/nodes/n",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "evict, as a drain does",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/eviction",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "trigger a cron job: a job from its template",
            post.clone(),
            "/apis/batch/v1/namespaces/a/jobs",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "suspend or resume a job, and its undo",
            patch.clone(),
            "/apis/batch/v1/namespaces/a/jobs/j",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "suspend or resume a cron job, and its undo",
            patch.clone(),
            "/apis/batch/v1/namespaces/a/cronjobs/c",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "mint a token",
            post.clone(),
            "/api/v1/namespaces/a/serviceaccounts/s/token",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "an ephemeral container",
            patch.clone(),
            "/api/v1/namespaces/a/pods/p/ephemeralcontainers",
            Write,
            NOT_READ_ONLY,
        ),
        // Reveal: the UI reads, whatever the mode; the command asks first.
        accepting(
            JSON,
            row(
                "get a Secret",
                get.clone(),
                "/api/v1/namespaces/a/secrets/s",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            JSON,
            row("list Secrets", get.clone(), SECRETS, SecretRead, OPEN),
        ),
        accepting(
            JSON,
            row(
                "watch Secrets",
                get.clone(),
                "/api/v1/secrets?watch=1",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            JSON,
            row(
                "watch Secrets by the old path",
                get.clone(),
                "/api/v1/watch/secrets",
                SecretRead,
                OPEN,
            ),
        ),
        row(
            "Secrets with no Accept",
            get.clone(),
            SECRETS,
            SecretRead,
            OPEN,
        ),
        accepting(
            "*/*",
            row(
                "Secrets with any Accept",
                get.clone(),
                SECRETS,
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            METADATA,
            row(
                "Secrets' metadata, whose last-applied annotation holds their values",
                get.clone(),
                SECRETS,
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            TABLE,
            row(
                "a table with metadata by default",
                get.clone(),
                SECRETS,
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            TABLE,
            row(
                "a table with metadata",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=Metadata",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            TABLE,
            row(
                "a table without objects",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=None",
                Read,
                OPEN,
            ),
        ),
        accepting(
            TABLE,
            row(
                "includeObject=Object, as kubectl --sort-by",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=Object",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            TABLE,
            row(
                "includeObject that the server may read otherwise",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=None&includeObject=Object",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            "application/json;as=Table;v=v1;g=meta.k8s.io,application/json",
            row(
                "a plain get secrets, with its JSON fallback",
                get.clone(),
                SECRETS,
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            "application/json;as=Table;v=v1;g=example.com",
            row(
                "a Table of another group",
                get.clone(),
                SECRETS,
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            "application/json;as=table;v=v1;g=meta.k8s.io",
            row(
                "a kind in another case",
                get.clone(),
                SECRETS,
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            "application/json;AS=Table;G=meta.k8s.io;V=v1",
            row(
                "parameter names in another case, which the server does not read",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=None",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            "application/json;\tas=Table;g=meta.k8s.io;v=v1",
            row(
                "a parameter after a tab, which the server does not trim",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=None",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            "application/json;as=Table;as=Secret;g=meta.k8s.io;v=v1",
            row(
                "two kinds, of which the server keeps the last",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=None",
                SecretRead,
                OPEN,
            ),
        ),
        accepting(
            "application/json;as=Secret;as=Table;g=meta.k8s.io;v=v1",
            row(
                "two kinds, the last of them the Table the server serves",
                get.clone(),
                "/api/v1/namespaces/a/secrets?includeObject=None",
                Read,
                OPEN,
            ),
        ),
        row(
            "create a Secret",
            post.clone(),
            SECRETS,
            Write,
            NOT_READ_ONLY,
        ),
        // port-forward
        upgrading(row(
            "port-forward",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/portforward",
            Forward,
            OPEN,
        )),
        upgrading(row(
            "port-forward by POST",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/portforward",
            Forward,
            OPEN,
        )),
        row(
            "a pod's proxy",
            get.clone(),
            "/api/v1/namespaces/a/pods/p:80/proxy/index.html",
            Forward,
            OPEN,
        ),
        row(
            "a service's proxy",
            get.clone(),
            "/api/v1/namespaces/a/services/s:80/proxy/",
            Forward,
            OPEN,
        ),
        // exec, attach
        upgrading(row(
            "exec",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/exec?command=sh",
            Exec,
            NOT_READ_ONLY,
        )),
        upgrading(row(
            "exec by POST",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/exec?command=sh",
            Exec,
            NOT_READ_ONLY,
        )),
        row(
            "exec without an upgrade",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/exec",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "exec with dryRun",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/exec?dryRun=All",
            Exec,
            NOT_READ_ONLY,
        ),
        upgrading(row(
            "attach",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/attach",
            Exec,
            NOT_READ_ONLY,
        )),
        // the conservative cases
        row(
            "a node's proxy",
            get.clone(),
            "/api/v1/nodes/n/proxy/stats",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "a kubelet's exec through its proxy",
            post.clone(),
            "/api/v1/nodes/n/proxy/exec/a/p/c",
            Exec,
            NOT_READ_ONLY,
        ),
        upgrading(row(
            "an unknown Upgrade",
            get.clone(),
            PODS,
            Exec,
            NOT_READ_ONLY,
        )),
        upgrading(row(
            "an Upgrade with a dry run",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=All",
            Exec,
            NOT_READ_ONLY,
        )),
        upgrading(row(
            "an Upgrade through a pod's proxy",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/proxy/ws",
            Exec,
            NOT_READ_ONLY,
        )),
        row(
            "a POST through a pod's proxy",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/proxy/x",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "a POST through a service's proxy",
            post.clone(),
            "/api/v1/namespaces/a/services/s/proxy/x",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "a HEAD through a pod's proxy",
            Method::HEAD,
            "/api/v1/namespaces/a/pods/p/proxy/x",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "another resource's proxy",
            get.clone(),
            "/apis/example.com/v1/things/t/proxy/x",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "a pod's proxy in another group",
            get.clone(),
            "/apis/example.com/v1/namespaces/a/pods/p/proxy",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "the old proxy path",
            get.clone(),
            "/api/v1/proxy/namespaces/a/pods/p/x",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "exec behind an escaped slash",
            post.clone(),
            "/api/v1/namespaces/a/pods/p%2Fexec",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "a path that cleans into another",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/log/../exec",
            Exec,
            NOT_READ_ONLY,
        ),
        row(
            "an empty segment",
            get.clone(),
            "/api/v1/namespaces/a//pods/p",
            Exec,
            NOT_READ_ONLY,
        ),
        row("CONNECT", Method::CONNECT, POD, Exec, NOT_READ_ONLY),
        row(
            "a write with no resource",
            post.clone(),
            "/foo",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a dry run with no resource",
            post.clone(),
            "/foo?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row("OPTIONS", Method::OPTIONS, POD, Write, NOT_READ_ONLY),
        row(
            "a method that is no write, with dryRun",
            Method::OPTIONS,
            "/api/v1/namespaces/a/configmaps?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a token review, which answers whatever dryRun says",
            post.clone(),
            "/apis/authentication.k8s.io/v1/tokenreviews?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a review of someone else, the same",
            post.clone(),
            "/apis/authorization.k8s.io/v1/subjectaccessreviews?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
        row(
            "a review of someone in a namespace, the same",
            post.clone(),
            "/apis/authorization.k8s.io/v1/namespaces/a/localsubjectaccessreviews?dryRun=All",
            Write,
            NOT_READ_ONLY,
        ),
    ]
}

fn request(row: &Row) -> Request<()> {
    let mut request = Request::builder().method(row.method.clone()).uri(row.uri);
    if let Some(accept) = row.accept {
        request = request.header(ACCEPT, accept);
    }
    if row.upgrade {
        request = request.header(UPGRADE, "websocket");
    }
    request.body(()).unwrap()
}

fn policy_in(mode: Mode) -> std::sync::Arc<Policy> {
    let policy = Policy::open();
    policy.set_mode("c", Some(mode)).unwrap();
    policy
}

const MODES: [Mode; 3] = [Mode::ReadWrite, Mode::Guarded, Mode::ReadOnly];

#[test]
fn every_row_has_its_class_and_each_mode_its_answer() {
    for row in table() {
        let attributes = Attributes::of(&request(&row));
        assert_eq!(attributes.class, row.class, "{}: {}", row.what, row.uri);
        for (mode, answer) in MODES.into_iter().zip(row.answers) {
            let got = policy_in(mode).authorize("c", &attributes, Actor::Ui);
            let got = if got.is_ok() { Pass } else { Block };
            assert_eq!(got, answer, "{} in {mode:?}", row.what);
        }
    }
}

#[test]
fn a_read_only_context_lets_a_port_forward_through_unless_the_file_says_no() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("policy.json");
    std::fs::write(&file, r#"{"readOnly": {"allowPortForward": false}}"#).unwrap();
    let policy = Policy::new(
        PolicyFile::read(&file),
        |_| Some(twigo_policy::Metadata::default()),
        Choices::default(),
        Audit::off(),
    );
    let forward = Attributes::action("create", "pods", Some("portforward"), Some("a"), Some("p"));
    assert_eq!(forward.class, RequestClass::Forward);
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    assert!(policy.authorize("c", &forward, Actor::Ui).is_err());
    policy.set_mode("c", Some(Mode::Guarded)).unwrap();
    policy.authorize("c", &forward, Actor::Ui).unwrap();
    policy.set_mode("c", Some(Mode::ReadWrite)).unwrap();
    policy.authorize("c", &forward, Actor::Ui).unwrap();
}

#[test]
fn reading_a_secret_is_decided_by_the_actor_and_not_the_mode() {
    let read = Attributes::action("get", "secrets", None, Some("a"), Some("s"));
    assert_eq!(read.class, RequestClass::SecretRead);
    let cases = [
        (Actor::Ui, None),
        (Actor::Terminal, None),
        (Actor::Helm, None),
        (Actor::Mcp, None),
        (Actor::Extension { secrets: true }, None),
        (
            Actor::Extension { secrets: false },
            Some(BlockReason::NoGrant),
        ),
        (Actor::Agent, Some(BlockReason::NoApproval)),
    ];
    for mode in MODES {
        let policy = policy_in(mode);
        for (actor, reason) in cases {
            let got = policy.authorize("c", &read, actor).err().map(|b| b.reason);
            assert_eq!(got, reason, "{actor:?} in {mode:?}");
        }
    }
}

#[test]
fn a_write_to_a_secret_answers_with_it_so_it_needs_what_reading_one_does() {
    let patch = Request::patch("/api/v1/namespaces/a/secrets/s")
        .body(())
        .unwrap();
    let patch = Attributes::of(&patch);
    let delete = Request::delete("/api/v1/namespaces/a/secrets")
        .body(())
        .unwrap();
    let delete = Attributes::of(&delete);
    let policy = policy_in(Mode::ReadWrite);
    for write in [&patch, &delete] {
        assert_eq!(write.class, RequestClass::Write);
        policy.authorize("c", write, Actor::Ui).unwrap();
        policy.authorize("c", write, Actor::Terminal).unwrap();
        policy
            .authorize("c", write, Actor::Extension { secrets: true })
            .unwrap();
        let no_grant = policy
            .authorize("c", write, Actor::Extension { secrets: false })
            .unwrap_err();
        assert_eq!(no_grant.reason, BlockReason::NoGrant);
        let agent = policy.authorize("c", write, Actor::Agent).unwrap_err();
        assert_eq!(agent.reason, BlockReason::NoApproval);
    }
    let configmap = Attributes::action("patch", "configmaps", None, Some("a"), Some("c"));
    policy.authorize("c", &configmap, Actor::Agent).unwrap();
}

#[test]
fn in_guarded_only_the_ui_writes_since_its_commands_confirm_and_others_need_an_approval() {
    let write = Attributes::action("patch", "deployments", None, Some("a"), Some("d"));
    let exec = Attributes::action("create", "pods", Some("exec"), Some("a"), Some("p"));
    let policy = policy_in(Mode::Guarded);
    for attributes in [&write, &exec] {
        policy.authorize("c", attributes, Actor::Ui).unwrap();
        for actor in [Actor::Terminal, Actor::Helm, Actor::Agent, Actor::Mcp] {
            let blocked = policy.authorize("c", attributes, actor).unwrap_err();
            assert_eq!(blocked.reason, BlockReason::NoApproval, "{actor:?}");
        }
    }
    let policy = policy_in(Mode::ReadWrite);
    policy.authorize("c", &write, Actor::Terminal).unwrap();
}

#[test]
fn what_a_command_says_it_does_has_the_class_of_the_request_it_sends() {
    let cases = [
        ("get", "pods", None, "/api/v1/namespaces/a/pods/p"),
        (
            "create",
            "configmaps",
            None,
            "/api/v1/namespaces/a/configmaps",
        ),
        ("delete", "pods", None, "/api/v1/namespaces/a/pods/p"),
        (
            "patch",
            "deployments",
            Some("scale"),
            "/apis/apps/v1/namespaces/a/deployments/d/scale",
        ),
        (
            "create",
            "pods",
            Some("eviction"),
            "/api/v1/namespaces/a/pods/p/eviction",
        ),
        (
            "create",
            "pods",
            Some("exec"),
            "/api/v1/namespaces/a/pods/p/exec",
        ),
        (
            "create",
            "pods",
            Some("attach"),
            "/api/v1/namespaces/a/pods/p/attach",
        ),
        (
            "create",
            "pods",
            Some("portforward"),
            "/api/v1/namespaces/a/pods/p/portforward",
        ),
        (
            "get",
            "services",
            Some("proxy"),
            "/api/v1/namespaces/a/services/s/proxy/",
        ),
        ("get", "nodes", Some("proxy"), "/api/v1/nodes/n/proxy/stats"),
        ("get", "secrets", None, "/api/v1/namespaces/a/secrets/s"),
    ];
    for (verb, resource, subresource, uri) in cases {
        let method = match verb {
            "get" => Method::GET,
            "delete" => Method::DELETE,
            "patch" => Method::PATCH,
            _ => Method::POST,
        };
        let request = Request::builder().method(method).uri(uri).body(()).unwrap();
        let sent = Attributes::of(&request);
        let said = Attributes::action(verb, resource, subresource, None, None);
        assert_eq!(said.class, sent.class, "{verb} {uri}");
        assert_eq!(said.verb, sent.verb, "{verb} {uri}");
    }
}

#[test]
fn a_request_is_read_as_the_api_server_reads_it() {
    let read = |method: Method, uri: &str| {
        let request = Request::builder().method(method).uri(uri).body(()).unwrap();
        let a = Attributes::of(&request);
        (a.verb, a.namespace, a.resource, a.name, a.subresource)
    };
    let some = |value: &str| Some(value.to_owned());
    assert_eq!(
        read(Method::GET, "/api/v1/namespaces/a/pods/p/log"),
        (
            "get".to_owned(),
            some("a"),
            some("pods"),
            some("p"),
            some("log")
        )
    );
    assert_eq!(
        read(Method::GET, "/api/v1/pods?watch=true"),
        ("watch".to_owned(), None, some("pods"), None, None)
    );
    assert_eq!(
        read(Method::GET, "/api/v1/pods?watch=false"),
        ("list".to_owned(), None, some("pods"), None, None)
    );
    assert_eq!(
        read(Method::GET, "/api/v1/namespaces"),
        ("list".to_owned(), None, some("namespaces"), None, None)
    );
    assert_eq!(
        read(Method::GET, "/api/v1/namespaces/a"),
        (
            "get".to_owned(),
            some("a"),
            some("namespaces"),
            some("a"),
            None
        )
    );
    assert_eq!(
        read(Method::PUT, "/api/v1/namespaces/a/status"),
        (
            "update".to_owned(),
            some("a"),
            some("namespaces"),
            some("a"),
            some("status")
        )
    );
    assert_eq!(
        read(Method::DELETE, "/apis/apps/v1/namespaces/a/deployments"),
        (
            "deletecollection".to_owned(),
            some("a"),
            some("deployments"),
            None,
            None
        )
    );
    assert_eq!(
        read(
            Method::POST,
            "/apis/apps/v1/namespaces/a/deployments/d/scale"
        ),
        (
            "create".to_owned(),
            some("a"),
            some("deployments"),
            some("d"),
            some("scale")
        )
    );
    assert_eq!(
        read(Method::GET, "/api/v1/proxy/namespaces/a/pods/p/x"),
        ("proxy".to_owned(), some("a"), some("pods"), some("p"), None)
    );
    assert_eq!(
        read(Method::GET, "/apis/apps/v1"),
        ("get".to_owned(), None, None, None, None)
    );
}
