//! The kubectl line of a shell and of an attach, run on kind's own node: a
//! shell's wrapper picks bash, and an attach follows the container's stdin
//! and tty, as the plan said.

use std::time::Duration;

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::Api;
use kube::api::PostParams;
use serde_json::{Value, json};
use twigo_ipc::{Friction, PlanRequest, ShellKind, ShellTarget};

use super::{Cluster, WAIT, core, kubectl, kubectl_fed, plan};

fn helper(node: &Node) -> String {
    node.status
        .as_ref()
        .and_then(|status| status.images.as_ref())
        .into_iter()
        .flatten()
        .flat_map(|image| image.names.iter().flatten())
        .find(|name| name.starts_with("docker.io/kindest/local-path-helper:"))
        .expect("kind's node holds the local-path helper")
        .clone()
}

async fn running(pods: &Api<Pod>, name: &str, node: &str, image: &str, script: &str) {
    let pod: Value = json!({
        "metadata": { "name": name },
        "spec": {
            "nodeName": node,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 0,
            "containers": [{
                "name": "app",
                "image": image,
                "imagePullPolicy": "Never",
                "command": ["sh", "-c", script],
            }],
        },
    });
    pods.create(
        &PostParams::default(),
        &serde_json::from_value(pod).unwrap(),
    )
    .await
    .unwrap();
    tokio::time::timeout(WAIT, async {
        loop {
            let pod = pods.get(name).await.unwrap();
            let running = pod
                .status
                .and_then(|status| status.container_statuses)
                .into_iter()
                .flatten()
                .any(|status| status.state.is_some_and(|state| state.running.is_some()));
            if running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the pod runs");
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_shell_and_an_attach_each_run_as_their_kubectl_line_says() {
    let cluster = Cluster::connect().await;
    let node = format!(
        "{}-control-plane",
        cluster
            .context
            .strip_prefix("kind-")
            .expect("a kind cluster, whose node runs real pods")
    );
    let namespace = cluster.namespace("shell").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let image = helper(
        &Api::<Node>::all(cluster.admin.clone())
            .get(&node)
            .await
            .unwrap(),
    );
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    running(
        &pods,
        "shell",
        &node,
        &image,
        "coproc S { read; }; read -u \"${S[0]}\"",
    )
    .await;
    running(
        &pods,
        "attach",
        &node,
        &image,
        "coproc S { read; }; for i in 1 2 3 4 5 6; do echo tick; read -t 1 -u \"${S[0]}\"; done",
    )
    .await;
    let target = |pod: &str| ShellTarget {
        space: cluster.context.clone(),
        namespace: namespace.clone(),
        pod: pod.to_owned(),
        container: "app".to_owned(),
    };

    let shell = plan(
        &core,
        PlanRequest::Shell {
            target: target("shell"),
            kind: ShellKind::Shell,
        },
    )
    .await
    .unwrap();
    assert_eq!(shell.friction, Friction::AtOnce);
    assert!(
        shell.kubectl.contains("exec -it shell"),
        "{}",
        shell.kubectl
    );
    core.command_cancel("main", shell.id);
    let printed = kubectl_fed(&shell, &kubeconfig, "echo PICKED-$0-$TERM\n");
    assert!(printed.contains("PICKED-bash-xterm-256color"), "{printed}");

    let attach = plan(
        &core,
        PlanRequest::Shell {
            target: target("attach"),
            kind: ShellKind::Attach,
        },
    )
    .await
    .unwrap();
    assert!(
        attach.kubectl.contains("attach attach"),
        "the container keeps no stdin and no tty: {}",
        attach.kubectl
    );
    core.command_cancel("main", attach.id);
    let printed = kubectl(&attach, &kubeconfig);
    assert!(printed.contains("tick"), "{printed}");
    cluster.delete(&namespace).await;
}
