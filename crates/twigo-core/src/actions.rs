//! What the command bus plans (ARCHITECTURE 5.1, 6.4): each action finds
//! what it acts on, says what it will do and what it risks, and holds its
//! run.

mod apply;
mod cordon;
mod delete;
mod dependents;
mod drain;
mod restart;
mod reveal;
mod scale;
mod shell;
mod suspend;
mod trigger;
pub(crate) mod undo;

use std::sync::{Arc, Weak};

pub(crate) use apply::{Prepared, apply, preview};
pub(crate) use cordon::cordon;
pub(crate) use delete::delete;
pub(crate) use drain::drain;
use http::Method;
use http::header::CONTENT_TYPE;
pub(crate) use restart::restart;
pub(crate) use reveal::reveal;
pub(crate) use scale::scale;
use serde_json::Value;
pub(crate) use shell::{containers, shell};
pub(crate) use suspend::suspend;
pub(crate) use trigger::trigger;
use twigo_cache::hub::Resource;
use twigo_ipc::{ErrorKind, IpcError, ObjectRef, ResourceRef};
use twigo_kube::client::Clients;
use twigo_policy::Attributes;
pub(crate) use undo::undo;

use crate::Core;

pub(crate) const MERGE_PATCH: &str = "application/merge-patch+json";
pub(crate) const STRATEGIC_MERGE_PATCH: &str = "application/strategic-merge-patch+json";

/// How many times a write tied to what it read reads again after losing to
/// another write, before it gives up.
pub(crate) const ATTEMPTS: usize = 5;

/// An object a plan acts on, from what the webview named.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub context: String,
    pub resource: Resource,
    /// None for a cluster-scoped object.
    pub namespace: Option<String>,
    pub name: String,
    pub path: String,
}

impl Target {
    /// Refused where a name can be no path segment, or a namespaced
    /// resource names no namespace.
    pub(crate) fn of(core: &Core, space: &str, target: ResourceRef) -> Result<Self, IpcError> {
        let context = core.context(space)?;
        let resource = Resource {
            group: target.gvr.group,
            version: target.gvr.version,
            resource: target.gvr.resource,
            namespaced: target.namespaced,
        };
        Self::in_context(context, resource, target.namespace, target.name)
    }

    pub(crate) fn in_context(
        context: String,
        resource: Resource,
        namespace: Option<String>,
        name: String,
    ) -> Result<Self, IpcError> {
        let namespace = namespace.filter(|_| resource.namespaced);
        let path = resource.object_path(namespace.as_deref(), &name)?;
        Ok(Self {
            context,
            resource,
            namespace,
            name,
            path,
        })
    }

    /// Whether it is of `group`'s `resources`.
    pub(crate) fn is(&self, group: &str, resources: &[&str]) -> bool {
        self.resource.group == group && resources.contains(&self.resource.resource.as_str())
    }

    /// ` in default`, or nothing for a cluster-scoped object.
    pub(crate) fn place(&self) -> String {
        self.namespace
            .as_deref()
            .map(|namespace| format!(" in {namespace}"))
            .unwrap_or_default()
    }

    /// `kubectl --context <context> <words> [-n <namespace>]`.
    pub(crate) fn kubectl(&self, words: &[&str]) -> Result<String, IpcError> {
        let mut line = vec!["kubectl", "--context", &self.context];
        line.extend_from_slice(words);
        if let Some(namespace) = &self.namespace {
            line.extend(["-n", namespace]);
        }
        kubectl(&line)
    }

    /// What the gate reads of a request of `method` to its path, or to one
    /// of its subresources.
    pub(crate) fn attributes(&self, method: Method, subresource: Option<&str>) -> Attributes {
        attributes(method, &self.subpath(subresource))
    }

    pub(crate) fn subpath(&self, subresource: Option<&str>) -> String {
        match subresource {
            Some(subresource) => format!("{}/{subresource}", self.path),
            None => self.path.clone(),
        }
    }
}

/// What the gate reads of a request of `method` to `path`.
pub(crate) fn attributes(method: Method, path: &str) -> Attributes {
    Attributes::of(
        &http::Request::builder()
            .method(method)
            .uri(path)
            .body(())
            .expect("an object's path makes a request"),
    )
}

/// The object at `path`, as JSON.
pub(crate) async fn get(clients: &Clients, path: &str) -> Result<Value, IpcError> {
    let request = http::Request::get(path)
        .body(Vec::new())
        .expect("an object's path makes a request");
    clients
        .api
        .request(request)
        .await
        .map_err(|error| twigo_kube::errors::request(&error))
}

/// Waits after the try `attempt` of a write that lost to another, longer
/// each time, so a busy object's status settles before the next; nothing
/// after the last.
pub(crate) async fn lost(attempt: usize) {
    if attempt + 1 < ATTEMPTS {
        tokio::time::sleep(std::time::Duration::from_millis(50 << attempt)).await;
    }
}

/// Sends `patch` to `path` as of `read`, the object just read: with its
/// resourceVersion, so a write in between makes it fail with a `409`
/// instead of being lost to it. `None` on that `409`.
pub(crate) async fn patch_as_of(
    clients: &Clients,
    path: &str,
    content_type: &str,
    patch: &Value,
    read: &Value,
) -> Result<Option<Value>, IpcError> {
    let mut patch = patch.clone();
    patch["metadata"]["resourceVersion"] = read["metadata"]["resourceVersion"].clone();
    match clients
        .api
        .request::<Value>(write(Method::PATCH, path, content_type, &patch))
        .await
    {
        Ok(answer) => Ok(Some(answer)),
        Err(kube::Error::Api(status)) if status.code == 409 => Ok(None),
        Err(error) => Err(twigo_kube::errors::request(&error)),
    }
}

