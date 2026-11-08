//! Suspends a Job or a CronJob, or resumes it: a merge patch of
//! `spec.suspend`, as `kubectl patch` sends it, since kubectl has no verb
//! for it. Either runs at once with an undo (decision 1 of M2).

use std::sync::Weak;

use http::Method;
use serde_json::json;
use twigo_ipc::{ErrorKind, IpcError, ResourceRef};
use twigo_policy::friction::Risk;

use super::undo::{Revert, Unchanged};
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
    let consequence = match (cronjob, suspend) {
        (false, true) => "Its running pods stop, and none start until it resumes.",
        (false, false) => "It starts its pods again.",
        (true, true) => "No new jobs start on its schedule until it resumes; those running go on.",
        (true, false) => "Its schedule starts jobs again.",
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
        consequences: vec![consequence.to_owned()],
        affected: Vec::new(),
        kubectl,
        command: if suspend { "suspend" } else { "resume" },
        target: attributes.target(),
        writes: vec![attributes],
        context,
        connection,
        space: Some(space.to_owned()),
        risk: Risk::Reversible,
        run: Box::new(move |_| Box::pin(run.run())),
    })
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
            empties: false,
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
