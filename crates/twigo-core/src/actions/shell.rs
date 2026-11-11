//! Opens a shell in a container, or attaches to its main process
//! (ARCHITECTURE 4.6, 6.4). Attach takes `stdin` and `tty` from the
//! container's spec, as kubectl does, so a container that keeps no stdin
//! attaches read-only. The plan's run parks a session and connects nothing:
//! `shell_open` starts it with the terminal's size.

use std::sync::Arc;

use futures::FutureExt;
use serde_json::Value;
use twigo_cache::hub::Resource;
use twigo_ipc::{ErrorKind, IpcError, Mode, ShellContainers, ShellKind, ShellPod, ShellTarget};
use twigo_policy::friction::Risk;
use twigo_policy::{Attributes, Policy};
use twigo_sessions::shell::{Join, SHELL, Session, Spec};

use super::{Target, clients_for, get, kubectl};
use crate::Core;
use crate::bus::{Finished, Planned};
use crate::terminal::Shell;

const DEFAULT_CONTAINER: &str = "kubectl.kubernetes.io/default-container";

fn pods(context: String, namespace: String, name: String) -> Result<Target, IpcError> {
    let pods = Resource {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "pods".to_owned(),
        namespaced: true,
    };
    Target::in_context(context, pods, Some(namespace), name)
}

/// The words a plan of `kind` reads in.
struct Words {
    question: String,
    confirm: &'static str,
    doing: String,
    consequences: Vec<String>,
}

fn subresource(kind: ShellKind) -> &'static str {
    match kind {
        ShellKind::Shell => "exec",
        ShellKind::Attach => "attach",
    }
}

fn words(kind: ShellKind, spec: &Spec, context: &str) -> Words {
    let Spec {
        namespace,
        pod,
        container,
        stdin,
        ..
    } = spec;
    let place = format!("container {container} of pod {pod} in {namespace} on {context}");
    match kind {
        ShellKind::Shell => Words {
            question: format!("Open a shell in {place}?"),
            confirm: "Open shell",
            doing: format!("Opening a shell in {pod}"),
            consequences: vec!["What you run has the container's rights in the pod.".to_owned()],
        },
        ShellKind::Attach => Words {
            question: format!("Attach to {place}?"),
            confirm: "Attach",
            doing: format!("Attaching to {pod}"),
            consequences: vec![if *stdin {
                "You join its main process: what you type reaches it, Ctrl-C included.".to_owned()
            } else {
                "It keeps no stdin, so this attach only shows its output.".to_owned()
            }],
        },
    }
}

/// `stdin` and `tty` of a container in the pod's spec.
fn attach_settings(pod: &Value, container: &str) -> Result<(bool, bool), IpcError> {
    ["containers", "initContainers", "ephemeralContainers"]
        .iter()
        .flat_map(|list| pod["spec"][*list].as_array().into_iter().flatten())
        .find(|candidate| candidate["name"].as_str() == Some(container))
        .map(|found| {
            (
                found["stdin"].as_bool().unwrap_or(false),
                found["tty"].as_bool().unwrap_or(false),
            )
        })
        .ok_or_else(|| {
            IpcError::new(
                ErrorKind::NotFound,
                format!("Pod {} has no container {container}", name(pod)),
            )
        })
}

fn name(pod: &Value) -> &str {
    pod["metadata"]["name"].as_str().unwrap_or_default()
}

/// Ends once `context` is read-only, as a relock or an unlock running out
/// leaves it.
async fn relocked(policy: Arc<Policy>, context: String) {
    let mut changes = policy.changes();
    loop {
        changes.borrow_and_update();
        if policy.access(&context).mode == Mode::ReadOnly {
            return;
        }
        // The policy this holds keeps its sender.
        let _ = changes.changed().await;
    }
}

pub(crate) async fn shell(
    core: &Core,
    window: &str,
    target: ShellTarget,
    kind: ShellKind,
) -> Result<Planned, IpcError> {
    let ShellTarget {
        space,
        namespace,
        pod,
        container,
    } = target;
    let context = core.context(&space)?;
    let object = pods(context.clone(), namespace.clone(), pod.clone())?;
    let mut spec = Spec::shell(namespace, pod, container);
    if kind == ShellKind::Attach {
        spec.join = Join::Attach;
    }
    let writes = vec![Attributes::action(
        "create",
        "pods",
        Some(subresource(kind)),
        Some(&spec.namespace),
        Some(&spec.pod),
    )];
    core.authorize(&context, &writes)?;
    if kind == ShellKind::Attach {
        let clients = core
            .clients(&context)
            .await
            .map_err(|error| IpcError::from(&error))?;
        let live = get(&clients, &object.path).await?;
        (spec.stdin, spec.tty) = attach_settings(&live, &spec.container)?;
    }
    let read = words(kind, &spec, &context);
    let kubectl = kubectl_line(kind, &spec, &context)?;
    let connection = core.policy.connection(&context);
    let ticket = core.shells.ticket(window);
    let this = core.this.clone();
    let run_context = context.clone();
    let (tty, stdin) = (spec.tty, spec.stdin);
    Ok(Planned {
        target: format!("{}, container {}", writes[0].target(), spec.container),
        writes,
        command: match kind {
            ShellKind::Shell => "shell",
            ShellKind::Attach => "attach",
        },
        question: read.question,
        confirm: read.confirm.to_owned(),
        destructive: false,
        consequences: read.consequences,
        affected: Vec::new(),
        kubectl,
        doing: read.doing,
        context,
        connection,
        space: None,
        risk: Risk::Shell,
        previewed: None,
        run: Box::new(move |_| {
            Box::pin(async move {
                let (core, clients) =
                    clients_for(&this, &run_context, connection, "opened nothing").await?;
                let relocked = relocked(Arc::clone(&core.policy), run_context.clone()).boxed();
                let id = core
                    .shells
                    .keep(ticket, Shell::Pod(Session::park(clients, spec, relocked)))?;
                Ok(Finished::Session { id, tty, stdin })
            })
        }),
    })
}

