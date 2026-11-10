//! What a request asks for, read as the API server reads it
//! ([`NewRequestInfo`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/request/requestinfo.go#L127-L274)),
//! and its class (ARCHITECTURE 6.4): what a request cannot be read as harmless
//! counts as the stricter class.

use http::header::{ACCEPT, UPGRADE};
use http::{HeaderMap, Method, Request};
use percent_encoding::percent_decode_str;
use twigo_ipc::RequestClass;

/// The POSTs that only ask a question, by group and resource.
const REVIEWS: [(&str, &str); 3] = [
    ("authorization.k8s.io", "selfsubjectaccessreviews"),
    ("authorization.k8s.io", "selfsubjectrulesreviews"),
    ("authentication.k8s.io", "selfsubjectreviews"),
];

/// The groups whose creates only answer, and never read `dryRun`: a review of
/// someone else would get the same answer with it as without.
const ANSWERS: [&str; 2] = ["authorization.k8s.io", "authentication.k8s.io"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attributes {
    /// As RBAC names it: `get`, `list`, `watch`, `create`, `update`, `patch`,
    /// `delete`, `deletecollection`, `proxy`; a request that names no
    /// resource has its method in lower case.
    pub verb: String,
    pub resource: Option<String>,
    pub subresource: Option<String>,
    pub namespace: Option<String>,
    pub name: Option<String>,
    /// The decoded path.
    pub path: String,
    pub class: RequestClass,
    /// Whether it deletes, which asks each time with the context's name
    /// typed and which no lasting approval covers (ARCHITECTURE 6.4): a
    /// `DELETE`, whatever RBAC calls it, as the old proxy path calls every
    /// method `proxy`, and a pod's eviction, which deletes the pod.
    pub deletes: bool,
}

impl Attributes {
    /// A request about to be sent, by its path from the API server's root.
    pub fn of<B>(request: &Request<B>) -> Self {
        let uri = request.uri();
        let path = percent_decode_str(uri.path())
            .decode_utf8_lossy()
            .into_owned();
        let query = Query(uri.query().unwrap_or_default());
        let parts = Parts::of(&path);
        let verb = parts.verb(request.method(), &query);
        let class = parts.class(request.method(), request.headers(), &query);
        let deletes = *request.method() == Method::DELETE || parts.evicts();
        Self {
            verb,
            resource: parts.resource.map(str::to_owned),
            subresource: parts.subresource.map(str::to_owned),
            namespace: parts.namespace.map(str::to_owned),
            name: parts.name.map(str::to_owned),
            path,
            class,
            deletes,
        }
    }

    /// What a command is about to do, by what RBAC calls it. It names no
    /// `Accept` header, so reading a Secret counts as reading its values.
    pub fn action(
        verb: &str,
        resource: &str,
        subresource: Option<&str>,
        namespace: Option<&str>,
        name: Option<&str>,
    ) -> Self {
        // RBAC's names carry no group here, so `pods` means the core's.
        let parts = Parts {
            group: Some(""),
            resource: Some(resource),
            subresource,
            ..Parts::default()
        };
        let class = parts.session_class(verb == "get").unwrap_or(match verb {
            "get" | "list" | "watch" if resource == "secrets" => RequestClass::SecretRead,
            "get" | "list" | "watch" => RequestClass::Read,
            _ => RequestClass::Write,
        });
        Self {
            verb: verb.to_owned(),
            resource: Some(resource.to_owned()),
            subresource: subresource.map(str::to_owned),
            namespace: namespace.map(str::to_owned),
            name: name.map(str::to_owned),
            path: String::new(),
            class,
            deletes: matches!(verb, "delete" | "deletecollection") || parts.evicts(),
        }
    }

    /// Whether what it asks of a Secret is answered with the Secret: a write's
    /// answer is what it stored, values included, and an empty patch stores
    /// nothing new.
    pub(crate) fn writes_a_secret(&self) -> bool {
        self.class == RequestClass::Write && self.resource.as_deref() == Some("secrets")
    }

    /// Whether it opens an exec, an attach or a port-forward of a pod, which
    /// kubectl sends over WebSocket as a `GET` and, refused, again over SPDY
    /// as a `POST`: RBAC's `get` and `create` of one thing
    /// ([`StreamWithContext`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/remotecommand/fallback.go#L53-L60),
    /// [`Dial`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/portforward/fallback_dialer.go#L70-L78)).
    pub fn opens_a_pod_stream(&self) -> bool {
        self.path.starts_with("/api/")
            && matches!(self.verb.as_str(), "get" | "create")
            && self.resource.as_deref() == Some("pods")
            && matches!(
                self.subresource.as_deref(),
                Some("exec" | "attach" | "portforward")
            )
    }

    /// As people and `kubectl` name it: `pods/web-1/exec in default`.
    pub fn target(&self) -> String {
        let Some(resource) = &self.resource else {
            return self.path.clone();
        };
        let mut target = resource.clone();
        for part in [&self.name, &self.subresource].into_iter().flatten() {
            target.push('/');
            target.push_str(part);
        }
        if let Some(namespace) = &self.namespace {
            target.push_str(" in ");
            target.push_str(namespace);
        }
        target
    }
}

struct Query<'a>(&'a str);

