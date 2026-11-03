//! Jobs and CronJobs: what kubectl describe prints of them (kubectl
//! v1.37.1, `describeJob`, `describeCronJob`), and what they own as live
//! lists.

use serde_json::Value;
use twigo_ipc::{Block, Finding, Section, Span, Tone, Value as Shown};

use crate::show::{Fields, JOB, code, link, list, plain, toned};
use crate::template::{self, JOBS, PODS};
use crate::{Described, Input, text};

pub(crate) fn job(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let status = &object["status"];
    let namespace = text(&object["metadata"]["namespace"]);
    let uid = text(&object["metadata"]["uid"]).unwrap_or_default();
    let mut fields = job_spec(spec);
    fields.scalar("Backoff limit", &spec["backoffLimit"]);
    fields.scalar("Backoff limit per index", &spec["backoffLimitPerIndex"]);
    fields.maybe(
        "TTL after finished",
        spec["ttlSecondsAfterFinished"]
            .as_i64()
            .map(|seconds| plain(format!("{seconds} s"))),
    );
    fields.flag("Suspend", &spec["suspend"]);
    fields.text("Managed by", &spec["managedBy"]);
    fields.time("Started", &status["startTime"]);
    fields.time("Completed", &status["completionTime"]);
    if let (Some(start), Some(end)) = (
        status["startTime"]
            .as_str()
            .and_then(|at| at.parse::<jiff::Timestamp>().ok()),
        status["completionTime"]
            .as_str()
            .and_then(|at| at.parse::<jiff::Timestamp>().ok()),
    ) {
        fields.add(
            "Duration",
            plain(duration(end.duration_since(start).as_secs())),
        );
    }
    let number = |key: &str| status[key].as_u64().unwrap_or_default();
    let failed = number("failed");
    let pods = match status["ready"].as_u64() {
        Some(ready) => format!(
            "{} active ({ready} ready) | {} succeeded | {failed} failed",
            number("active"),
            number("succeeded")
        ),
        None => format!(
            "{} active | {} succeeded | {failed} failed",
            number("active"),
            number("succeeded")
        ),
    };
    fields.add(
        "Pods",
        if failed > 0 {
            toned(pods, Tone::Warning)
        } else {
            plain(pods)
        },
    );
    if spec["completionMode"] == "Indexed" {
        fields.add(
            "Completed indexes",
            plain(text(&status["completedIndexes"]).unwrap_or_else(|| "none".to_owned())),
        );
        fields.text("Failed indexes", &status["failedIndexes"]);
    }
    fields.maybe(
        "Selector",
        crate::show::selector(&spec["selector"]).map(code),
    );
    Described {
        findings: job_findings(object),
        sections: vec![
            Section {
                id: "core.job".to_owned(),
                title: "Job".to_owned(),
                blocks: vec![Block::Fields { fields: fields.0 }],
            },
            template::owned_list("core.pods", "Pods", PODS, namespace.as_deref(), vec![uid]),
            template::section(&spec["template"], namespace.as_deref()),
        ],
    }
}

/// What a Job's spec and a CronJob's job template share.
fn job_spec(spec: &Value) -> Fields {
    let mut fields = Fields::default();
    fields.scalar("Parallelism", &spec["parallelism"]);
    fields.add(
        "Completions",
        plain(crate::show::scalar(&spec["completions"]).unwrap_or_else(|| "unset".to_owned())),
    );
    fields.text("Completion mode", &spec["completionMode"]);
    fields.maybe(
        "Active deadline",
        spec["activeDeadlineSeconds"]
            .as_i64()
            .map(|seconds| plain(format!("{seconds} s"))),
    );
    fields
}

/// `1m 5s`, `3h 2m`, as a person reads a duration.
fn duration(seconds: i64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds % 3600 / 60, seconds % 60);
    match (hours, minutes) {
        (0, 0) => format!("{seconds}s"),
        (0, _) => format!("{minutes}m {seconds}s"),
        _ => format!("{hours}h {minutes}m"),
    }
}