fn kubectl_line(kind: ShellKind, spec: &Spec, context: &str) -> Result<String, IpcError> {
    let Spec {
        namespace,
        pod,
        container,
        stdin,
        tty,
        ..
    } = spec;
    let mut words: Vec<&str> = vec!["kubectl", "--context", context];
    match kind {
        ShellKind::Shell => {
            words.extend(["exec", "-it", pod.as_str(), "-n", namespace]);
            words.extend(["-c", container, "--"]);
            words.extend(SHELL);
        }
        ShellKind::Attach => {
            words.push("attach");
            match (*stdin, *tty) {
                (true, true) => words.push("-it"),
                (true, false) => words.push("-i"),
                (false, _) => {}
            }
            words.extend([pod.as_str(), "-n", namespace, "-c", container]);
        }
    }
    kubectl(&words)
}

fn running(pod: &Value, list: &str) -> Vec<String> {
    pod["status"][list]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|status| status["state"]["running"].is_object())
        .filter_map(|status| status["name"].as_str().map(str::to_owned))
        .collect()
}

/// The containers of `pod` that run, and which of them a shell defaults to.
fn offered(pod: &Value) -> Result<ShellContainers, IpcError> {
    let phase = pod["status"]["phase"].as_str().unwrap_or_default();
    if matches!(phase, "Succeeded" | "Failed") {
        return Err(IpcError::new(
            ErrorKind::Conflict,
            format!("Pod {} has finished", name(pod)),
        ));
    }
    let containers: Vec<String> = [
        "containerStatuses",
        "initContainerStatuses",
        "ephemeralContainerStatuses",
    ]
    .iter()
    .flat_map(|list| running(pod, list))
    .collect();
    let Some(first) = containers.first().cloned() else {
        return Err(IpcError::new(
            ErrorKind::Conflict,
            format!("Pod {} has no running container", name(pod)),
        ));
    };
    let named = pod["metadata"]["annotations"][DEFAULT_CONTAINER]
        .as_str()
        .filter(|named| containers.iter().any(|name| name == named));
    Ok(ShellContainers {
        default: named.map_or(first, str::to_owned),
        containers,
    })
}

