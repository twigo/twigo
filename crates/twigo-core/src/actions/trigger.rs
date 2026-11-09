//! Runs a CronJob now, as `kubectl create job --from=cronjob/…` does
//! (kubectl v0.37.1, `pkg/cmd/create/create_job.go`): a Job from its
//! template, marked `cronjob.kubernetes.io/instantiate: manual` and owned by
//! it, under a name the plan picks so its kubectl command names the same.

use std::sync::Weak;

use http::Method;
use serde_json::{Map, Value, json};
use twigo_cache::hub::Resource;
use twigo_ipc::{ErrorKind, IpcError};
use twigo_policy::friction::Risk;

use super::{Target, attributes, clients_for, get, write};
use crate::Core;
use crate::bus::{Finished, Planned};

/// What a Job's name may hold: a label carries it, so 63 characters.
const NAME_LENGTH: usize = 63;

/// The characters of a generated name's suffix, as apimachinery's
/// `rand.String` picks them: no vowels, nor what reads as one.
const SUFFIX: &[u8] = b"bcdfghjklmnpqrstvwxz2456789";

pub(crate) async fn trigger(
    core: &Core,
    space: &str,
    namespace: String,
    name: String,
) -> Result<Planned, IpcError> {
    let cronjobs = Resource {
        group: "batch".to_owned(),
        version: "v1".to_owned(),
        resource: "cronjobs".to_owned(),
        namespaced: true,
    };
    let target = Target::in_context(core.context(space)?, cronjobs, Some(namespace), name)?;
    let namespace = target.namespace.clone().expect("a CronJob is namespaced");
    let jobs = format!("/apis/batch/v1/namespaces/{namespace}/jobs");
    let create = attributes(Method::POST, &jobs);
    core.authorize(&target.context, std::slice::from_ref(&create))?;
    let clients = core
        .clients(&target.context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let cronjob = get(&clients, &target.path).await?;
    let uid = cronjob["metadata"]["uid"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let job = job_name(&target.name);
    let from = format!("cronjob/{}", target.name);
    let kubectl = target.kubectl(&["create", "job", &job, "--from", &from])?;
    let (cronjob_name, context) = (target.name.clone(), target.context.clone());
    let connection = clients.connection();
    let run = Run {
        core: core.this.clone(),
        connection,
        target,
        uid,
        jobs,
        job: job.clone(),
    };
    Ok(Planned {
        question: format!("Trigger cron job {cronjob_name} in {namespace} on {context} now?"),
        confirm: "Trigger cron job".to_owned(),
        destructive: false,
        doing: format!("Triggering cron job {cronjob_name}"),
        consequences: vec![format!(
            "Job {job} runs once from its template, beside its schedule."
        )],
        affected: Vec::new(),
        kubectl,
        command: "trigger",
        target: format!("cronjobs/{cronjob_name} in {namespace}, job {job}"),
        writes: vec![create],
        context,
        connection,
        space: Some(space.to_owned()),
        risk: Risk::Lasting,
        previewed: None,
        run: Box::new(move |_| Box::pin(run.run())),
    })
}

/// `backup-manual-x7k2p`, the CronJob's name cut to leave room.
fn job_name(cronjob: &str) -> String {
    let suffix: String = (0..5)
        .map(|_| char::from(SUFFIX[fastrand::usize(..SUFFIX.len())]))
        .collect();
    let tail = format!("-manual-{suffix}");
    let room = NAME_LENGTH - tail.len();
    let head = cronjob
        .get(..room.min(cronjob.len()))
        .unwrap_or(cronjob)
        .trim_end_matches(['-', '.']);
    format!("{head}{tail}")
}

/// The Job kubectl makes of a CronJob.
fn job_of(cronjob: &Value, name: &str) -> Value {
    let template = &cronjob["spec"]["jobTemplate"];
    let mut annotations = Map::new();
    annotations.insert(
        "cronjob.kubernetes.io/instantiate".to_owned(),
        Value::from("manual"),
    );
    if let Some(theirs) = template["metadata"]["annotations"].as_object() {
        annotations.extend(theirs.clone());
    }
    json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "annotations": annotations,
            "labels": template["metadata"]["labels"],
            "ownerReferences": [{
                "apiVersion": "batch/v1",
                "kind": "CronJob",
                "name": cronjob["metadata"]["name"],
                "uid": cronjob["metadata"]["uid"],
                "controller": true,
            }],
        },
        "spec": template["spec"],
    })
}

struct Run {
    core: Weak<Core>,
    connection: Option<u64>,
    target: Target,
    /// The CronJob's, as planned.
    uid: String,
    jobs: String,
    job: String,
}

impl Run {
    async fn run(self) -> Result<Finished, IpcError> {
        let (_, clients) = clients_for(
            &self.core,
            &self.target.context,
            self.connection,
            "created nothing",
        )
        .await?;
        let cronjob = get(&clients, &self.target.path).await?;
        if cronjob["metadata"]["uid"].as_str() != Some(self.uid.as_str()) {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                format!(
                    "cron job {} was replaced since you confirmed, so Twigo created nothing",
                    self.target.name
                ),
            ));
        }
        let job = job_of(&cronjob, &self.job);
        match clients
            .api
            .request_text(write(Method::POST, &self.jobs, "application/json", &job))
            .await
        {
            Ok(_) => Ok(Finished::Done(format!("Created job {}", self.job))),
            Err(kube::Error::Api(status)) if status.code == 409 => Err(IpcError::new(
                ErrorKind::Conflict,
                format!("Job {} exists already, so Twigo created nothing", self.job),
            )),
            Err(error) => Err(twigo_kube::errors::request(&error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{NAME_LENGTH, job_name, job_of};

    #[test]
    fn a_job_takes_its_cron_job_s_name_cut_to_fit_and_a_suffix() {
        let short = job_name("backup");
        assert!(short.starts_with("backup-manual-"), "{short}");
        assert_eq!(short.len(), "backup-manual-".len() + 5);
        let long = job_name(&"a".repeat(52));
        assert_eq!(long.len(), NAME_LENGTH, "{long}");
        let cut = job_name(&format!("{}-b", "a".repeat(49)));
        assert!(
            cut.starts_with(&format!("{}-manual-", "a".repeat(49))),
            "{cut}"
        );
    }

    #[test]
    fn a_job_is_its_cron_job_s_template_marked_manual_and_owned() {
        let cronjob = json!({
            "metadata": { "name": "backup", "uid": "u-1" },
            "spec": { "jobTemplate": {
                "metadata": { "labels": { "app": "backup" }, "annotations": { "team": "data" } },
                "spec": { "template": { "spec": { "restartPolicy": "Never" } } },
            } },
        });
        let job = job_of(&cronjob, "backup-manual-x7k2p");
        assert_eq!(
            job["metadata"]["annotations"],
            json!({ "cronjob.kubernetes.io/instantiate": "manual", "team": "data" })
        );
        assert_eq!(job["metadata"]["labels"], json!({ "app": "backup" }));
        assert_eq!(
            job["metadata"]["ownerReferences"],
            json!([{ "apiVersion": "batch/v1", "kind": "CronJob", "name": "backup", "uid": "u-1", "controller": true }])
        );
        assert_eq!(job["spec"]["template"]["spec"]["restartPolicy"], "Never");
    }
}