/// A Job that failed, or that its controller has marked to fail while its
/// pods stop (FailureTarget comes before Failed), with the reason it gave.
fn job_findings(job: &Value) -> Vec<Finding> {
    let conditions: Vec<&Value> = job["status"]["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|condition| condition["status"] == "True")
        .collect();
    conditions
        .iter()
        .find(|condition| condition["type"] == "Failed")
        .or_else(|| {
            conditions
                .iter()
                .find(|condition| condition["type"] == "FailureTarget")
        })
        .into_iter()
        .map(|failed| Finding {
            logs: None,
            tone: Tone::Danger,
            title: match text(&failed["reason"]).as_deref() {
                Some("BackoffLimitExceeded") => "The job failed too many times".to_owned(),
                Some("DeadlineExceeded") => "The job ran out of time".to_owned(),
                Some(reason) => format!("The job failed: {reason}"),
                None => "The job failed".to_owned(),
            },
            detail: text(&failed["lastTransitionTime"])
                .map(|at| {
                    vec![
                        Span::Text {
                            text: "Failed ".to_owned(),
                        },
                        Span::Ago { at },
                        Span::Text {
                            text: ".".to_owned(),
                        },
                    ]
                })
                .unwrap_or_default(),
            message: crate::message(&failed["message"]),
        })
        .collect()
}

pub(crate) fn cron_job(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let status = &object["status"];
    let namespace = text(&object["metadata"]["namespace"]);
    let uid = text(&object["metadata"]["uid"]).unwrap_or_default();
    let mut fields = Fields::default();
    fields.maybe("Schedule", text(&spec["schedule"]).map(code));
    fields.add(
        "Time zone",
        plain(text(&spec["timeZone"]).unwrap_or_else(|| "the controller's".to_owned())),
    );
    fields.text("Concurrency", &spec["concurrencyPolicy"]);
    fields.add(
        "Suspend",
        match spec["suspend"].as_bool() {
            Some(true) => toned("true", Tone::Warning),
            Some(false) => plain("false"),
            None => plain("unset"),
        },
    );
    fields.scalar("Successful history", &spec["successfulJobsHistoryLimit"]);
    fields.scalar("Failed history", &spec["failedJobsHistoryLimit"]);
    fields.maybe(
        "Starting deadline",
        spec["startingDeadlineSeconds"]
            .as_i64()
            .map(|seconds| plain(format!("{seconds} s"))),
    );
    fields.add(
        "Last schedule",
        text(&status["lastScheduleTime"]).map_or_else(|| plain("never"), |at| Shown::Time { at }),
    );
    fields.add(
        "Last success",
        text(&status["lastSuccessfulTime"]).map_or_else(|| plain("never"), |at| Shown::Time { at }),
    );
    let active: Vec<Shown> = status["active"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|job| {
            let name = job["name"].as_str()?;
            Some(link(JOB, namespace.as_deref(), name, name))
        })
        .collect();
    fields.add("Active jobs", list(active).unwrap_or_else(|| plain("none")));
    let job_template = &spec["jobTemplate"]["spec"];
    let mut template = template::section(&job_template["template"], namespace.as_deref());
    template.blocks.insert(
        0,
        Block::Fields {
            fields: job_spec(job_template).0,
        },
    );
    template.id = "core.jobtemplate".to_owned();
    template.title = "Job template".to_owned();
    Described {
        findings: cron_findings(status),
        sections: vec![
            Section {
                id: "core.cronjob".to_owned(),
                title: "CronJob".to_owned(),
                blocks: vec![Block::Fields { fields: fields.0 }],
            },
            template::owned_list("core.jobs", "Jobs", JOBS, namespace.as_deref(), vec![uid]),
            template,
        ],
    }
}

/// A CronJob whose last scheduled run is over and did not succeed: its last
/// schedule is later than its last success, and no job of it runs.
fn cron_findings(status: &Value) -> Vec<Finding> {
    let time = |key: &str| {
        status[key]
            .as_str()
            .and_then(|at| at.parse::<jiff::Timestamp>().ok())
    };
    let running = status["active"]
        .as_array()
        .is_some_and(|active| !active.is_empty());
    let (Some(scheduled), success) = (time("lastScheduleTime"), time("lastSuccessfulTime")) else {
        return Vec::new();
    };
    if running || success.is_some_and(|success| success >= scheduled) {
        return Vec::new();
    }
    let span = |text: &str| Span::Text {
        text: text.to_owned(),
    };
    let detail = match text(&status["lastSuccessfulTime"]) {
        Some(at) => vec![span("Its last success was "), Span::Ago { at }, span(".")],
        None => vec![span("It has never succeeded.")],
    };
    vec![Finding {
        logs: None,
        tone: Tone::Warning,
        title: "Its last run did not succeed".to_owned(),
        detail,
        message: None,
    }]
}
