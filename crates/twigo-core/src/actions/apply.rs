//! Applies an edit (ARCHITECTURE 6.5): a preview builds the apply
//! configuration ([`twigo_kube::apply`]), dry-runs it and keeps what it
//! prepared in Rust for the window that asked; the plan of its id sends
//! exactly that, once.
//!
//! The configuration holds a Secret's real values, since Twigo may own keys
//! it applied before, so nothing built from it leaves Rust unmasked: both
//! sides of the diff go through [`for_view`], warnings and error text are
//! scrubbed of every value it knows, what the dry-run's answer adds
//! included, whole tokens only, a plan names no value, and a Secret's
//! `kubectl` line carries no body, so it stops being runnable at `-f -`,
//! where the configuration would go on stdin.
//!
//! A merge patch cannot address a list element, so a removal inside a list
//! sends the outermost list on its path whole, as it stands after the
//! apply, under the `resourceVersion` the apply returned.
//!
//! What an apply cannot express goes by one merge patch instead, carrying
//! the changes and the removals together, field manager `twigo-edit`
//! ([`Combined`]): a list map reordered, a duplicated key touched, or an
//! edit whose apply answers `422` while its combined patch is clean, as the
//! server validates an apply with the old field still there.
//!
//! A `resourceVersion` moves on every status write, so for a resource with a
//! `status` subresource only [`comparable`] says an object changed: the
//! preview holds to the server's version when only what a status write moves
//! has, and a run that loses to one reads the object and sends again.

use std::collections::BTreeSet;
use std::sync::Weak;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use http::Method;
use http::header::WARNING;
use http_body_util::BodyExt;
use kube::Client;
use kube::api::{DeleteParams, Patch, PatchParams, Preconditions, PropagationPolicy};
use kube::client::Body;
use kube::core::{GroupVersionKind, Request, Status};
use serde_json::{Value, json};
use twigo_cache::hub::Resource;
use twigo_ipc::{
    Affected, ApplyConflict, ApplyPreviewed, ApplyRequest, ApplyStrategy, ErrorKind, IpcError,
    OpenedEdit, PreviewId, Resource as Served,
};
use twigo_kube::apply::{
    self, Combined, EDIT_FIELD_MANAGER, Edit, FIELD_MANAGER, Path, comparable, merge_patch,
    still_has, without,
};
use twigo_kube::client::Clients;
use twigo_kube::discovery::Discovery;
use twigo_kube::errors;
use twigo_kube::openapi::Document;
use twigo_policy::Attributes;
use twigo_policy::friction::Risk;
use twigo_policy::redact::{for_view, is_mask};

use super::dependents::{Deleted, dependents};
use super::{
    ATTEMPTS, Target, attributes, clients_for, get, kind_words, kubectl, lost, sentence, write,
};
use crate::Core;
use crate::bus::{Finished, Planned, Progress};

/// What takes the place of a value in a message.
const HIDDEN: &str = "<hidden>";

/// What a preview prepared, sent by the plan of its id.
pub(crate) struct Prepared {
    pub context: String,
    pub path: String,
    pub writes: Vec<Attributes>,
    connection: Option<u64>,
    target: Target,
    /// `deployment web`.
    what: String,
    kubectl: String,
    step: Step,
}

enum Step {
    Apply(Box<ApplyStep>),
    Patch(Box<PatchStep>),
    Recreate(Box<RecreateStep>),
}

struct ApplyStep {
    /// None when an apply would neither set nor give up anything.
    config: Option<Value>,
    force: bool,
    /// What the merge patch removes, by path.
    removals: Vec<Path>,
    /// The object as read, what the merge patch is made from when no apply
    /// goes first.
    live: Value,
    /// The `resourceVersion` the merge patch holds to when no apply goes
    /// first.
    lock: Option<String>,
    /// The object as [`comparable`] reads it, for a resource with a `status`
    /// subresource: a run that lost to a write sends again only if it reads
    /// the same.
    comparable: Option<Value>,
    /// Every value a Secret's edit could echo, to scrub from messages.
    secrets: Vec<String>,
}

/// The one merge patch of an edit no apply can express.
struct PatchStep {
    patch: Value,
    lock: Option<String>,
    comparable: Option<Value>,
    secrets: Vec<String>,
}

struct RecreateStep {
    uid: String,
    /// The object as edited, without what the server made.
    body: Value,
}

/// Keeps what a preview prepared, once, for the window that asked.
pub(crate) type Keep<'a> = Box<dyn FnOnce(Prepared) -> Result<PreviewId, IpcError> + Send + 'a>;

/// A refusal by the server, sorted by what the person can do about it.
enum Refused {
    Conflicts(Vec<ApplyConflict>),
    Stale(String),
    Immutable(String),
    Other(IpcError),
}

impl Refused {
    /// A refusal of a dry-run, its text scrubbed of `secrets`.
    fn of(error: &kube::Error, secrets: &[String]) -> Self {
        let kube::Error::Api(status) = error else {
            return Self::Other(errors::request(error));
        };
        let message = scrub(&status.message, secrets);
        match status.code {
            409 => {
                let conflicts: Vec<ApplyConflict> = field_conflicts(status)
                    .map(|cause| ApplyConflict {
                        path: cause.field.clone(),
                        manager: conflict_manager(&cause.message),
                    })
                    .collect();
                if conflicts.is_empty() {
                    Self::Stale(message)
                } else {
                    Self::Conflicts(conflicts)
                }
            }
            422 if immutable(status) => Self::Immutable(message),
            500 if invalid_body(&status.message) => {
                Self::Other(IpcError::new(ErrorKind::InvalidInput, message))
            }
            _ => Self::Other(scrubbed(errors::request(error), secrets)),
        }
    }
}

fn causes(status: &Status) -> impl Iterator<Item = &kube::core::response::StatusCause> {
    status
        .details
        .as_ref()
        .into_iter()
        .flat_map(|details| details.causes.iter())
}

fn field_conflicts(status: &Status) -> impl Iterator<Item = &kube::core::response::StatusCause> {
    causes(status).filter(|cause| cause.reason == "FieldManagerConflict")
}

/// `conflict with "kubectl-create" using apps/v1` names its manager in quotes.
fn conflict_manager(message: &str) -> String {
    message.split('"').nth(1).unwrap_or(message).to_owned()
}

/// Whether a `422` is about a field that cannot change: the wording of
/// [`ValidateImmutableField`], a Pod's and a StatefulSet's own, and a
/// Service's `may not change once set`. Any other is an ordinary error.
///
/// [`ValidateImmutableField`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/api/validation/objectmeta.go#L37
fn immutable(status: &Status) -> bool {
    let says = |text: &str| {
        text.contains("immutable")
            || text.contains("may not change")
            || text.contains("updates to statefulset spec")
    };
    says(&status.message) || causes(status).any(|cause| says(&cause.message))
}

