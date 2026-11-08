//! Suspends a Job or a CronJob, or resumes it: a merge patch of
//! `spec.suspend`, as `kubectl patch` sends it, since kubectl has no verb
//! for it. Either runs at once with an undo (decision 1 of M2), but for
//! suspending a Job that runs pods, whose work an undo cannot bring back:
//! that asks first and lists them. A Job that ended or is ending is
//! neither suspended nor resumed, since its controller leaves it be. The run reads the object first and writes as of
//! that read, so its undo puts back only what its own write changed.

use std::sync::Weak;

use http::Method;
use serde_json::Value;
use serde_json::json;
use twigo_ipc::{Affected, ErrorKind, IpcError, ObjectRef, ResourceRef};
use twigo_kube::client::Clients;
use twigo_policy::friction::Risk;

use super::undo::{Asks, Revert, Unchanged};
use super::{
    ATTEMPTS, MERGE_PATCH, Target, clients_for, get, kind_words, lost, patch_as_of, same, sentence,
};
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
    if is(&object, suspend) {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            already(&what, suspend),
        ));
    }
    if let Some(how) = ended(&object) {
        return Err(nothing(&what, how, suspend));
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
        (true, false) => (Risk::Reversible, vec![RESUMED.to_owned()], Vec::new()),
    };
    let words = Words::of(suspend);
    let kubectl = line(&target, suspend)?;
    let place = target.place();
    let context = target.context.clone();
    let connection = clients.connection();
    let run = Run {
        core: core.this.clone(),
        connection,
        uid: object["metadata"]["uid"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        target,
        suspend,
        what: what.clone(),
    };
    Ok(Planned {
        question: format!("{} {what}{place} on {context}?", words.verb),
        confirm: format!("{} {kind}", words.verb),
        destructive: risk == Risk::Lasting,
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

/// What a CronJob's resume does: its controller takes the latest schedule
/// time since its last, and starts a Job for it at once unless its
/// `startingDeadlineSeconds` passed (kubernetes v1.37.1,
/// `pkg/controller/cronjob/utils.go`, `mostRecentScheduleTime`).
const RESUMED: &str = "Its schedule starts jobs again, and the latest run it missed while suspended starts at once, unless its starting deadline has passed.";

/// Whether `object` is suspended, or not, as `suspend` says.
fn is(object: &Value, suspend: bool) -> bool {
    object["spec"]["suspend"].as_bool().unwrap_or(false) == suspend
}

fn already(what: &str, suspend: bool) -> String {
    let already = if suspend {
        "suspended already"
    } else {
        "not suspended"
    };
    format!("{} is {already}", sentence(what))
}

fn nothing(what: &str, how: &str, suspend: bool) -> IpcError {
    let verb = if suspend { "suspend" } else { "resume" };
    IpcError::new(
        ErrorKind::InvalidInput,
        format!("{} {how}, so there is nothing to {verb}", sentence(what)),
    )
}

/// How a Job ended, or is ending, as `kubectl get` prints it (kubernetes
/// v1.37.1, `pkg/printers/internalversion/printers.go`): its controller
/// leaves one that finished be (`pkg/controller/job/job_controller.go`,
/// `syncJob`) and ends one whose end it has decided. None for a CronJob.
pub(crate) fn ended(object: &Value) -> Option<&'static str> {
    let holds = |kind: &str| {
        object["status"]["conditions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|condition| condition["type"] == kind && condition["status"] == "True")
    };
    if object["kind"] != "Job" {
        None
    } else if holds("Complete") || holds("SuccessCriteriaMet") {
        Some("has completed")
    } else if holds("Failed") || holds("FailureTarget") {
        Some("has failed")
    } else if !object["metadata"]["deletionTimestamp"].is_null() {
        Some("is being deleted")
    } else {
        None
    }
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
    // The API server labels a Job's pods with its uid unless its selector
    // is the person's own (`manualSelector`); its pods are those it owns.
    let query = {
        let mut query = form_urlencoded::Serializer::new(String::new());
        if object["spec"]["manualSelector"] != true {
            query.append_pair(
                "labelSelector",
                &format!("batch.kubernetes.io/controller-uid={uid}"),
            );
        }
        query.finish()
    };
    let pods: Option<Vec<ObjectRef>> = match get(
        clients,
        &format!("/api/v1/namespaces/{namespace}/pods?{query}"),
    )
    .await
    {
        Ok(list) => Some(
            list["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|pod| {
                    let owned = pod["metadata"]["ownerReferences"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|owner| owner["uid"] == uid && owner["controller"] == true);
                    owned
                        && !matches!(
                            pod["status"]["phase"].as_str(),
                            Some("Succeeded" | "Failed")
                        )
                        && pod["metadata"]["deletionTimestamp"].is_null()
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
        ),
        Err(_) => None,
    };
    let mut consequences = vec![
        "Its running pods stop and their work is lost; when it resumes, new ones start.".to_owned(),
    ];
    let affected = match pods {
        Some(pods) if !pods.is_empty() => vec![Affected {
            title: "Its pods stop".to_owned(),
            objects: pods,
        }],
        Some(_) => Vec::new(),
        None => {
            consequences.push(format!(
                "Twigo cannot read the pods in {namespace}, so it cannot say which run."
            ));
            Vec::new()
        }
    };
    (Risk::Lasting, consequences, affected)
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
    /// The object its plan read.
    uid: String,
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
        let what = &self.what;
        let patch = json!({ "spec": { "suspend": self.suspend } });
        let mut answer = None;
        for attempt in 0..ATTEMPTS {
            let object = get(&clients, &target.path).await?;
            same(&object, &self.uid, what, "changed nothing")?;
            if is(&object, self.suspend) {
                return Ok(Finished::Done(already(what, self.suspend)));
            }
            if let Some(how) = ended(&object) {
                return Err(nothing(what, how, self.suspend));
            }
            answer = patch_as_of(&clients, &target.path, MERGE_PATCH, &patch, &object).await?;
            if answer.is_some() {
                break;
            }
            lost(attempt).await;
        }
        let Some(written) = answer else {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                format!("{} kept changing, so Twigo changed nothing", sentence(what)),
            ));
        };
        let (words, back) = (Words::of(self.suspend), Words::of(!self.suspend));
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
            said: if self.suspend && target.resource.resource == "cronjobs" {
                vec![RESUMED.to_owned()]
            } else {
                Vec::new()
            },
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
