//! Suspends a Job or a CronJob, or resumes it: a merge patch of
//! `spec.suspend`, as `kubectl patch` sends it, since kubectl has no verb
//! for it. Either runs at once with an undo (decision 1 of M2).

use std::sync::Weak;

use http::Method;
use serde_json::Value;
use serde_json::json;
use twigo_ipc::{Affected, ErrorKind, IpcError, ObjectRef, ResourceRef};
use twigo_kube::client::Clients;
use twigo_policy::friction::Risk;

use super::undo::{Asks, Revert, Unchanged};
use super::{MERGE_PATCH, Target, clients_for, get, kind_words, sentence, write};
use crate::Core;
use crate::bus::{Finished, Planned};

pub(crate) async fn suspend(
    core: &Core,
    space: &str,
    target: ResourceRef,
    suspend: bool,
) -> Result<Planned, IpcError> {
    let target = Target::of(core, space, target)?;
    if !target.is("batch", &["jobs", "cronjobs"]) {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            "Twigo suspends jobs and cron jobs",
        ));
    }
    let attributes = target.attributes(Method::PATCH, None);
    core.authorize(&target.context, std::slice::from_ref(&attributes))?;
    let clients = core
        .clients(&target.context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let object = get(&clients, &target.path).await?;
    let kind = kind_words(object["kind"].as_str().unwrap_or_default());
    let what = format!("{kind} {}", target.name);
    if object["spec"]["suspend"].as_bool().unwrap_or(false) == suspend {
        let already = if suspend {
            "suspended already"
        } else {
            "not suspended"
        };
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            format!("{} is {already}", sentence(&what)),
        ));
    }
    let cronjob = target.resource.resource == "cronjobs";
    let (risk, consequences, affected) = match (cronjob, suspend) {
        (false, true) => stopping(&clients, &target, &object).await,
        (false, false) => (
            Risk::Reversible,
            vec!["It starts its pods again.".to_owned()],
            Vec::new(),
        ),
        (true, true) => (
            Risk::Reversible,
            vec![
                "No new jobs start on its schedule until it resumes; those running go on."
                    .to_owned(),
            ],
            Vec::new(),
        ),
        (true, false) => (
            Risk::Reversible,
            vec!["Its schedule starts jobs again.".to_owned()],
            Vec::new(),
        ),
    };
    let words = Words::of(suspend);
    let kubectl = line(&target, suspend)?;
    let place = target.place();
    let context = target.context.clone();
    let connection = clients.connection();
    let run = Run {
        core: core.this.clone(),
        connection,
        target,
        suspend,
        what: what.clone(),
    };
    Ok(Planned {
        question: format!("{} {what}{place} on {context}?", words.verb),
        confirm: format!("{} {kind}", words.verb),
        doing: format!("{} {what}", words.doing),
        consequences,
        affected,
        kubectl,
        command: if suspend { "suspend" } else { "resume" },
        target: attributes.target(),
        writes: vec![attributes],
        context,
        connection,
        space: Some(space.to_owned()),
        risk,
        run: Box::new(move |_| Box::pin(run.run())),
    })
}