/// A body the server cannot read as the kind answers `500`: a field the
/// typed conversion does not know, or a value it cannot convert, which the
/// strict dry-run was asked to name (`failed to create typed patch object`,
/// `failed to convert new object`, kind 1.37, 2026-11-08).
fn invalid_body(message: &str) -> bool {
    message.starts_with("failed to create typed patch object")
        || message.starts_with("failed to convert new object")
}

/// Takes every value in `secrets` out of `text`, where it stands as a whole
/// token, so that a short value does not garble the words around it.
fn scrub(text: &str, secrets: &[String]) -> String {
    secrets.iter().fold(text.to_owned(), |text, value| {
        whole_tokens_replaced(&text, value)
    })
}

fn whole_tokens_replaced(text: &str, value: &str) -> String {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let bounded_start = value.chars().next().is_some_and(word);
    let bounded_end = value.chars().next_back().is_some_and(word);
    let mut replaced = String::with_capacity(text.len());
    let mut from = 0;
    for (index, _) in text.match_indices(value) {
        let end = index + value.len();
        let joins_word = (bounded_start && text[..index].chars().next_back().is_some_and(word))
            || (bounded_end && text[end..].chars().next().is_some_and(word));
        if !joins_word {
            replaced.push_str(&text[from..index]);
            replaced.push_str(HIDDEN);
            from = end;
        }
    }
    replaced.push_str(&text[from..]);
    replaced
}

fn scrubbed(error: IpcError, secrets: &[String]) -> IpcError {
    IpcError {
        message: scrub(&error.message, secrets),
        ..error
    }
}