pub(crate) async fn containers(
    core: &Core,
    request: ShellPod,
) -> Result<ShellContainers, IpcError> {
    let ShellPod {
        space,
        namespace,
        pod,
    } = request;
    let context = core.context(&space)?;
    let object = pods(context.clone(), namespace, pod)?;
    let clients = core
        .clients(&context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let live = get(&clients, &object.path).await?;
    offered(&live)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use jiff::SignedDuration;
    use serde_json::json;
    use twigo_ipc::Environment;

    use super::*;

    fn status(name: &str, state: Value) -> Value {
        json!({ "name": name, "state": state })
    }

    fn running_state() -> Value {
        json!({ "running": { "startedAt": "2026-11-09T10:00:00Z" } })
    }

    fn waiting_state() -> Value {
        json!({ "waiting": { "reason": "ContainerCreating" } })
    }

    fn pod(statuses: Value) -> Value {
        json!({
            "metadata": { "name": "web-1" },
            "status": { "phase": "Running", "containerStatuses": statuses },
        })
    }

    #[test]
    fn only_those_that_run_are_offered_with_main_then_init_then_ephemeral() {
        let mut value = pod(json!([
            status("app", running_state()),
            status("sidecar", waiting_state()),
        ]));
        value["status"]["initContainerStatuses"] = json!([status("init", running_state())]);
        value["status"]["ephemeralContainerStatuses"] = json!([status("debug", running_state())]);
        assert_eq!(
            offered(&value).unwrap(),
            ShellContainers {
                containers: vec!["app".to_owned(), "init".to_owned(), "debug".to_owned()],
                default: "app".to_owned(),
            }
        );
    }

    #[test]
    fn the_annotated_default_is_taken_only_when_it_runs() {
        let mut value = pod(json!([
            status("app", running_state()),
            status("main", running_state()),
        ]));
        value["metadata"]["annotations"] = json!({ DEFAULT_CONTAINER: "main" });
        assert_eq!(offered(&value).unwrap().default, "main");

        value["metadata"]["annotations"] = json!({ DEFAULT_CONTAINER: "other" });
        assert_eq!(offered(&value).unwrap().default, "app");
    }

    #[test]
    fn a_finished_pod_and_one_that_runs_nothing_say_so_in_words() {
        let mut finished = pod(json!([status("app", running_state())]));
        finished["status"]["phase"] = json!("Succeeded");
        assert_eq!(
            offered(&finished).unwrap_err().message,
            "Pod web-1 has finished"
        );
        finished["status"]["phase"] = json!("Failed");
        assert_eq!(
            offered(&finished).unwrap_err().message,
            "Pod web-1 has finished"
        );

        let idle = pod(json!([status("app", waiting_state())]));
        assert_eq!(
            offered(&idle).unwrap_err().message,
            "Pod web-1 has no running container"
        );
    }

    #[test]
    fn attach_reads_stdin_and_tty_from_the_containers_spec_in_any_list() {
        let value = json!({
            "metadata": { "name": "web-1" },
            "spec": {
                "containers": [{ "name": "app", "stdin": true, "tty": true }, { "name": "quiet" }],
                "initContainers": [{ "name": "init", "stdin": true }],
                "ephemeralContainers": [{ "name": "debug", "tty": true }],
            },
        });
        assert_eq!(attach_settings(&value, "app").unwrap(), (true, true));
        assert_eq!(attach_settings(&value, "quiet").unwrap(), (false, false));
        assert_eq!(attach_settings(&value, "init").unwrap(), (true, false));
        assert_eq!(attach_settings(&value, "debug").unwrap(), (false, true));
        assert_eq!(
            attach_settings(&value, "gone").unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    fn production_unlocked(policy: &Policy, length: SignedDuration) {
        policy.set_environment("c", Some(Environment::Production));
        policy.unlock_for("c", length).unwrap();
        assert_eq!(policy.access("c").mode, Mode::Guarded);
    }

    #[tokio::test]
    async fn a_relock_ends_the_wait_of_a_context_that_was_not_read_only() {
        let policy = Policy::open();
        production_unlocked(&policy, SignedDuration::from_mins(15));
        let mut waiting = relocked(Arc::clone(&policy), "c".to_owned()).boxed();
        assert!((&mut waiting).now_or_never().is_none(), "guarded: it waits");
        policy.relock("c");
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("a relock ends it");
    }

    #[tokio::test]
    async fn an_unlock_running_out_ends_the_wait() {
        let policy = Policy::open();
        production_unlocked(&policy, SignedDuration::from_millis(200));
        let follow = tokio::spawn({
            let policy = Arc::clone(&policy);
            async move { policy.follow_unlocks().await }
        });
        let mut waiting = relocked(Arc::clone(&policy), "c".to_owned()).boxed();
        assert!(
            (&mut waiting).now_or_never().is_none(),
            "unlocked: it waits"
        );
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("the unlock running out ends it");
        assert_eq!(policy.access("c").mode, Mode::ReadOnly);
        follow.abort();
    }

    #[tokio::test]
    async fn a_context_changed_to_another_mode_leaves_the_wait_alone() {
        let policy = Policy::open();
        let mut waiting = relocked(Arc::clone(&policy), "c".to_owned()).boxed();
        assert!((&mut waiting).now_or_never().is_none());
        policy.set_mode("c", Some(Mode::Guarded)).unwrap();
        policy.set_mode("other", Some(Mode::ReadOnly)).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!((&mut waiting).now_or_never().is_none());
        policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("read-only ends it");
    }

    #[test]
    fn the_kubectl_line_is_the_wrapper_for_a_shell_and_the_containers_flags_for_attach() {
        let shell = Spec::shell("ns".to_owned(), "web-1".to_owned(), "app".to_owned());
        assert_eq!(
            kubectl_line(ShellKind::Shell, &shell, "kind-a").unwrap(),
            "kubectl --context kind-a exec -it web-1 -n ns -c app -- sh -c 'export TERM=xterm-256color; command -v bash >/dev/null && exec bash || exec sh'"
        );
        let mut attach = Spec {
            join: Join::Attach,
            ..shell.clone()
        };
        assert_eq!(
            kubectl_line(ShellKind::Attach, &attach, "kind-a").unwrap(),
            "kubectl --context kind-a attach -it web-1 -n ns -c app"
        );
        attach.tty = false;
        assert_eq!(
            kubectl_line(ShellKind::Attach, &attach, "kind-a").unwrap(),
            "kubectl --context kind-a attach -i web-1 -n ns -c app"
        );
        attach.stdin = false;
        assert_eq!(
            kubectl_line(ShellKind::Attach, &attach, "kind-a").unwrap(),
            "kubectl --context kind-a attach web-1 -n ns -c app"
        );
        attach.tty = true;
        assert_eq!(
            kubectl_line(ShellKind::Attach, &attach, "kind-a").unwrap(),
            "kubectl --context kind-a attach web-1 -n ns -c app",
            "kubectl forces the tty off without stdin"
        );
    }
}
