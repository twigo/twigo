//! The one table of what the gate does with each way to reach a cluster
//! (ARCHITECTURE 6.4). A step that adds a way to change a cluster adds its
//! row here: the request it sends, its class, and what each mode answers,
//! and a context nobody marked.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use http::header::{ACCEPT, UPGRADE};
use http::{Method, Request};
use jiff::{SignedDuration, Timestamp};
use tower::{ServiceBuilder, ServiceExt};
use twigo_ipc::{BlockReason, Mode, RequestClass};
use twigo_policy::{
    Actor, Approval, Attributes, Audit, Choices, Metadata, Policy, PolicyFile, Server,
};

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
    /// Who serves the group-version of a dry run outside kube-apiserver's
    /// own groups, as read; none where nothing could read it.
    served: Option<Server>,
    class: RequestClass,
    /// The UI's answer in each of [`COLUMNS`].
    answers: [Answer; 4],
}

fn row(
    what: &'static str,
    method: Method,
    uri: &'static str,
    class: RequestClass,
    answers: [Answer; 4],
) -> Row {
    Row {
        what,
        method,
        uri,
        accept: None,
        upgrade: false,
        served: None,
        class,
        answers,
    }
}

const OPEN: [Answer; 4] = [Pass; 4];
/// A write or an exec: neither `read-only` nor a context nobody marked lets
/// it through.
const WRITE_OR_EXEC: [Answer; 4] = [Pass, Pass, Block, Block];

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
    let serving = |served, row: Row| Row { served, ..row };
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
            WRITE_OR_EXEC,
        ),
        row(
            "a token review",
            post.clone(),
            "/apis/authentication.k8s.io/v1/tokenreviews",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a review in another group",
            post.clone(),
            "/apis/example.com/v1/selfsubjectaccessreviews",
            Write,
            WRITE_OR_EXEC,
        ),
        // create, apply, patch, update, and their dry runs
        row(
            "create",
            post.clone(),
            "/api/v1/namespaces/a/configmaps",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "update",
            put.clone(),
            "/api/v1/namespaces/a/configmaps/c",
            Write,
            WRITE_OR_EXEC,
        ),
        row("patch", patch.clone(), DEPLOYMENT, Write, WRITE_OR_EXEC),
        row(
            "apply",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?fieldManager=twigo",
            Write,
            WRITE_OR_EXEC,
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
            "a dry run to a built-in group, whose APIService nobody read",
            post.clone(),
            "/apis/networking.k8s.io/v1/namespaces/a/ingresses?dryRun=All",
            DryRun,
            OPEN,
        ),
        serving(
            Some(Server::Itself),
            row(
                "a dry run to a group whose APIService names no service",
                post.clone(),
                "/apis/example.com/v1/namespaces/a/widgets?dryRun=All",
                DryRun,
                OPEN,
            ),
        ),
        serving(
            Some(Server::Aggregated),
            row(
                "a dry run to a group an APIService hands to another server",
                patch.clone(),
                "/apis/metrics.k8s.io/v1beta1/namespaces/a/pods/p?dryRun=All",
                Write,
                WRITE_OR_EXEC,
            ),
        ),
        serving(
            None,
            row(
                "a dry run to a group whose APIService cannot be read",
                post.clone(),
                "/apis/example.com/v1/namespaces/a/widgets?dryRun=All",
                Write,
                WRITE_OR_EXEC,
            ),
        ),
        row(
            "a delete whose body the server would read instead of its dryRun",
            delete.clone(),
            "/api/v1/namespaces/a/pods/p?dryRun=All",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a delete of a collection, the same",
            delete.clone(),
            "/api/v1/namespaces/a/pods?dryRun=All",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a subresource that ignores dryRun and mints a token",
            post.clone(),
            "/api/v1/namespaces/a/serviceaccounts/s/token?dryRun=All",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a dry run of a subresource, even one that honours it",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d/scale?dryRun=All",
            Write,
            WRITE_OR_EXEC,
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
            WRITE_OR_EXEC,
        ),
        row(
            "dryRun with two values",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=All&dryRun=No",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "dryRun without a value",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=",
            Write,
            WRITE_OR_EXEC,
        ),
        // delete, scale, rollout restart, cordon, drain, evict
        row("delete", delete.clone(), POD, Write, WRITE_OR_EXEC),
        row(
            "delete a collection",
            delete.clone(),
            PODS,
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "delete a namespace",
            delete.clone(),
            "/api/v1/namespaces/a",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "finalize a namespace",
            put.clone(),
            "/api/v1/namespaces/a/finalize",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "scale, and its undo",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d/scale",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "rollout restart",
            patch.clone(),
            DEPLOYMENT,
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "apply of an edit, and its merge patch",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?fieldManager=twigo&fieldValidation=Strict&force=true",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "an apply's dry-run",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?dryRun=All&fieldManager=twigo&fieldValidation=Strict",
            DryRun,
            OPEN,
        ),
        row(
            "a merge patch's dry-run",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?dryRun=All&fieldManager=twigo",
            DryRun,
            OPEN,
        ),
        row(
            "an apply's dry-run of a Secret",
            patch.clone(),
            "/api/v1/namespaces/a/secrets/s?dryRun=All&fieldManager=twigo&fieldValidation=Strict",
            SecretRead,
            OPEN,
        ),
        row(
            "one merge patch for an edit an apply cannot express",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?fieldManager=twigo-edit&fieldValidation=Strict",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "that merge patch's dry-run",
            patch.clone(),
            "/apis/apps/v1/namespaces/a/deployments/d?dryRun=All&fieldManager=twigo-edit&fieldValidation=Strict",
            DryRun,
            OPEN,
        ),
        row(
            "a recreate's check that its body can be created",
            post.clone(),
            "/api/v1/namespaces/a/pods?dryRun=All&fieldManager=twigo&fieldValidation=Strict",
            DryRun,
            OPEN,
        ),
        row(
            "recreate's create, under a Pod or a Job",
            post.clone(),
            "/api/v1/namespaces/a/pods?fieldManager=twigo&fieldValidation=Strict",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "cordon or uncordon, a drain's first step, and their undo",
            patch.clone(),
            "/api/v1/nodes/n",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "evict, as a drain does",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/eviction",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "trigger a cron job: a job from its template",
            post.clone(),
            "/apis/batch/v1/namespaces/a/jobs",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "suspend or resume a job, and its undo",
            patch.clone(),
            "/apis/batch/v1/namespaces/a/jobs/j",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "suspend or resume a cron job, and its undo",
            patch.clone(),
            "/apis/batch/v1/namespaces/a/cronjobs/c",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "mint a token",
            post.clone(),
            "/api/v1/namespaces/a/serviceaccounts/s/token",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "an ephemeral container",
            patch.clone(),
            "/api/v1/namespaces/a/pods/p/ephemeralcontainers",
            Write,
            WRITE_OR_EXEC,
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
            METADATA,
            row(
                "the release Secrets of a namespace, by Helm's label",
                get.clone(),
                "/api/v1/namespaces/a/secrets?labelSelector=owner%3Dhelm",
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
            WRITE_OR_EXEC,
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
            WRITE_OR_EXEC,
        )),
        upgrading(row(
            "exec by POST",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/exec?command=sh",
            Exec,
            WRITE_OR_EXEC,
        )),
        row(
            "exec without an upgrade",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/exec",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "exec with dryRun",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/exec?dryRun=All",
            Exec,
            WRITE_OR_EXEC,
        ),
        upgrading(row(
            "attach",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/attach",
            Exec,
            WRITE_OR_EXEC,
        )),
        row(
            "attach without an upgrade",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/attach",
            Exec,
            WRITE_OR_EXEC,
        ),
        upgrading(row(
            "attach as kube sends it",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/attach?stdin=true&stdout=true&tty=true&container=c",
            Exec,
            WRITE_OR_EXEC,
        )),
        // the conservative cases
        row(
            "a node's proxy",
            get.clone(),
            "/api/v1/nodes/n/proxy/stats",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "a kubelet's exec through its proxy",
            post.clone(),
            "/api/v1/nodes/n/proxy/exec/a/p/c",
            Exec,
            WRITE_OR_EXEC,
        ),
        upgrading(row(
            "an unknown Upgrade",
            get.clone(),
            PODS,
            Exec,
            WRITE_OR_EXEC,
        )),
        upgrading(row(
            "an Upgrade with a dry run",
            post.clone(),
            "/api/v1/namespaces/a/configmaps?dryRun=All",
            Exec,
            WRITE_OR_EXEC,
        )),
        upgrading(row(
            "an Upgrade through a pod's proxy",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/proxy/ws",
            Exec,
            WRITE_OR_EXEC,
        )),
        row(
            "a POST through a pod's proxy",
            post.clone(),
            "/api/v1/namespaces/a/pods/p/proxy/x",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "a POST through a service's proxy",
            post.clone(),
            "/api/v1/namespaces/a/services/s/proxy/x",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "a HEAD through a pod's proxy",
            Method::HEAD,
            "/api/v1/namespaces/a/pods/p/proxy/x",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "another resource's proxy",
            get.clone(),
            "/apis/example.com/v1/things/t/proxy/x",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "a pod's proxy in another group",
            get.clone(),
            "/apis/example.com/v1/namespaces/a/pods/p/proxy",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "the old proxy path",
            get.clone(),
            "/api/v1/proxy/namespaces/a/pods/p/x",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "exec behind an escaped slash",
            post.clone(),
            "/api/v1/namespaces/a/pods/p%2Fexec",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "a path that cleans into another",
            get.clone(),
            "/api/v1/namespaces/a/pods/p/log/../exec",
            Exec,
            WRITE_OR_EXEC,
        ),
        row(
            "an empty segment",
            get.clone(),
            "/api/v1/namespaces/a//pods/p",
            Exec,
            WRITE_OR_EXEC,
        ),
        row("CONNECT", Method::CONNECT, POD, Exec, WRITE_OR_EXEC),
        row(
            "a write with no resource",
            post.clone(),
            "/foo",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a dry run with no resource",
            post.clone(),
            "/foo?dryRun=All",
            Write,
            WRITE_OR_EXEC,
        ),
        row("OPTIONS", Method::OPTIONS, POD, Write, WRITE_OR_EXEC),
        row(
            "a method that is no write, with dryRun",
            Method::OPTIONS,
            "/api/v1/namespaces/a/configmaps?dryRun=All",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a token review, which answers whatever dryRun says",
            post.clone(),
            "/apis/authentication.k8s.io/v1/tokenreviews?dryRun=All",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a review of someone else, the same",
            post.clone(),
            "/apis/authorization.k8s.io/v1/subjectaccessreviews?dryRun=All",
            Write,
            WRITE_OR_EXEC,
        ),
        row(
            "a review of someone in a namespace, the same",
            post.clone(),
            "/apis/authorization.k8s.io/v1/namespaces/a/localsubjectaccessreviews?dryRun=All",
            Write,
            WRITE_OR_EXEC,
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

/// The context `c` as each column of the tables has it: in each mode, and
/// marked by nobody.
#[derive(Debug, Clone, Copy)]
enum Column {
    In(Mode),
    Unmarked,
}

const COLUMNS: [Column; 4] = [
    Column::In(Mode::ReadWrite),
    Column::In(Mode::Guarded),
    Column::In(Mode::ReadOnly),
    Column::Unmarked,
];

impl Column {
    fn policy(self) -> std::sync::Arc<Policy> {
        match self {
            Column::In(mode) => policy_in(mode),
            Column::Unmarked => unmarked(),
        }
    }
}

fn unmarked() -> std::sync::Arc<Policy> {
    Policy::new(
        PolicyFile::default(),
        |_| Some(Metadata::default()),
        Choices::default(),
        Audit::off(),
    )
}

#[test]
fn every_row_has_its_class_and_each_mode_its_answer() {
    for row in table() {
        let attributes = Attributes::served(&request(&row), |_, _| row.served);
        assert_eq!(attributes.class, row.class, "{}: {}", row.what, row.uri);
        for (column, answer) in COLUMNS.into_iter().zip(row.answers) {
            let got = column.policy().authorize("c", &attributes, Actor::Ui);
            let got = if got.is_ok() { Pass } else { Block };
            assert_eq!(got, answer, "{} in {column:?}", row.what);
        }
    }
}

#[test]
fn a_context_nobody_marked_refuses_every_actor_s_write_and_exec() {
    let write = Attributes::action("patch", "deployments", None, Some("a"), Some("d"));
    let exec = Attributes::action("create", "pods", Some("exec"), Some("a"), Some("p"));
    let forward = Attributes::action("create", "pods", Some("portforward"), Some("a"), Some("p"));
    let policy = unmarked();
    let actors = [
        Actor::Ui,
        Actor::Terminal,
        Actor::Helm,
        Actor::Mcp,
        Actor::Extension { secrets: true },
        Actor::Agent,
    ];
    for actor in actors {
        for attributes in [&write, &exec] {
            let blocked = policy.authorize("c", attributes, actor).unwrap_err();
            assert_eq!(blocked.reason, BlockReason::Unmarked, "{actor:?}");
            assert_eq!(blocked.mode, Mode::Guarded, "{actor:?}");
            assert!(!policy.approvable("c", attributes, actor), "{actor:?}");
        }
        policy.authorize("c", &forward, actor).unwrap();
    }
}

#[test]
fn a_read_only_context_lets_a_port_forward_through_unless_the_file_says_no() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("policy.json");
    std::fs::write(&file, r#"{"readOnly": {"allowPortForward": false}}"#).unwrap();
    let policy = Policy::new(
        PolicyFile::read(&file),
        |_| Some(Metadata::default()),
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
    for column in COLUMNS {
        let policy = column.policy();
        for (actor, reason) in cases {
            let got = policy.authorize("c", &read, actor).err().map(|b| b.reason);
            assert_eq!(got, reason, "{actor:?} in {column:?}");
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
fn only_what_an_exact_approval_lets_through_is_approvable() {
    let write = Attributes::action("patch", "deployments", None, Some("a"), Some("d"));
    let exec = Attributes::action("create", "pods", Some("exec"), Some("a"), Some("p"));
    let secret = Request::post("/api/v1/namespaces/a/secrets")
        .body(())
        .unwrap();
    let secret = Attributes::of(&secret);
    let read = Attributes::action("get", "secrets", None, Some("a"), Some("s"));
    let guarded = policy_in(Mode::Guarded);
    for actor in [Actor::Terminal, Actor::Helm, Actor::Agent] {
        assert!(guarded.approvable("c", &write, actor), "{actor:?}");
        assert!(guarded.approvable("c", &exec, actor), "{actor:?}");
    }
    assert!(guarded.approvable("c", &secret, Actor::Terminal));
    for column in COLUMNS {
        let policy = column.policy();
        assert!(!policy.approvable("c", &secret, Actor::Agent), "{column:?}");
        assert!(!policy.approvable("c", &read, Actor::Agent), "{column:?}");
    }
    let read_only = policy_in(Mode::ReadOnly);
    assert!(!read_only.approvable("c", &write, Actor::Terminal));
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
        assert_eq!(said.deletes, sent.deletes, "{verb} {uri}");
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

/// The approvals a terminal's request may carry through the policy proxy,
/// in the order of [`Approved::answers`].
const APPROVALS: [&str; 8] = [
    "no approval",
    "an exact one",
    "one for another path",
    "one for another context",
    "one for another actor",
    "a lasting one",
    "an expired one",
    "a lasting one for another context",
];

/// What a column answers a terminal's request with each of [`APPROVALS`].
type Answers = [Answer; 8];

const EVERY: Answers = [Pass; 8];
const NONE: Answers = [Block; 8];
const APPROVED: Answers = [Block, Pass, Block, Block, Block, Pass, Block, Block];
const ONLY_EXACT: Answers = [Block, Pass, Block, Block, Block, Block, Block, Block];

/// A terminal's request through the policy proxy, and what each of
/// [`COLUMNS`] answers it with each approval.
struct Approved {
    what: &'static str,
    method: Method,
    uri: &'static str,
    upgrade: bool,
    class: RequestClass,
    answers: [Answers; 4],
}

fn approved(
    what: &'static str,
    method: Method,
    uri: &'static str,
    class: RequestClass,
    answers: [Answers; 4],
) -> Approved {
    Approved {
        what,
        method,
        uri,
        upgrade: false,
        class,
        answers,
    }
}

fn approvals_table() -> Vec<Approved> {
    use RequestClass::{DryRun, Exec, Forward, Read, SecretRead, Write};
    let upgrading = |row: Approved| Approved {
        upgrade: true,
        ..row
    };
    vec![
        approved("get", Method::GET, POD, Read, [EVERY; 4]),
        approved(
            "a dry run",
            Method::POST,
            "/api/v1/namespaces/a/configmaps?dryRun=All",
            DryRun,
            [EVERY; 4],
        ),
        approved(
            "a dry run to a group an APIService hands to another server",
            Method::PATCH,
            "/apis/metrics.k8s.io/v1beta1/namespaces/a/pods/p?dryRun=All",
            Write,
            [EVERY, APPROVED, NONE, NONE],
        ),
        approved(
            "a dry run to a group whose APIService cannot be read",
            Method::POST,
            "/apis/example.com/v1/namespaces/a/widgets?dryRun=All",
            Write,
            [EVERY, APPROVED, NONE, NONE],
        ),
        approved(
            "a dry run to a group whose APIService names no service",
            Method::POST,
            "/apis/stable.example.com/v1/namespaces/a/crontabs?dryRun=All",
            DryRun,
            [EVERY; 4],
        ),
        approved(
            "a dry run to a built-in group, whose APIService nobody read",
            Method::PATCH,
            "/apis/apps/v1/namespaces/a/deployments/d?dryRun=All",
            DryRun,
            [EVERY; 4],
        ),
        approved("read Secrets", Method::GET, SECRETS, SecretRead, [EVERY; 4]),
        upgrading(approved(
            "port-forward",
            Method::GET,
            "/api/v1/namespaces/a/pods/p/portforward",
            Forward,
            [EVERY; 4],
        )),
        approved(
            "create",
            Method::POST,
            "/api/v1/namespaces/a/configmaps",
            Write,
            [EVERY, APPROVED, NONE, NONE],
        ),
        approved(
            "patch",
            Method::PATCH,
            DEPLOYMENT,
            Write,
            [EVERY, APPROVED, NONE, NONE],
        ),
        approved(
            "scale",
            Method::PATCH,
            "/apis/apps/v1/namespaces/a/deployments/d/scale",
            Write,
            [EVERY, APPROVED, NONE, NONE],
        ),
        approved(
            "write a Secret, which the terminal may read",
            Method::PUT,
            "/api/v1/namespaces/a/secrets/s",
            Write,
            [EVERY, APPROVED, NONE, NONE],
        ),
        approved(
            "delete",
            Method::DELETE,
            POD,
            Write,
            [EVERY, ONLY_EXACT, NONE, NONE],
        ),
        approved(
            "delete a collection",
            Method::DELETE,
            PODS,
            Write,
            [EVERY, ONLY_EXACT, NONE, NONE],
        ),
        approved(
            "evict, which deletes the pod",
            Method::POST,
            "/api/v1/namespaces/a/pods/p/eviction",
            Write,
            [EVERY, ONLY_EXACT, NONE, NONE],
        ),
        approved(
            "a DELETE by the old proxy path, which RBAC calls proxy",
            Method::DELETE,
            "/api/v1/proxy/namespaces/a/pods/p/x",
            Exec,
            [EVERY, ONLY_EXACT, NONE, NONE],
        ),
        upgrading(approved(
            "exec",
            Method::GET,
            "/api/v1/namespaces/a/pods/p/exec?command=sh",
            Exec,
            [EVERY, APPROVED, NONE, NONE],
        )),
        upgrading(approved(
            "attach over SPDY",
            Method::POST,
            "/api/v1/namespaces/a/pods/p/attach?stdin=true",
            Exec,
            [EVERY, APPROVED, NONE, NONE],
        )),
    ]
}

/// Each of [`APPROVALS`] for a request read as `attributes` on the context
/// `c`.
fn approvals_for(attributes: &Attributes) -> [Option<Approval>; 8] {
    let now = Timestamp::now();
    let later = now.checked_add(SignedDuration::from_mins(15)).unwrap();
    let earlier = now.checked_sub(SignedDuration::from_secs(1)).unwrap();
    let mut elsewhere = attributes.clone();
    elsewhere.path.push_str("-other");
    [
        None,
        Some(Approval::once("c", Actor::Terminal, attributes)),
        Some(Approval::once("c", Actor::Terminal, &elsewhere)),
        Some(Approval::once("d", Actor::Terminal, attributes)),
        Some(Approval::once("c", Actor::Agent, attributes)),
        Some(Approval::until("c", Actor::Terminal, later)),
        Some(Approval::until("c", Actor::Terminal, earlier)),
        Some(Approval::until("d", Actor::Terminal, later)),
    ]
}

#[tokio::test]
async fn a_terminal_s_write_and_exec_pass_guarded_only_with_an_approval_that_covers_them() {
    for row in approvals_table() {
        let mut request = Request::builder().method(row.method.clone()).uri(row.uri);
        if row.upgrade {
            request = request.header(UPGRADE, "websocket");
        }
        let sent = request.body(()).unwrap();
        for (column, answers) in COLUMNS.into_iter().zip(row.answers) {
            let policy = column.policy();
            let served = policy.served();
            served.keep(
                "c",
                Some(0),
                "metrics.k8s.io",
                "v1beta1",
                Server::Aggregated,
            );
            served.keep("c", Some(0), "stable.example.com", "v1", Server::Itself);
            let attributes = policy.gate("c", Actor::Terminal).attributes(&sent);
            assert_eq!(attributes.class, row.class, "{} in {column:?}", row.what);
            let approvals = approvals_for(&attributes);
            for ((approval, answer), named) in approvals.into_iter().zip(answers).zip(APPROVALS) {
                let reached = Arc::new(Mutex::new(0));
                let server = {
                    let reached = Arc::clone(&reached);
                    tower::service_fn(move |_: Request<()>| {
                        *reached.lock().unwrap() += 1;
                        async { Ok::<_, Infallible>(()) }
                    })
                };
                let gate = policy.gate("c", Actor::Terminal);
                let service = ServiceBuilder::new()
                    .layer(gate.layer())
                    .layer(gate.recheck())
                    .service(server);
                let mut request = Request::builder()
                    .method(row.method.clone())
                    .uri(row.uri)
                    .body(())
                    .unwrap();
                *request.headers_mut() = sent.headers().clone();
                if let Some(approval) = approval {
                    request.extensions_mut().insert(approval);
                }
                let answered = service.oneshot(request).await;
                let got = if answered.is_ok() { Pass } else { Block };
                assert_eq!(got, answer, "{} with {named} in {column:?}", row.what);
                let expected = usize::from(answer == Pass);
                assert_eq!(
                    *reached.lock().unwrap(),
                    expected,
                    "{} with {named}",
                    row.what
                );
                if let Err(blocked) = answered {
                    let reason = blocked
                        .downcast_ref::<twigo_ipc::Blocked>()
                        .map(|blocked| blocked.reason);
                    let wanted = match column {
                        Column::In(Mode::ReadOnly) => BlockReason::Mode,
                        Column::Unmarked => BlockReason::Unmarked,
                        Column::In(_) => BlockReason::NoApproval,
                    };
                    assert_eq!(
                        reason,
                        Some(wanted),
                        "{} with {named} in {column:?}",
                        row.what
                    );
                }
            }
        }
    }
}

/// Holds each request until `release`, as the stream counter holds one
/// while its budget is full.
#[derive(Clone)]
struct Hold<S> {
    inner: S,
    release: Arc<tokio::sync::Notify>,
}

impl<S> tower::Service<Request<()>> for Hold<S>
where
    S: tower::Service<Request<()>> + Clone + Send + 'static,
    S::Future: Send,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future =
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<S::Response, S::Error>> + Send>>;

    fn poll_ready(
        &mut self,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), S::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<()>) -> Self::Future {
        let (inner, release) = (self.inner.clone(), Arc::clone(&self.release));
        Box::pin(async move {
            release.notified().await;
            inner.oneshot(request).await
        })
    }
}

#[tokio::test]
async fn a_relock_stops_an_approved_request_that_waited_below_the_gate() {
    let policy = policy_in(Mode::Guarded);
    let write = Request::post("/api/v1/namespaces/a/configmaps")
        .body(())
        .unwrap();
    let approval = Approval::once("c", Actor::Terminal, &Attributes::of(&write));
    let reached = Arc::new(Mutex::new(0));
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = policy.gate("c", Actor::Terminal);
    let server = {
        let reached = Arc::clone(&reached);
        tower::service_fn(move |_: Request<()>| {
            *reached.lock().unwrap() += 1;
            async { Ok::<_, Infallible>(()) }
        })
    };
    let service = ServiceBuilder::new()
        .layer(gate.layer())
        .layer_fn(|inner| Hold {
            inner,
            release: Arc::clone(&release),
        })
        .layer(gate.recheck())
        .service(server);
    let mut request = Request::post("/api/v1/namespaces/a/configmaps")
        .body(())
        .unwrap();
    request.extensions_mut().insert(approval);
    let waiting = tokio::spawn(service.oneshot(request));
    tokio::task::yield_now().await;
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    release.notify_one();
    let blocked = waiting.await.unwrap().unwrap_err();
    let blocked = blocked.downcast_ref::<twigo_ipc::Blocked>().unwrap();
    assert_eq!(blocked.reason, BlockReason::Mode);
    assert_eq!(*reached.lock().unwrap(), 0);
}