/// Refuses a run whose read found another object than its plan's: one of
/// the same name made since, whose state the plan never showed.
pub(crate) fn same(object: &Value, uid: &str, what: &str, sent: &str) -> Result<(), IpcError> {
    if object["metadata"]["uid"].as_str() == Some(uid) {
        return Ok(());
    }
    Err(IpcError::new(
        ErrorKind::Conflict,
        format!(
            "{} was replaced since Twigo asked, so it {sent}",
            sentence(what)
        ),
    ))
}

/// A request that sends `body` as `content_type`.
pub(crate) fn write(
    method: Method,
    path: &str,
    content_type: &str,
    body: &Value,
) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .method(method)
        .uri(path)
        .header(CONTENT_TYPE, content_type)
        .body(serde_json::to_vec(body).expect("JSON serializes"))
        .expect("an object's path makes a request")
}

/// The clients a run sends with, refused once its context names another
/// cluster than when it was planned.
pub(crate) async fn clients_for(
    core: &Weak<Core>,
    context: &str,
    connection: Option<u64>,
    sent: &str,
) -> Result<(Arc<Core>, Arc<Clients>), IpcError> {
    let core = core
        .upgrade()
        .ok_or_else(|| IpcError::new(ErrorKind::Unavailable, "Twigo is quitting"))?;
    let clients = core
        .clients(context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    if clients.connection() != connection {
        return Err(IpcError::new(
            ErrorKind::Conflict,
            format!("{context} names another cluster now than when Twigo asked, so it {sent}"),
        ));
    }
    Ok((core, clients))
}

/// An object as a plan lists it.
pub(crate) fn object_ref(object: &Value) -> ObjectRef {
    let api_version = object["apiVersion"].as_str().unwrap_or_default();
    let (group, version) = api_version.rsplit_once('/').unwrap_or(("", api_version));
    let metadata = &object["metadata"];
    ObjectRef {
        group: group.to_owned(),
        version: version.to_owned(),
        kind: object["kind"].as_str().unwrap_or_default().to_owned(),
        namespace: metadata["namespace"].as_str().map(str::to_owned),
        name: metadata["name"].as_str().unwrap_or_default().to_owned(),
    }
}

/// A kind as a sentence names it: `pod`, `stateful set`, `API service`.
pub(crate) fn kind_words(kind: &str) -> String {
    let chars: Vec<char> = kind.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    for (index, &c) in chars.iter().enumerate() {
        let starts = index > 0
            && c.is_uppercase()
            && (chars[index - 1].is_lowercase()
                || chars.get(index + 1).is_some_and(|next| next.is_lowercase()));
        if starts && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        word.push(c);
    }
    words.push(word);
    words
        .into_iter()
        .map(|word| {
            let acronym = word.chars().count() > 1 && word.chars().all(|c| !c.is_lowercase());
            if acronym { word } else { word.to_lowercase() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `count` of a kind's words, as a sentence counts them: `1 pod`, `3 network
/// policies`, `2 endpoints`.
pub(crate) fn counted(count: usize, words: &str) -> String {
    if count == 1 {
        format!("1 {words}")
    } else {
        format!("{count} {}", plural(words))
    }
}

/// A kind's words for more than one: `pods`, `network policies`.
pub(crate) fn plural(words: &str) -> String {
    if words.ends_with("ss") || words.ends_with('x') || words.ends_with("ch") {
        format!("{words}es")
    } else if words.ends_with('s') {
        words.to_owned()
    } else if let Some(stem) = words.strip_suffix('y')
        && !stem.ends_with(['a', 'e', 'o', 'u'])
    {
        format!("{stem}ies")
    } else {
        format!("{words}s")
    }
}

/// `text` with its first letter in capitals, to start a sentence.
pub(crate) fn sentence(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// A kubectl command line, each word quoted as a POSIX shell reads it.
pub(crate) fn kubectl(words: &[&str]) -> Result<String, IpcError> {
    shlex::try_join(words.iter().copied()).map_err(|error| {
        IpcError::new(
            ErrorKind::InvalidInput,
            format!("no shell can take these words: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_reads_as_words_and_keeps_its_acronyms() {
        for (kind, words) in [
            ("Pod", "pod"),
            ("StatefulSet", "stateful set"),
            ("PersistentVolumeClaim", "persistent volume claim"),
            ("APIService", "API service"),
            ("CSIDriver", "CSI driver"),
            ("IPAddress", "IP address"),
            ("Ec2NodeClass", "ec2 node class"),
        ] {
            assert_eq!(kind_words(kind), words, "{kind}");
        }
    }

    #[test]
    fn a_count_of_a_kind_reads_as_english_counts_it() {
        for (count, words, counted_words) in [
            (1, "pod", "1 pod"),
            (3, "pod", "3 pods"),
            (2, "network policy", "2 network policies"),
            (2, "gateway", "2 gateways"),
            (2, "ingress", "2 ingresses"),
            (2, "storage class", "2 storage classes"),
            (2, "endpoints", "2 endpoints"),
            (2, "API service", "2 API services"),
        ] {
            assert_eq!(counted(count, words), counted_words);
        }
    }

    #[test]
    fn a_kubectl_line_quotes_only_what_a_shell_would_split() {
        assert_eq!(
            kubectl(&["kubectl", "--context", "kind-a", "delete", "pods", "web-1"]).unwrap(),
            "kubectl --context kind-a delete pods web-1"
        );
        assert_eq!(
            kubectl(&[
                "kubectl",
                "--context",
                "my cluster",
                "-o",
                "go-template={{.x}}"
            ])
            .unwrap(),
            "kubectl --context 'my cluster' -o 'go-template={{.x}}'"
        );
    }
}
