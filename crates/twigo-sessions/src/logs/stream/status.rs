//! A container's status in its pod's: the instance the kubelet reads, the
//! one before, how each ended, and whether the container runs again.

use serde_json::Value;

/// A container's status in the pod's: its instance now, the one before.
pub struct Status<'a>(&'a Value);

impl<'a> Status<'a> {
    pub fn of(pod: &'a Value, container: &str) -> Option<Self> {
        ["containerStatuses", "initContainerStatuses"]
            .iter()
            .flat_map(|key| pod["status"][key].as_array().into_iter().flatten())
            .find(|status| status["name"] == container)
            .map(Status)
    }

    /// The instance the kubelet reads, and whether it runs.
    pub fn current(&self) -> Option<(&'a str, bool)> {
        let state = &self.0["state"];
        let id = |value: &'a Value| value.as_str().filter(|id| !id.is_empty());
        if state["running"].is_object() {
            return Some((id(&self.0["containerID"])?, true));
        }
        let terminated = id(&state["terminated"]["containerID"]);
        terminated.or_else(|| self.previous()).map(|id| (id, false))
    }

    pub fn previous(&self) -> Option<&'a str> {
        self.0["lastState"]["terminated"]["containerID"]
            .as_str()
            .filter(|id| !id.is_empty())
    }

    /// Whether it names the instance `id`, as the one the kubelet reads or
    /// the one before.
    pub fn names(&self, id: &str) -> bool {
        self.current().is_some_and(|(current, _)| current == id) || self.previous() == Some(id)
    }

    /// Whether the kubelet reads another instance than `id`, as the
    /// status says.
    pub fn moved_from(&self, id: &str) -> bool {
        self.current().is_some_and(|(current, _)| current != id)
    }

    /// How the instance `id` ended, once the status says it did.
    pub fn termination(&self, id: &str) -> Option<&'a Value> {
        [
            &self.0["state"]["terminated"],
            &self.0["lastState"]["terminated"],
        ]
        .into_iter()
        .find(|terminated| terminated["containerID"] == id)
    }

    pub fn waiting(&self) -> Option<String> {
        self.0["state"]["waiting"]["reason"]
            .as_str()
            .map(str::to_owned)
    }

    /// When the kubelet starts the ended instance again, in a crash loop's
    /// back-off.
    pub fn restarting(&self, finished: &str) -> Option<String> {
        let waiting = &self.0["state"]["waiting"];
        (waiting["reason"] == "CrashLoopBackOff")
            .then(|| twigo_describe::next_start(finished, waiting["message"].as_str()?))
            .flatten()
    }
}

/// Whether the kubelet has an instance of the container to read: the
/// previous one, or the one it reads now.
pub fn readable(pod: &Value, container: &str, previous: bool) -> bool {
    Status::of(pod, container).is_some_and(|status| {
        if previous {
            status.previous().is_some()
        } else {
            status.current().is_some()
        }
    })
}

/// Whether the kubelet runs the container again after it ended with
/// `exit_code`: as the pod's restart policy says, a sidecar always, an init
/// container only after a failure, none once the pod is done or deleted.
pub fn restarts(pod: &Value, container: &str, exit_code: Option<i64>) -> bool {
    let phase = pod["status"]["phase"].as_str();
    if matches!(phase, Some("Succeeded" | "Failed"))
        || pod["metadata"]["deletionTimestamp"].is_string()
    {
        return false;
    }
    let spec = &pod["spec"];
    let policy = spec["restartPolicy"].as_str().unwrap_or("Always");
    let failed = exit_code != Some(0);
    let init = spec["initContainers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|init| init["name"] == container);
    match init {
        Some(init) if init["restartPolicy"] == "Always" => true,
        Some(_) => failed && policy != "Never",
        None => match policy {
            "Never" => false,
            "OnFailure" => failed,
            _ => true,
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_kubelet_reads_the_running_instance_else_the_last_that_ended() {
        let pod = json!({ "status": { "containerStatuses": [
            { "name": "api", "containerID": "containerd://b", "state": { "running": {} },
              "lastState": { "terminated": { "containerID": "containerd://a", "exitCode": 1 } } },
            { "name": "loop", "containerID": "containerd://d",
              "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 10s restarting failed container=loop" } },
              "lastState": { "terminated": { "containerID": "containerd://c", "exitCode": 2, "finishedAt": "2026-11-03T10:00:00Z" } } },
            { "name": "new", "state": { "waiting": { "reason": "ContainerCreating" } } },
        ], "initContainerStatuses": [
            { "name": "init", "containerID": "containerd://e", "state": { "terminated": { "containerID": "containerd://e", "exitCode": 0 } } },
        ] } });
        let status = |name| Status::of(&pod, name).unwrap();
        assert_eq!(status("api").current(), Some(("containerd://b", true)));
        assert_eq!(status("api").previous(), Some("containerd://a"));
        assert_eq!(status("loop").current(), Some(("containerd://c", false)));
        assert_eq!(
            status("loop").restarting("2026-11-03T10:00:00Z").as_deref(),
            Some("2026-11-03T10:00:10Z")
        );
        assert_eq!(status("new").current(), None);
        assert_eq!(
            status("new").waiting().as_deref(),
            Some("ContainerCreating")
        );
        assert_eq!(status("init").current(), Some(("containerd://e", false)));
        assert!(status("init").termination("containerd://e").is_some());
        assert!(status("api").termination("containerd://b").is_none());
    }

    #[test]
    fn an_ended_container_runs_again_as_its_policy_says() {
        let pod = |policy: &str, phase: &str| {
            json!({
                "spec": {
                    "restartPolicy": policy,
                    "initContainers": [{ "name": "init" }, { "name": "proxy", "restartPolicy": "Always" }],
                    "containers": [{ "name": "app" }],
                },
                "status": { "phase": phase },
            })
        };
        assert!(restarts(&pod("Always", "Running"), "app", Some(0)));
        assert!(!restarts(&pod("Never", "Running"), "app", Some(1)));
        assert!(restarts(&pod("OnFailure", "Running"), "app", Some(1)));
        assert!(!restarts(&pod("OnFailure", "Running"), "app", Some(0)));
        assert!(!restarts(&pod("Always", "Running"), "init", Some(0)));
        assert!(restarts(&pod("Always", "Pending"), "init", Some(1)));
        assert!(!restarts(&pod("Never", "Pending"), "init", Some(1)));
        assert!(restarts(&pod("Never", "Running"), "proxy", Some(0)));
        assert!(!restarts(&pod("Always", "Succeeded"), "app", Some(0)));
        let mut deleted = pod("Always", "Running");
        deleted["metadata"] = json!({ "deletionTimestamp": "2026-11-03T10:00:00Z" });
        assert!(!restarts(&deleted, "app", Some(1)));
    }
}