/// What suspending a Job risks: its job controller deletes the pods it
/// runs (kubernetes v1.37.1, `pkg/controller/job/job_controller.go`), so
/// their work is lost and a resume starts new ones; one that runs none an
/// undo puts back.
pub(crate) async fn stopping(
    clients: &Clients,
    target: &Target,
    object: &Value,
) -> (Risk, Vec<String>, Vec<Affected>) {
    let calm = || {
        (
            Risk::Reversible,
            vec!["Its running pods stop, and none start until it resumes.".to_owned()],
            Vec::new(),
        )
    };
    if object["status"]["active"].as_u64().unwrap_or(0) == 0 {
        return calm();
    }
    let uid = object["metadata"]["uid"].as_str().unwrap_or_default();
    let namespace = target.namespace.as_deref().unwrap_or_default();
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair(
            "labelSelector",
            &format!("batch.kubernetes.io/controller-uid={uid}"),
        )
        .finish();
    let pods: Vec<ObjectRef> = match get(
        clients,
        &format!("/api/v1/namespaces/{namespace}/pods?{query}"),
    )
    .await
    {
        Ok(list) => list["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|pod| {
                !matches!(
                    pod["status"]["phase"].as_str(),
                    Some("Succeeded" | "Failed")
                ) && pod["metadata"]["deletionTimestamp"].is_null()
            })
            .map(|pod| ObjectRef {
                group: String::new(),
                version: "v1".to_owned(),
                kind: "Pod".to_owned(),
                namespace: Some(namespace.to_owned()),
                name: pod["metadata"]["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    let affected = if pods.is_empty() {
        Vec::new()
    } else {
        vec![Affected {
            title: "Its pods stop".to_owned(),
            objects: pods,
        }]
    };
    (
        Risk::Lasting,
        vec![
            "Its running pods stop and their work is lost; when it resumes, new ones start."
                .to_owned(),
        ],
        affected,
    )
}

struct Words {
    verb: &'static str,
    doing: &'static str,
    done: &'static str,
    /// As `changed since you … it` reads.
    past: &'static str,
}

impl Words {
    fn of(suspend: bool) -> Self {
        if suspend {
            Words {
                verb: "Suspend",
                doing: "Suspending",
                done: "Suspended",
                past: "suspended",
            }
        } else {
            Words {
                verb: "Resume",
                doing: "Resuming",
                done: "Resumed",
                past: "resumed",
            }
        }
    }
}

/// `kubectl patch jobs.batch x --type merge -p '{"spec":{"suspend":true}}'`.
fn line(target: &Target, suspend: bool) -> Result<String, IpcError> {
    let patch = json!({ "spec": { "suspend": suspend } }).to_string();
    target.kubectl(&[
        "patch",
        &target.resource.name(),
        &target.name,
        "--type",
        "merge",
        "-p",
        &patch,
    ])
}

struct Run {
    core: Weak<Core>,
    connection: Option<u64>,
    target: Target,
    suspend: bool,
    what: String,
}

impl Run {
    async fn run(self) -> Result<Finished, IpcError> {
        let target = &self.target;
        let (_, clients) = clients_for(
            &self.core,
            &target.context,
            self.connection,
            "changed nothing",
        )
        .await?;
        let patch = json!({ "spec": { "suspend": self.suspend } });
        let written: serde_json::Value = clients
            .api
            .request(write(Method::PATCH, &target.path, MERGE_PATCH, &patch))
            .await
            .map_err(|error| twigo_kube::errors::request(&error))?;
        let (words, back) = (Words::of(self.suspend), Words::of(!self.suspend));
        let what = &self.what;
        let done = format!("{} {what}", words.done);
        let (Some(generation), Some(uid), Ok(kubectl)) = (
            written["metadata"]["generation"].as_i64(),
            written["metadata"]["uid"].as_str(),
            line(target, !self.suspend),
        ) else {
            return Ok(Finished::Done(done));
        };
        let place = target.place();
        let revert = Revert {
            target: target.clone(),
            subresource: None,
            content_type: MERGE_PATCH,
            patch: json!({ "spec": { "suspend": !self.suspend } }),
            uid: uid.to_owned(),
            unchanged: Unchanged::Generation(generation),
            asks: if self.suspend || target.resource.resource != "jobs" {
                Asks::Nothing
            } else {
                Asks::Suspend
            },
            what: what.clone(),
            past: words.past,
            question: format!("{} {what}{place} on {}?", back.verb, target.context),
            doing: format!("{} {what}", back.doing),
            done: format!("{} {what}", back.done),
            kubectl,
        };
        Ok(Finished::Undoable {
            text: done,
            revert: Box::new(revert),
        })
    }
}