/// Every value of a Secret's `data` and `stringData` in `objects`, encoded
/// and decoded, the longest first; empty for any other kind.
fn secret_values(objects: &[&Value]) -> Vec<String> {
    let mut values = BTreeSet::new();
    for object in objects {
        for (field, encoded) in [("data", true), ("stringData", false)] {
            let items = object[field].as_object();
            for value in items.into_iter().flat_map(|items| items.values()) {
                let Some(text) = value.as_str().filter(|text| !text.is_empty()) else {
                    continue;
                };
                values.insert(text.to_owned());
                if encoded && let Ok(bytes) = STANDARD.decode(text) {
                    values.insert(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
        }
    }
    let mut values: Vec<String> = values
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect();
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values
}

/// Adds what a dry-run's answer holds, known only after it: a warning may
/// echo a value the edit never named, as `stringData`'s in `data`.
fn add_answered(secrets: &mut Vec<String>, answer: &Value) {
    if secrets.is_empty() {
        return;
    }
    secrets.extend(secret_values(&[answer]));
    secrets.sort();
    secrets.dedup();
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
}

/// Refuses a value of a Secret that still reads as a mask but is not the
/// one it was opened with, as `<12 bytes>` would be written.
fn refuse_masks(base: Option<&Value>, edited: &Value) -> Result<(), IpcError> {
    for field in ["data", "stringData"] {
        let items = edited[field].as_object();
        for (key, value) in items.into_iter().flatten() {
            let opened = base.and_then(|base| base[field].get(key));
            if value.as_str().is_some_and(is_mask) && opened != Some(value) {
                return Err(IpcError::new(
                    ErrorKind::InvalidInput,
                    format!(
                        "{key} still holds a masked value, so Twigo would write the mask: give it a value"
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Refuses an edit that names another object than its target.
fn same_object(target: &Target, live: &Value, edited: &Value) -> Result<(), IpcError> {
    let refused = |what: &str, named: &Value, target: String| {
        IpcError::new(
            ErrorKind::InvalidInput,
            format!("the edit names {what} {named}, but it is an edit of {target}"),
        )
    };
    for field in ["apiVersion", "kind"] {
        if edited[field] != live[field] {
            return Err(refused(field, &edited[field], live[field].to_string()));
        }
    }
    if edited["metadata"]["name"] != json!(target.name) {
        return Err(refused(
            "name",
            &edited["metadata"]["name"],
            target.name.clone(),
        ));
    }
    if edited["metadata"]["namespace"].as_str() != target.namespace.as_deref() {
        return Err(refused(
            "namespace",
            &edited["metadata"]["namespace"],
            target.namespace.clone().unwrap_or_default(),
        ));
    }
    Ok(())
}

/// The resource of a manifest, by its apiVersion and kind.
fn manifest_target(
    context: String,
    resources: &[Served],
    edited: &Value,
) -> Result<(Target, bool), IpcError> {
    let api_version = edited["apiVersion"].as_str().unwrap_or_default();
    let (group, version) = api_version.rsplit_once('/').unwrap_or(("", api_version));
    let kind = edited["kind"].as_str().unwrap_or_default();
    let resource = resources
        .iter()
        .find(|resource| resource.gvr.group == group && resource.kind == kind)
        .ok_or_else(|| {
            IpcError::new(
                ErrorKind::NotFound,
                format!("the cluster serves no {kind} in {api_version}"),
            )
        })?;
    let name = edited["metadata"]["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| IpcError::new(ErrorKind::InvalidInput, "the manifest names no object"))?
        .to_owned();
    let namespace = edited["metadata"]["namespace"].as_str().map(str::to_owned);
    let target = Target::in_context(
        context,
        Resource {
            group: group.to_owned(),
            version: version.to_owned(),
            resource: resource.gvr.resource.clone(),
            namespaced: resource.namespaced,
        },
        namespace,
        name,
    )?;
    Ok((target, has_status(resource)))
}

fn has_status(resource: &Served) -> bool {
    resource
        .subresources
        .iter()
        .any(|subresource| subresource == "status")
}

/// The URL of the collection `target` lives in.
fn collection(target: &Target) -> &str {
    target
        .path
        .rsplit_once('/')
        .map_or(target.path.as_str(), |(collection, _)| collection)
}

fn built(error: kube::core::request::Error) -> IpcError {
    IpcError::new(ErrorKind::Internal, error.to_string())
}

fn apply_request(
    target: &Target,
    config: &Value,
    force: bool,
    dry_run: bool,
) -> Result<http::Request<Vec<u8>>, IpcError> {
    let mut params = PatchParams::apply(FIELD_MANAGER).validation_strict();
    params.force = force;
    params.dry_run = dry_run;
    Request::new(collection(target))
        .patch(&target.name, &params, &Patch::Apply(config))
        .map_err(built)
}

fn merge_request(
    target: &Target,
    patch: &Value,
    dry_run: bool,
    manager: &str,
) -> Result<http::Request<Vec<u8>>, IpcError> {
    let params = PatchParams {
        dry_run,
        field_manager: Some(manager.to_owned()),
        ..PatchParams::default()
    };
    Request::new(collection(target))
        .patch(&target.name, &params, &Patch::Merge(patch))
        .map_err(built)
}

/// An answer's object and warnings, or the server's refusal, through
/// `Client::send`, as kube-rs drops the `Warning` headers.
async fn send(
    client: &Client,
    request: http::Request<Vec<u8>>,
) -> Result<(Value, Vec<String>), kube::Error> {
    let response = client.send(request.map(Body::from)).await?;
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await?.to_bytes();
    if !parts.status.is_success() {
        return Err(errors::refused(parts.status, &bytes));
    }
    let warnings = parts
        .headers
        .get_all(WARNING)
        .iter()
        .filter_map(|header| warning_text(header.to_str().ok()?))
        .collect();
    let object = serde_json::from_slice(&bytes).map_err(kube::Error::SerdeError)?;
    Ok((object, warnings))
}

/// The text of a `Warning` header: `299 - "text"`.
fn warning_text(header: &str) -> Option<String> {
    let text = header.splitn(3, ' ').nth(2)?;
    let quoted = text.trim().strip_prefix('"')?.strip_suffix('"')?;
    Some(quoted.replace("\\\"", "\"").replace("\\\\", "\\"))
}

/// `patch` held to `resource_version`, when there is one.
fn locked(patch: &Value, resource_version: Option<&str>) -> Value {
    let mut patch = patch.clone();
    if let Some(version) = resource_version {
        patch["metadata"]["resourceVersion"] = json!(version);
    }
    patch
}

/// The `resourceVersion` an edit holds to: the one it was opened at, or the
/// server's when only what a status write moves has changed since, for a
/// resource with a `status` subresource. A Secret has none, and its masked
/// view cannot tell a changed value of the same size, so it stays strict.
fn held_lock(opened: &OpenedEdit, live: Option<&Value>, status_subresource: bool) -> String {
    match live.and_then(|live| Some((live, resource_version(live)?))) {
        Some((live, version))
            if status_subresource
                && version != opened.lock
                && comparable(&opened.base) == comparable(live) =>
        {
            version.to_owned()
        }
        _ => opened.lock.clone(),
    }
}

/// Sends a write held to `lock`. A `409` that is no field conflict means it
/// lost to another write: when `comparable` says the object reads the same,
/// it sends again on the new version, up to [`ATTEMPTS`] times; otherwise
/// that `409` stands.
async fn send_held(
    clients: &Clients,
    target: &Target,
    comparable_to: Option<&Value>,
    mut lock: Option<String>,
    request: impl Fn(Option<&str>) -> Result<http::Request<Vec<u8>>, IpcError>,
) -> Result<Result<(Value, Vec<String>), kube::Error>, IpcError> {
    let mut last = None;
    for attempt in 0..ATTEMPTS {
        match send(&clients.api, request(lock.as_deref())?).await {
            Err(kube::Error::Api(status))
                if status.code == 409 && field_conflicts(&status).next().is_none() =>
            {
                let Some(expected) = comparable_to else {
                    return Ok(Err(kube::Error::Api(status)));
                };
                let now = get(clients, &target.path).await?;
                if comparable(&now) != *expected {
                    return Ok(Err(kube::Error::Api(status)));
                }
                lock = resource_version(&now).map(str::to_owned);
                last = Some(status);
                lost(attempt).await;
            }
            sent => return Ok(sent),
        }
    }
    Ok(Err(kube::Error::Api(
        last.expect("every try that goes on loses to a write"),
    )))
}

fn resource_version(object: &Value) -> Option<&str> {
    object["metadata"]["resourceVersion"].as_str()
}

/// An object as a side of the diff: as the view shows it, without what would
/// only be noise.
fn side(object: Value) -> Value {
    if object.is_null() {
        return object;
    }
    let mut object = for_view(object);
    if let Some(metadata) = object["metadata"].as_object_mut() {
        metadata.remove("resourceVersion");
        metadata.remove("generation");
    }
    object
}

/// Builds and dry-runs an edit, and keeps what it prepared with `keep`.
pub(crate) async fn preview(
    core: &Core,
    window: &str,
    request: ApplyRequest,
) -> Result<ApplyPreviewed, IpcError> {
    let ApplyRequest {
        space,
        opened,
        edited,
        force,
        drop: dropped,
    } = request;
    let ticket = core.bus.ticket(window);
    let context = core.context(&space)?;
    let opened_target = opened
        .as_ref()
        .map(|opened| Target::of(core, &space, opened.target.clone()))
        .transpose()?;
    let mut started = opened_target.as_ref().map(|target| {
        core.bus
            .start_preview(window, &target.context, &target.path)
    });
    let clients = core
        .clients(&context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let discovery = Discovery::refresh(&clients.api, None)
        .await
        .map_err(|error| IpcError::from(&error))?
        .expect("discovery asked with no cached answer is answered");
    let resources = discovery.resources();

    let (target, status_subresource) = match opened_target {
        Some(target) => {
            let status = resources
                .iter()
                .find(|resource| {
                    resource.gvr.group == target.resource.group
                        && resource.gvr.resource == target.resource.resource
                })
                .is_some_and(has_status);
            (target, status)
        }
        None => {
            let (target, status) = manifest_target(context.clone(), &resources, &edited)?;
            started = Some(
                core.bus
                    .start_preview(window, &target.context, &target.path),
            );
            (target, status)
        }
    };
    let started = started.expect("a preview's object is known by now");
    let keep: Keep<'_> = Box::new(|prepared| core.bus.keep_preview(ticket, started, prepared));

    let live = match get(&clients, &target.path).await {
        Ok(live) => Some(live),
        Err(error) if error.kind == ErrorKind::NotFound && opened.is_none() => None,
        Err(error) => return Err(error),
    };
    if let (Some(_), Some(live)) = (&opened, &live) {
        same_object(&target, live, &edited)?;
    }
    let secret = target.is("", &["secrets"]);
    if secret {
        refuse_masks(opened.as_ref().map(|opened| &opened.base), &edited)?;
    }
    let lock = opened
        .as_ref()
        .map(|opened| held_lock(opened, live.as_ref(), status_subresource));

    let group = target.resource.group.clone();
    let version = target.resource.version.clone();
    let kind = edited["kind"].as_str().unwrap_or_default().to_owned();
    let document = if opened.is_some() || !dropped.is_empty() {
        Some(
            Document::load(&clients.api, &core.openapi, &group, &version)
                .await
                .map_err(|error| IpcError::from(&error))?,
        )
    } else {
        None
    };
    let root = match &document {
        Some(document) => {
            let gvk = GroupVersionKind::gvk(&group, &version, &kind);
            Some(document.shape(&gvk).ok_or_else(|| {
                IpcError::new(
                    ErrorKind::NotFound,
                    format!("the cluster's OpenAPI for {group}/{version} has no kind {kind}"),
                )
            })?)
        }
        None => None,
    };
    let (config, removals, ignored, combined) = match (&opened, &live) {
        (Some(opened), Some(live)) => {
            let built = apply::build(Edit {
                live,
                base: &opened.base,
                edited: &edited,
                root: root.expect("loaded for an edit of an object"),
                status_subresource,
                lock: lock.as_deref().unwrap_or_default(),
                dropped: &dropped,
            })
            .map_err(|foreign| {
                IpcError::new(
                    ErrorKind::Conflict,
                    format!(
                        "Twigo applied this object at {}, and {} of what it owns there does not exist at {version}: open it at that version to change it, or nothing Twigo owns is lost",
                        foreign.version,
                        foreign.paths.join(", ")
                    ),
                )
            })?;
            if built.unchanged() {
                return Ok(ApplyPreviewed::Unchanged {
                    ignored: built.ignored,
                });
            }
            (built.config, built.removals, built.ignored, built.combined)
        }
        _ => {
            let (config, ignored) = apply::manifest(&edited, status_subresource, root, &dropped);
            if config.is_none() {
                return Ok(ApplyPreviewed::Unchanged { ignored });
            }
            (config, Vec::new(), ignored, Combined::None)
        }
    };

    let mut secrets = if secret {
        let mut objects = vec![&edited];
        objects.extend(&config);
        objects.extend(&live);
        secret_values(&objects)
    } else {
        Vec::new()
    };

    let comparable_to = live.as_ref().filter(|_| status_subresource).map(comparable);
    let by_patch = |patch: Value, object: Value, told: Vec<String>, keep| {
        let mut secrets = secrets.clone();
        add_answered(&mut secrets, &object);
        answer_patch(Asked {
            target: &target,
            connection: clients.connection(),
            edited: &edited,
            live: live.as_ref(),
            ignored: ignored.clone(),
            removals: &removals,
            secret,
            secrets,
            comparable: comparable_to.clone(),
            lock: lock.clone(),
            patch,
            object,
            told,
            keep,
        })
    };
    if let Combined::Only(patch) = &combined {
        return match dry_run_patch(&clients, &target, patch, lock.as_deref()).await {
            Ok((object, told)) => by_patch(patch.clone(), object, told, keep),
            Err(error) => {
                answer_refused(
                    Refused::of(&error, &secrets),
                    keep,
                    &clients,
                    &target,
                    &edited,
                    live.as_ref(),
                )
                .await
            }
        };
    }

    let mut warnings = Vec::new();
    let answered = match &config {
        Some(config) => {
            let request = apply_request(&target, config, force, true)?;
            match send(&clients.api, request).await {
                Ok((object, told)) => {
                    warnings = told;
                    add_answered(&mut secrets, &object);
                    Some(object)
                }
                Err(error) => {
                    if let (Combined::Fallback(patch), kube::Error::Api(status)) =
                        (&combined, &error)
                        && status.code == 422
                        && let Ok((object, told)) =
                            dry_run_patch(&clients, &target, patch, lock.as_deref()).await
                    {
                        return by_patch(patch.clone(), object, told, keep);
                    }
                    return answer_refused(
                        Refused::of(&error, &secrets),
                        keep,
                        &clients,
                        &target,
                        &edited,
                        live.as_ref(),
                    )
                    .await;
                }
            }
        }
        None => None,
    };
    let removals: Vec<Path> = match &answered {
        Some(object) => removals
            .into_iter()
            .filter(|removal| still_has(object, removal))
            .collect(),
        None => removals,
    };
    let empty = json!({});
    let live_or_empty = live.as_ref().unwrap_or(&empty);
    if !removals.is_empty() {
        let patch = locked(
            &merge_patch(live_or_empty, &removals)
                .expect("every removal was read in the live object"),
            lock.as_deref(),
        );
        let request = merge_request(&target, &patch, true, FIELD_MANAGER)?;
        match send(&clients.api, request).await {
            Ok((object, told)) => {
                warnings.extend(told);
                add_answered(&mut secrets, &object);
            }
            Err(error) => {
                return answer_refused(
                    Refused::of(&error, &secrets),
                    keep,
                    &clients,
                    &target,
                    &edited,
                    live.as_ref(),
                )
                .await;
            }
        }
    }

    let result = without(answered.as_ref().unwrap_or(live_or_empty), &removals);
    let kind_name = target.resource.name();
    let what = format!(
        "{} {}",
        kind_words(edited["kind"].as_str().unwrap_or(&target.resource.resource)),
        target.name
    );
    let patch_for_line = merge_patch(answered.as_ref().unwrap_or(live_or_empty), &removals)
        .map(|patch| locked(&patch, lock.as_deref().filter(|_| config.is_none())));
    let line = apply_line(
        &target,
        config.as_ref(),
        force,
        patch_for_line.as_ref(),
        &kind_name,
        secret,
    )?;
    let mut writes = Vec::new();
    if config.is_some() {
        writes.push(target.attributes(Method::PATCH, None));
    }
    if !removals.is_empty() {
        writes.push(target.attributes(Method::PATCH, None));
    }
    let warnings: Vec<String> = warnings.iter().map(|text| scrub(text, &secrets)).collect();
    let live_view = side(live.clone().unwrap_or(Value::Null));
    let id = keep(Prepared {
        context: target.context.clone(),
        path: target.path.clone(),
        writes,
        connection: clients.connection(),
        kubectl: line,
        what,
        step: Step::Apply(Box::new(ApplyStep {
            config,
            force,
            removals: removals.clone(),
            live: live.unwrap_or(Value::Null),
            lock,
            comparable: comparable_to,
            secrets,
        })),
        target,
    })?;
    Ok(ApplyPreviewed::Ready {
        id,
        live: live_view,
        result: side(result),
        warnings,
        removals: removals.iter().map(ToString::to_string).collect(),
        ignored,
        strategy: ApplyStrategy::ServerSideApply,
    })
}

/// A refused dry-run as the webview hears it, preparing a recreate for a Pod
/// or a Job with a field that cannot change, when the edit can be created.
async fn answer_refused(
    refused: Refused,
    keep: Keep<'_>,
    clients: &Clients,
    target: &Target,
    edited: &Value,
    live: Option<&Value>,
) -> Result<ApplyPreviewed, IpcError> {
    match refused {
        Refused::Conflicts(conflicts) => Ok(ApplyPreviewed::Conflicts { conflicts }),
        Refused::Stale(message) => Ok(ApplyPreviewed::Stale { message }),
        Refused::Other(error) => Err(error),
        Refused::Immutable(message) => {
            let job = target.is("batch", &["jobs"]);
            let pod = target.is("", &["pods"]);
            let Some(live) = live.filter(|_| job || pod) else {
                return Ok(ApplyPreviewed::Immutable {
                    message,
                    recreate: None,
                });
            };
            if let Some(owner) = pod.then(|| controller_owner(live)).flatten() {
                return Ok(ApplyPreviewed::Immutable {
                    message: format!(
                        "{message}. It belongs to {owner}, which would replace it: edit that instead"
                    ),
                    recreate: None,
                });
            }
            let prepared = recreation(target, edited, live, clients.connection(), job)?;
            if let Step::Recreate(step) = &prepared.step
                && let Err(refused) = can_create(clients, target, &step.body).await
            {
                return Ok(ApplyPreviewed::Immutable {
                    message: format!(
                        "{message}. Nor can it be created from this edit: {}",
                        refused.message
                    ),
                    recreate: None,
                });
            }
            Ok(ApplyPreviewed::Immutable {
                message,
                recreate: Some(keep(prepared)?),
            })
        }
    }
}

/// What owns a Pod as its controller, as a sentence names it.
fn controller_owner(live: &Value) -> Option<String> {
    let owners = live["metadata"]["ownerReferences"].as_array()?;
    let owner = owners.iter().find(|owner| owner["controller"] == true)?;
    Some(format!(
        "{} {}",
        kind_words(owner["kind"].as_str().unwrap_or_default()),
        owner["name"].as_str().unwrap_or_default()
    ))
}

/// Whether a create of `body` would be accepted, by the server's dry-run:
/// an invalid body answers `422` even with the name taken, and a valid one
/// `409` AlreadyExists (kind 1.37, 2026-11-08).
async fn can_create(clients: &Clients, target: &Target, body: &Value) -> Result<(), IpcError> {
    let path = format!(
        "{}?dryRun=All&fieldManager={FIELD_MANAGER}&fieldValidation=Strict",
        collection(target)
    );
    match send(
        &clients.api,
        write(Method::POST, &path, "application/json", body),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(kube::Error::Api(status)) if status.code == 409 && status.reason == "AlreadyExists" => {
            Ok(())
        }
        Err(error) => Err(errors::request(&error)),
    }
}

/// The delete and the create that replace a Pod or a Job whose edit the
/// server refused.
fn recreation(
    target: &Target,
    edited: &Value,
    live: &Value,
    connection: Option<u64>,
    job: bool,
) -> Result<Prepared, IpcError> {
    let uid = live["metadata"]["uid"]
        .as_str()
        .ok_or_else(|| IpcError::new(ErrorKind::Internal, format!("{} has no uid", target.name)))?
        .to_owned();
    let body = apply::for_create(edited, job);
    let writes = vec![
        target.attributes(Method::DELETE, None),
        attributes(Method::POST, collection(target)),
    ];
    let kind_name = target.resource.name();
    let delete = target.kubectl(&["delete", &kind_name, &target.name])?;
    let printf = kubectl(&["printf", "%s", &body.to_string()])?;
    let create = target.kubectl(&["create", "--field-manager", FIELD_MANAGER, "-f", "-"])?;
    Ok(Prepared {
        context: target.context.clone(),
        path: target.path.clone(),
        writes,
        connection,
        target: target.clone(),
        what: format!(
            "{} {}",
            kind_words(edited["kind"].as_str().unwrap_or(&target.resource.resource)),
            target.name
        ),
        kubectl: format!("{delete} && {printf} | {create}"),
        step: Step::Recreate(Box::new(RecreateStep { uid, body })),
    })
}

/// The kubectl line of an apply and its merge patch; a Secret's stops at
/// `-f -`, where its body would go on stdin.
fn apply_line(
    target: &Target,
    config: Option<&Value>,
    force: bool,
    patch: Option<&Value>,
    kind_name: &str,
    secret: bool,
) -> Result<String, IpcError> {
    let mut lines = Vec::new();
    if let Some(config) = config {
        let manager = format!("--field-manager={FIELD_MANAGER}");
        let mut words = vec!["apply", "--server-side", &manager];
        if force {
            words.push("--force-conflicts");
        }
        words.extend(["-f", "-"]);
        let line = target.kubectl(&words)?;
        lines.push(if secret {
            line
        } else {
            format!(
                "{} | {line}",
                kubectl(&["printf", "%s", &config.to_string()])?
            )
        });
    }
    if let Some(patch) = patch {
        lines.push(patch_line(target, patch, kind_name, FIELD_MANAGER, secret)?);
    }
    Ok(lines.join(" && "))
}

/// The `kubectl patch` line of a merge patch, as it is sent; a Secret's
/// names no body, where a value would be.
fn patch_line(
    target: &Target,
    patch: &Value,
    kind_name: &str,
    manager: &str,
    secret: bool,
) -> Result<String, IpcError> {
    let manager = format!("--field-manager={manager}");
    let body = patch.to_string();
    let mut words = vec!["patch", kind_name, &target.name, "--type=merge", &manager];
    if !secret {
        words.extend(["-p", &body]);
    }
    target.kubectl(&words)
}

/// The dry-run of the one merge patch of an edit.
async fn dry_run_patch(
    clients: &Clients,
    target: &Target,
    patch: &Value,
    lock: Option<&str>,
) -> Result<(Value, Vec<String>), kube::Error> {
    let request = merge_request(target, &locked(patch, lock), true, EDIT_FIELD_MANAGER)
        .expect("a merge patch is a body the server reads");
    send(&clients.api, request).await
}

/// What a preview that goes by one merge patch answers.
struct Asked<'a> {
    target: &'a Target,
    connection: Option<u64>,
    edited: &'a Value,
    live: Option<&'a Value>,
    ignored: Vec<String>,
    removals: &'a [Path],
    secret: bool,
    secrets: Vec<String>,
    comparable: Option<Value>,
    lock: Option<String>,
    patch: Value,
    object: Value,
    told: Vec<String>,
    keep: Keep<'a>,
}

fn answer_patch(asked: Asked<'_>) -> Result<ApplyPreviewed, IpcError> {
    let Asked {
        target,
        connection,
        edited,
        live,
        ignored,
        removals,
        secret,
        secrets,
        comparable,
        lock,
        patch,
        object,
        told,
        keep,
    } = asked;
    let what = format!(
        "{} {}",
        kind_words(edited["kind"].as_str().unwrap_or(&target.resource.resource)),
        target.name
    );
    let kubectl = patch_line(
        target,
        &locked(&patch, lock.as_deref()),
        &target.resource.name(),
        EDIT_FIELD_MANAGER,
        secret,
    )?;
    let warnings: Vec<String> = told.iter().map(|text| scrub(text, &secrets)).collect();
    let live_view = side(live.cloned().unwrap_or(Value::Null));
    let id = keep(Prepared {
        context: target.context.clone(),
        path: target.path.clone(),
        writes: vec![target.attributes(Method::PATCH, None)],
        connection,
        target: target.clone(),
        what,
        kubectl,
        step: Step::Patch(Box::new(PatchStep {
            patch,
            lock,
            comparable,
            secrets,
        })),
    })?;
    Ok(ApplyPreviewed::Ready {
        id,
        live: live_view,
        result: side(object),
        warnings,
        removals: removals.iter().map(ToString::to_string).collect(),
        ignored,
        strategy: ApplyStrategy::MergePatch,
    })
}

/// The plan of a preview, by its id, which takes it.
pub(crate) async fn apply(
    core: &Core,
    window: &str,
    space: String,
    preview: PreviewId,
) -> Result<Planned, IpcError> {
    let prepared = core.bus.take_preview(window, preview, |prepared| {
        core.authorize(&prepared.context, &prepared.writes)
    })?;
    let Prepared {
        context,
        connection,
        target,
        what,
        kubectl,
        writes,
        step,
        ..
    } = prepared;
    let this = core.this.clone();
    let place = target.place();
    let audit_target = writes
        .first()
        .map_or_else(|| what.clone(), Attributes::target);
    let command = "apply";
    Ok(match step {
        Step::Apply(step) => {
            let consequences = if step.removals.is_empty() {
                Vec::new()
            } else {
                vec![format!(
                    "Then a merge patch removes {}.",
                    step.removals
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )]
            };
            let run = Run {
                core: this,
                context: context.clone(),
                connection,
                target,
                what: what.clone(),
                step,
            };
            Planned {
                question: format!("Apply your changes to {what}{place} on {context}?"),
                confirm: "Apply".to_owned(),
                destructive: false,
                consequences,
                affected: Vec::new(),
                kubectl,
                doing: format!("Applying {what}"),
                command,
                target: audit_target,
                writes,
                context,
                connection,
                space: Some(space),
                risk: Risk::Reviewed,
                run: Box::new(move |_| Box::pin(run.run())),
            }
        }
        Step::Patch(step) => {
            let run = PatchRun {
                core: this,
                context: context.clone(),
                connection,
                target,
                what: what.clone(),
                step,
            };
            Planned {
                question: format!("Apply your changes to {what}{place} on {context}?"),
                confirm: "Apply".to_owned(),
                destructive: false,
                consequences: vec![format!(
                    "An apply cannot express this edit, so it goes as one merge patch under field manager {EDIT_FIELD_MANAGER}, as kubectl edit would."
                )],
                affected: Vec::new(),
                kubectl,
                doing: format!("Applying {what}"),
                command,
                target: audit_target,
                writes,
                context,
                connection,
                space: Some(space),
                risk: Risk::Reviewed,
                run: Box::new(move |_| Box::pin(run.run())),
            }
        }
        Step::Recreate(step) => {
            let clients = core
                .clients(&context)
                .await
                .map_err(|error| IpcError::from(&error))?;
            let following = dependents(
                &clients,
                &[Deleted {
                    group: &target.resource.group,
                    resource: &target.resource.resource,
                    namespace: target.namespace.as_deref().unwrap_or_default(),
                    uid: &step.uid,
                }],
            )
            .await;
            let mut consequences = vec![if target.is("batch", &["jobs"]) {
                "It goes with its pods, and a new one with a new uid runs from the start, whatever this one finished.".to_owned()
            } else {
                "It goes, and a new one with a new uid takes its place.".to_owned()
            }];
            consequences.extend(following.unknown);
            let affected = if following.objects.is_empty() {
                Vec::new()
            } else {
                vec![Affected {
                    title: "With it go".to_owned(),
                    objects: following.objects,
                }]
            };
            let run = Recreate {
                core: this,
                context: context.clone(),
                connection,
                target,
                what: what.clone(),
                step,
            };
            Planned {
                question: format!(
                    "Delete {what}{place} on {context} and create it from your edit?"
                ),
                confirm: format!("Delete and recreate {what}"),
                destructive: true,
                consequences,
                affected,
                kubectl,
                doing: format!("Recreating {what}"),
                command: "recreate",
                target: audit_target,
                writes,
                context,
                connection,
                space: Some(space),
                risk: Risk::Lasting,
                run: Box::new(move |progress| Box::pin(run.run(progress))),
            }
        }
    })
}

struct Run {
    core: Weak<Core>,
    context: String,
    connection: Option<u64>,
    target: Target,
    what: String,
    step: Box<ApplyStep>,
}

impl Run {
    async fn run(self) -> Result<Finished, IpcError> {
        let (_, clients) = clients_for(
            &self.core,
            &self.context,
            self.connection,
            "applied nothing",
        )
        .await?;
        let step = &self.step;
        let what = &self.what;
        let target = &self.target;
        let (object, lock, applied) = match &step.config {
            Some(config) => {
                let sent = send_held(
                    &clients,
                    target,
                    step.comparable.as_ref(),
                    step.lock.clone(),
                    |lock| apply_request(target, &locked(config, lock), step.force, false),
                )
                .await?;
                match sent {
                    Ok((object, _)) => {
                        let version = resource_version(&object).map(str::to_owned);
                        (object, version, true)
                    }
                    Err(kube::Error::Api(status)) if status.code == 409 => {
                        return Err(IpcError::new(
                            ErrorKind::Conflict,
                            format!(
                                "{} changed since the diff, so Twigo applied nothing: {}",
                                sentence(what),
                                scrub(&status.message, &step.secrets)
                            ),
                        ));
                    }
                    Err(error) => {
                        return Err(scrubbed(errors::request(&error), &step.secrets));
                    }
                }
            }
            None => (step.live.clone(), step.lock.clone(), false),
        };
        if step.removals.is_empty() {
            return Ok(Finished::Done(format!("Applied {what}")));
        }
        let Some(patch) = merge_patch(&object, &step.removals) else {
            return Ok(Finished::Done(format!("Applied {what}")));
        };
        let baseline = step.comparable.as_ref().map(|_| comparable(&object));
        let sent = send_held(&clients, target, baseline.as_ref(), lock, |lock| {
            merge_request(target, &locked(&patch, lock), false, FIELD_MANAGER)
        })
        .await?;
        match sent {
            Ok(_) if applied => Ok(Finished::Done(format!(
                "Applied {what} and removed {}",
                removals_text(&step.removals)
            ))),
            Ok(_) => Ok(Finished::Done(format!(
                "Removed {} from {what}",
                removals_text(&step.removals)
            ))),
            Err(kube::Error::Api(status)) if status.code == 409 && !applied => Err(IpcError::new(
                ErrorKind::Conflict,
                format!(
                    "{} changed since the diff, so Twigo removed nothing: {}",
                    sentence(what),
                    scrub(&status.message, &step.secrets)
                ),
            )),
            Err(error) => {
                let failed = scrubbed(errors::request(&error), &step.secrets);
                let message = if applied {
                    format!(
                        "Applied {what}, but the merge patch that removes {} failed, so those fields are still there: {}",
                        removals_text(&step.removals),
                        failed.message
                    )
                } else {
                    format!(
                        "The merge patch that removes {} from {what} failed: {}",
                        removals_text(&step.removals),
                        failed.message
                    )
                };
                Err(IpcError::new(failed.kind, message))
            }
        }
    }
}

struct PatchRun {
    core: Weak<Core>,
    context: String,
    connection: Option<u64>,
    target: Target,
    what: String,
    step: Box<PatchStep>,
}

impl PatchRun {
    async fn run(self) -> Result<Finished, IpcError> {
        let (_, clients) = clients_for(
            &self.core,
            &self.context,
            self.connection,
            "applied nothing",
        )
        .await?;
        let step = &self.step;
        let what = &self.what;
        let target = &self.target;
        let sent = send_held(
            &clients,
            target,
            step.comparable.as_ref(),
            step.lock.clone(),
            |lock| {
                merge_request(
                    target,
                    &locked(&step.patch, lock),
                    false,
                    EDIT_FIELD_MANAGER,
                )
            },
        )
        .await?;
        match sent {
            Ok(_) => Ok(Finished::Done(format!("Applied {what}"))),
            Err(kube::Error::Api(status)) if status.code == 409 => Err(IpcError::new(
                ErrorKind::Conflict,
                format!(
                    "{} changed since the diff, so Twigo applied nothing: {}",
                    sentence(what),
                    scrub(&status.message, &step.secrets)
                ),
            )),
            Err(error) => Err(scrubbed(errors::request(&error), &step.secrets)),
        }
    }
}

fn removals_text(removals: &[Path]) -> String {
    removals
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

struct Recreate {
    core: Weak<Core>,
    context: String,
    connection: Option<u64>,
    target: Target,
    what: String,
    step: Box<RecreateStep>,
}

impl Recreate {
    async fn run(self, progress: Progress) -> Result<Finished, IpcError> {
        let (_, clients) = clients_for(
            &self.core,
            &self.context,
            self.connection,
            "deleted nothing",
        )
        .await?;
        let (target, what, step) = (&self.target, &self.what, &self.step);
        if let Err(refused) = can_create(&clients, target, &step.body).await {
            return Err(IpcError::new(
                refused.kind,
                format!(
                    "{} cannot be created from your edit, so Twigo deleted nothing: {}",
                    sentence(what),
                    refused.message
                ),
            ));
        }
        let options = DeleteParams {
            propagation_policy: Some(PropagationPolicy::Background),
            preconditions: Some(Preconditions {
                uid: Some(step.uid.clone()),
                resource_version: None,
            }),
            ..DeleteParams::default()
        };
        let request = write(
            Method::DELETE,
            &target.path,
            "application/json",
            &serde_json::to_value(&options).expect("delete options serialize"),
        );
        match clients.api.request_text(request).await {
            Ok(_) => {}
            Err(kube::Error::Api(status)) if status.code == 404 => {}
            Err(kube::Error::Api(status)) if status.code == 409 => {
                return Err(IpcError::new(
                    ErrorKind::Conflict,
                    format!(
                        "{} was replaced since the diff, so Twigo deleted nothing",
                        sentence(what)
                    ),
                ));
            }
            Err(error) => return Err(errors::request(&error)),
        }
        progress.running(format!("Waiting for {what} to go"));
        loop {
            match get(&clients, &target.path).await {
                Err(error) if error.kind == ErrorKind::NotFound => break,
                Err(error) => {
                    return Err(IpcError::new(
                        error.kind,
                        format!(
                            "Deleted {what}, but Twigo cannot tell whether it is gone, so it created nothing: {}",
                            error.message
                        ),
                    ));
                }
                Ok(object) if object["metadata"]["uid"].as_str() != Some(step.uid.as_str()) => {
                    break;
                }
                Ok(_) => {}
            }
            tokio::select! {
                () = progress.stopped() => {
                    return Ok(Finished::Stopped(format!(
                        "Stopped waiting for {what}, which is still being deleted, and created nothing"
                    )));
                }
                () = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
        progress.running(format!("Creating {what}"));
        let create_path = format!(
            "{}?fieldManager={FIELD_MANAGER}&fieldValidation=Strict",
            collection(target)
        );
        let request = write(Method::POST, &create_path, "application/json", &step.body);
        match clients.api.request_text(request).await {
            Ok(_) => Ok(Finished::Done(format!("Recreated {what}"))),
            Err(error) => {
                let failed = errors::request(&error);
                Err(IpcError::new(
                    failed.kind,
                    format!(
                        "Deleted {what}, but creating it from your edit failed: {}",
                        failed.message
                    ),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use twigo_ipc::ResourceRef;

    use super::*;

    fn deployment_target() -> Target {
        Target::in_context(
            "kind-a".to_owned(),
            Resource {
                group: "apps".to_owned(),
                version: "v1".to_owned(),
                resource: "deployments".to_owned(),
                namespaced: true,
            },
            Some("n".to_owned()),
            "web".to_owned(),
        )
        .unwrap()
    }

    #[test]
    fn an_edit_that_names_another_object_is_refused() {
        let target = deployment_target();
        let live = json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "web", "namespace": "n" },
        });
        assert_eq!(same_object(&target, &live, &live), Ok(()));
        for (path, value) in [
            ("apiVersion", json!("apps/v2")),
            ("kind", json!("StatefulSet")),
        ] {
            let mut edited = live.clone();
            edited[path] = value;
            assert_eq!(
                same_object(&target, &live, &edited).unwrap_err().kind,
                ErrorKind::InvalidInput,
                "{path}"
            );
        }
        for (field, value) in [("name", json!("other")), ("namespace", json!("elsewhere"))] {
            let mut edited = live.clone();
            edited["metadata"][field] = value;
            assert_eq!(
                same_object(&target, &live, &edited).unwrap_err().kind,
                ErrorKind::InvalidInput,
                "{field}"
            );
        }
    }

    #[test]
    fn an_edit_holds_to_the_live_version_only_when_a_status_write_alone_moved_it() {
        let live = json!({
            "metadata": { "name": "web", "resourceVersion": "9", "generation": 2 },
            "spec": { "replicas": 1 },
            "status": { "replicas": 1 },
        });
        let opened = |base: Value, lock: &str| OpenedEdit {
            target: ResourceRef {
                gvr: twigo_ipc::Gvr {
                    group: "apps".to_owned(),
                    version: "v1".to_owned(),
                    resource: "deployments".to_owned(),
                },
                namespaced: true,
                namespace: Some("n".to_owned()),
                name: "web".to_owned(),
            },
            base,
            lock: lock.to_owned(),
        };
        let mut same = live.clone();
        same["metadata"]["resourceVersion"] = json!("3");
        same["metadata"]["generation"] = json!(1);
        same["status"]["replicas"] = json!(0);
        assert_eq!(
            held_lock(&opened(same.clone(), "3"), Some(&live), true),
            "9"
        );
        assert_eq!(
            held_lock(&opened(same.clone(), "3"), Some(&live), false),
            "3",
            "a resource with no status subresource stays strict"
        );
        let mut changed = same.clone();
        changed["spec"]["replicas"] = json!(2);
        assert_eq!(held_lock(&opened(changed, "3"), Some(&live), true), "3");
        assert_eq!(held_lock(&opened(same, "9"), Some(&live), true), "9");
    }

    #[test]
    fn a_warning_header_gives_its_text() {
        for (header, want) in [
            (r#"299 - "unknown field""#, Some("unknown field")),
            (r#"299 - "a \"quoted\" word""#, Some(r#"a "quoted" word"#)),
            ("not a warning", None),
        ] {
            assert_eq!(warning_text(header).as_deref(), want, "{header}");
        }
    }

    #[test]
    fn a_conflict_s_message_names_its_manager() {
        for (message, manager) in [
            (
                "conflict with \"kubectl-create\" using apps/v1",
                "kubectl-create",
            ),
            ("conflict with \"helm\"", "helm"),
            (
                "conflict with \"kube-controller-manager\" with subresource \"scale\"",
                "kube-controller-manager",
            ),
        ] {
            assert_eq!(conflict_manager(message), manager, "{message}");
        }
    }

    #[test]
    fn scrubbing_takes_a_value_only_as_a_whole_token() {
        let secrets = vec!["a".to_owned(), "hunter2".to_owned(), "x=".to_owned()];
        assert_eq!(
            scrub("a a-bcd spat a_b ahunter2 hunter2 at x= cx=", &secrets),
            format!("{HIDDEN} {HIDDEN}-bcd spat a_b ahunter2 {HIDDEN} at {HIDDEN} cx=")
        );
    }

    #[test]
    fn what_a_dry_run_s_answer_holds_is_scrubbed_too() {
        let mut secrets = secret_values(&[&json!({ "stringData": { "a": "first" } })]);
        let answer = json!({ "data": { "token": "dHlwZWQ=", "a": "Zmlyc3Q=" } });
        add_answered(&mut secrets, &answer);
        assert_eq!(
            scrub("dHlwZWQ= or typed or first or Zmlyc3Q=", &secrets),
            format!("{HIDDEN} or {HIDDEN} or {HIDDEN} or {HIDDEN}")
        );
        let mut other_kinds = Vec::new();
        add_answered(&mut other_kinds, &answer);
        assert!(other_kinds.is_empty(), "only a Secret has values to hide");
    }

    #[test]
    fn a_pod_s_controller_is_read_from_its_owners() {
        let owned = |controller: bool| {
            json!({ "metadata": { "ownerReferences": [
                { "kind": "ReplicaSet", "name": "web-1", "controller": controller },
            ] } })
        };
        assert_eq!(
            controller_owner(&owned(true)).as_deref(),
            Some("replica set web-1")
        );
        assert_eq!(controller_owner(&owned(false)), None);
        assert_eq!(controller_owner(&json!({ "metadata": {} })), None);
    }

    #[test]
    fn a_secret_s_values_are_scrubbed_encoded_and_decoded() {
        let secret = json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "data": { "password": "aHVudGVyMg==" },
            "stringData": { "token": "s3cret" },
        });
        let secrets = secret_values(&[&secret]);
        let text = scrub("bad aHVudGVyMg== and hunter2 and s3cret", &secrets);
        assert_eq!(text, format!("bad {HIDDEN} and {HIDDEN} and {HIDDEN}"));
    }

    #[test]
    fn a_mask_is_refused_where_it_would_be_written_and_kept_where_it_was() {
        let base = json!({ "data": { "a": "<12 bytes>" } });
        let same = json!({ "data": { "a": "<12 bytes>" } });
        assert_eq!(refuse_masks(Some(&base), &same), Ok(()));
        let renamed = json!({ "data": { "b": "<12 bytes>" } });
        assert_eq!(
            refuse_masks(Some(&base), &renamed).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
        let changed = json!({ "data": { "a": "<13 bytes>" } });
        assert!(refuse_masks(Some(&base), &changed).is_err());
        let written = json!({ "stringData": { "t": "<5 bytes>" } });
        assert!(refuse_masks(None, &written).is_err());
        let real = json!({ "data": { "a": "aHVudGVyMg==" } });
        assert_eq!(refuse_masks(Some(&base), &real), Ok(()));
    }

    #[test]
    fn only_the_words_of_an_immutable_field_make_an_immutable_refusal() {
        let refused = |message: &str| {
            let status = Status::failure(message, "Invalid").with_code(422);
            immutable(&status)
        };
        assert!(refused(
            "spec.selector: Invalid value: {...}: field is immutable"
        ));
        assert!(refused(
            "spec: Forbidden: pod updates may not change fields other than x"
        ));
        assert!(refused(
            "Service \"s\" is invalid: spec.clusterIPs[0]: Invalid value: may not change once set"
        ));
        assert!(!refused(
            "spec.replicas: Invalid value: -1: must be greater than or equal to 0"
        ));
    }
}
