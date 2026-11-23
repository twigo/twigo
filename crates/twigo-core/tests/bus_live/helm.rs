//! The Reveal of a Helm release's values and of its whole manifest: the
//! `helm` line of its plan, run here with the `helm` on `PATH`, prints what
//! the Reveal shows.

use std::path::Path;
use std::process::Command;

use serde_json::Value;
use tokio::sync::mpsc;
use twigo_ipc::{
    Ack, HelmPart, OpenRelease, OperationEvent, PlanRequest, ReleaseParts, ReleaseRef, ValueStep,
};

use super::{Cluster, WAIT, core, line, run};

const CHART: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/helm_chart");

/// Runs `run` over the copy of the test's kubeconfig, with homes of helm's
/// own, so it reads none of the person's repositories or plugins.
fn helm(dir: &Path, kubeconfig: &Path, run: &[&str]) -> String {
    let home = dir.join("helm");
    let output = Command::new(run[0])
        .args(&run[1..])
        .env("KUBECONFIG", kubeconfig)
        .env("HELM_CONFIG_HOME", home.join("config"))
        .env("HELM_CACHE_HOME", home.join("cache"))
        .env("HELM_DATA_HOME", home.join("data"))
        .output()
        .expect("these tests run helm, which must be on PATH");
    assert!(
        output.status.success(),
        "{run:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and helm on PATH"]
async fn the_helm_line_of_a_reveal_prints_what_it_shows() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("helm").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    helm(
        dir.path(),
        &kubeconfig,
        &[
            "helm",
            "install",
            "app",
            CHART,
            "-n",
            &namespace,
            "--kube-context",
            &cluster.context,
            "--set",
            "password=reveal-me",
            "--set",
            "hosts={one,two}",
            "--set",
            "port=8443",
        ],
    );

    let space = core.state.open_space(&cluster.context).id;
    let (sender, mut batches) = mpsc::unbounded_channel();
    let request = OpenRelease {
        release: ReleaseRef {
            space,
            namespace: namespace.clone(),
            name: "app".to_owned(),
        },
        revision: None,
        parts: ReleaseParts {
            overview: true,
            values: false,
            manifest: false,
            history: false,
        },
    };
    let id = core
        .helm_release_open("main", request, move |batch| sender.send(batch).is_ok())
        .await
        .unwrap();
    tokio::time::timeout(WAIT, async {
        loop {
            let batch = batches.recv().await.unwrap();
            core.helm_release_ack("main", Ack { id, seq: batch.seq })
                .unwrap();
            if batch.overview.is_some() {
                return;
            }
        }
    })
    .await
    .expect("the release opens");

    let key = |key: &str| ValueStep::Key(key.to_owned());
    let reveals = [
        Vec::new(),
        vec![key("password")],
        vec![key("hosts"), ValueStep::Index(1)],
    ];
    for path in reveals {
        let request = PlanRequest::RevealHelm {
            release: id,
            revision: 1,
            part: HelmPart::Values {
                defaults: false,
                path: path.clone(),
            },
        };
        let plan = core.command_plan("main", request).await.unwrap();
        let told = run(&core, &plan, None).await.unwrap();
        let [OperationEvent::Revealed { value, .. }] = told.as_slice() else {
            panic!("{told:?}");
        };
        let printed = helm(dir.path(), &kubeconfig, &["sh", "-c", line(&plan)]);
        let revealed: Value = serde_json::from_str(value).unwrap();
        match revealed {
            Value::String(text) => assert_eq!(printed, text, "{}", line(&plan)),
            whole => assert_eq!(
                serde_json::from_str::<Value>(&printed).unwrap(),
                whole,
                "{}",
                line(&plan)
            ),
        }
    }

    let number = PlanRequest::RevealHelm {
        release: id,
        revision: 1,
        part: HelmPart::Values {
            defaults: false,
            path: vec![key("port")],
        },
    };
    let plan = core.command_plan("main", number).await.unwrap();
    assert_eq!(plan.command_line, None, "helm prints a number as a float");

    let manifest = PlanRequest::RevealHelm {
        release: id,
        revision: 1,
        part: HelmPart::Manifest,
    };
    let plan = core.command_plan("main", manifest).await.unwrap();
    let told = run(&core, &plan, None).await.unwrap();
    let [OperationEvent::Revealed { value, .. }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert!(
        value.contains("reveal-me"),
        "the manifest's Secret in clear"
    );
    let printed = helm(dir.path(), &kubeconfig, &["sh", "-c", line(&plan)]);
    assert_eq!(&printed, value, "{}", line(&plan));

    core.helm_release_close("main", id).unwrap();
    cluster.delete(&namespace).await;
}