impl Query<'_> {
    fn values(&self, name: &str) -> impl Iterator<Item = String> {
        form_urlencoded::parse(self.0.as_bytes())
            .filter(move |(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }

    /// How the API server reads `watch`: its first value is false only when
    /// it is `0` or `false` in any case.
    fn watch(&self) -> bool {
        self.values("watch")
            .next()
            .is_some_and(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
    }

    /// `dryRun` takes only `All`, and kube-apiserver refuses any other value
    /// ([`ValidateDryRun`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/validation/validation.go#L233-L242)),
    /// which an aggregated server may not, so anything else is a write.
    fn dry_run(&self) -> bool {
        let mut values = self.values("dryRun").peekable();
        values.peek().is_some() && values.all(|value| value == "All")
    }

    /// Whether `includeObject` keeps a Table's objects and their metadata
    /// out: only `None` does, as `Metadata` is what it defaults to
    /// ([`asTable`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L389-L409)).
    fn table_without_objects(&self) -> bool {
        let mut values = self.values("includeObject").peekable();
        values.peek().is_some() && values.all(|value| value == "None")
    }
}

#[derive(Default)]
struct Parts<'a> {
    /// A path a server or a proxy in front of it may clean into another, so
    /// nothing can be said of what it names.
    unclear: bool,
    /// Under `/api/{version}/proxy/`, which proxies whatever follows.
    proxy_prefix: bool,
    watch_prefix: bool,
    group: Option<&'a str>,
    namespace: Option<&'a str>,
    resource: Option<&'a str>,
    name: Option<&'a str>,
    subresource: Option<&'a str>,
}

impl<'a> Parts<'a> {
    fn of(path: &'a str) -> Self {
        let trimmed = path.trim_matches('/');
        if trimmed.is_empty() {
            return Self::default();
        }
        let all: Vec<&str> = trimmed.split('/').collect();
        let unclear = all.iter().any(|part| matches!(*part, "" | "." | ".."));
        let not_a_resource = Self {
            unclear,
            ..Self::default()
        };
        let (group, rest) = match all.as_slice() {
            ["api", rest @ ..] if rest.len() >= 2 => ("", rest),
            ["apis", group, rest @ ..] if rest.len() >= 2 => (*group, rest),
            _ => return not_a_resource,
        };
        // Past the version.
        let mut rest = &rest[1..];
        let special = rest.first().copied();
        let (proxy_prefix, watch_prefix) = (special == Some("proxy"), special == Some("watch"));
        if proxy_prefix || watch_prefix {
            rest = &rest[1..];
        }
        let mut namespace = None;
        if let ["namespaces", named, more @ ..] = rest {
            namespace = Some(*named);
            if !matches!(more.first(), None | Some(&("status" | "finalize"))) {
                rest = more;
            }
        }
        let name = rest.get(1).copied();
        Self {
            unclear,
            proxy_prefix,
            watch_prefix,
            group: Some(group),
            namespace,
            resource: rest.first().copied(),
            name,
            subresource: if proxy_prefix {
                None
            } else {
                rest.get(2).copied()
            },
        }
    }

    fn verb(&self, method: &Method, query: &Query<'_>) -> String {
        if self.proxy_prefix {
            return "proxy".to_owned();
        }
        if self.watch_prefix {
            return "watch".to_owned();
        }
        if self.resource.is_none() {
            return method.as_str().to_ascii_lowercase();
        }
        let named = self.name.is_some();
        match *method {
            Method::GET | Method::HEAD if named => "get",
            Method::GET | Method::HEAD if query.watch() => "watch",
            Method::GET | Method::HEAD => "list",
            Method::POST => "create",
            Method::PUT => "update",
            Method::PATCH => "patch",
            Method::DELETE if named => "delete",
            Method::DELETE => "deletecollection",
            _ => return method.as_str().to_ascii_lowercase(),
        }
        .to_owned()
    }

    fn class(&self, method: &Method, headers: &HeaderMap, query: &Query<'_>) -> RequestClass {
        let upgrade = headers.contains_key(UPGRADE);
        let plain_get = *method == Method::GET && !upgrade;
        if self.unclear || self.proxy_prefix || *method == Method::CONNECT {
            return RequestClass::Exec;
        }
        if let Some(class) = self.session_class(plain_get) {
            return class;
        }
        if upgrade {
            return RequestClass::Exec;
        }
        if matches!(*method, Method::GET | Method::HEAD) {
            return if self.resource == Some("secrets") && carries_values(headers, query) {
                RequestClass::SecretRead
            } else {
                RequestClass::Read
            };
        }
        if *method == Method::POST && self.is_review() {
            return RequestClass::Read;
        }
        if self.is_dry_run(method, query) {
            // Answered with what it would store, a Secret's values included.
            return if self.resource == Some("secrets") {
                RequestClass::SecretRead
            } else {
                RequestClass::DryRun
            };
        }
        RequestClass::Write
    }

    /// The class of what reaches into a pod or a node, whatever the method.
    fn session_class(&self, plain_get: bool) -> Option<RequestClass> {
        let core = self.group == Some("");
        match (self.resource?, self.subresource?) {
            (_, "exec" | "attach") => Some(RequestClass::Exec),
            ("pods", "portforward") if core => Some(RequestClass::Forward),
            ("pods" | "services", "proxy") if core && plain_get => Some(RequestClass::Forward),
            (_, "proxy") => Some(RequestClass::Exec),
            _ => None,
        }
    }

    /// `dryRun=All` means a dry run only on a resource itself, and not on a
    /// DELETE. A DELETE with a body takes its options from the body and never
    /// reads the query
    /// ([`DeleteResource`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/delete.go#L95-L127)),
    /// and the layer reads no body. A subresource need not honour it: `token`
    /// mints a token whatever it says
    /// ([`TokenREST`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/core/serviceaccount/storage/token.go#L295)).
    fn is_dry_run(&self, method: &Method, query: &Query<'_>) -> bool {
        matches!(*method, Method::POST | Method::PUT | Method::PATCH)
            && self.resource.is_some()
            && self.subresource.is_none()
            && !self.group.is_some_and(|group| ANSWERS.contains(&group))
            && query.dry_run()
    }

    fn evicts(&self) -> bool {
        self.resource == Some("pods") && self.subresource == Some("eviction")
    }

    fn is_review(&self) -> bool {
        match (self.group, self.resource) {
            (Some(group), Some(resource)) if self.namespace.is_none() && self.name.is_none() => {
                REVIEWS.contains(&(group, resource))
            }
            _ => false,
        }
    }
}

/// Whether the response may carry a Secret's values: unless every media
/// range of `Accept` asks for a Table and the query keeps its objects out. A
/// plain range among them, or no `Accept`, allows them, and so does metadata:
/// `kubectl apply` keeps them in clear in its last-applied annotation
/// (ARCHITECTURE 3.6).
fn carries_values(headers: &HeaderMap, query: &Query<'_>) -> bool {
    let mut ranges = headers
        .get_all(ACCEPT)
        .iter()
        .flat_map(|value| value.to_str().unwrap_or("*/*").split(','))
        .peekable();
    ranges.peek().is_none() || !(query.table_without_objects() && ranges.all(asks_for_a_table))
}

/// Read as kube-apiserver's `goautoneg` reads a range: names match exactly, it
/// trims only spaces, and of two `as` it keeps the last
/// ([`ParseAccept`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/vendor/github.com/munnerz/goautoneg/autoneg.go#L140-L156)).
fn asks_for_a_table(range: &str) -> bool {
    let (mut kind, mut group) = (None, None);
    for parameter in range.split(';').skip(1) {
        let Some((name, value)) = parameter.split_once('=') else {
            continue;
        };
        let slot = match name.trim_matches(' ') {
            "as" => &mut kind,
            "g" => &mut group,
            _ => continue,
        };
        *slot = Some(value.trim_matches(' '));
    }
    kind == Some("Table") && group == Some("meta.k8s.io")
}
