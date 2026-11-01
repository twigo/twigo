use std::fs;

use super::*;

const CONFIG: &str = "
contexts:
- name: kind-plain-b
  context: { cluster: c }
- name: kind-plain-a
  context: { cluster: c }
- name: kind-second
  context:
    cluster: c
    extensions: [{ name: twigo, extension: { order: 2 } }]
- name: kind-first
  context:
    cluster: c
    extensions: [{ name: twigo, extension: { order: -5, color: green } }]
- name: prod-eu
  context: { cluster: c }
";

#[tokio::test]
async fn contexts_come_by_order_then_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("config");
    fs::write(&file, CONFIG).unwrap();
    let catalog = Catalog::default();
    catalog.follow(Sources::explicit(file));
    let names: Vec<String> = catalog
        .contexts()
        .await
        .ipc()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(
        names,
        ["kind-first", "kind-second", "kind-plain-a", "kind-plain-b"]
    );
}

#[test]
fn the_explicit_mode_never_reads_home() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(home.join(".kube")).unwrap();
    fs::write(
        home.join(".kube/config"),
        "contexts: [{ name: kind-home, context: { cluster: c } }]",
    )
    .unwrap();
    let explicit = dir.path().join("kind.kubeconfig");
    fs::write(&explicit, CONFIG).unwrap();
    let kubeconfig = OsStr::new("/elsewhere/config");

    let catalog = sources(Some(explicit), Some(kubeconfig), Some(&home)).load();
    let names: Vec<&str> = catalog.contexts.iter().map(|c| c.name.as_str()).collect();
    assert!(!names.contains(&"kind-home"), "{names:?}");
    assert!(!names.contains(&"prod-eu"), "{names:?}");
    assert_eq!(names.len(), 4);

    let without = sources(None, None, Some(&home)).load();
    assert_eq!(
        without.contexts[0].name, "kind-home",
        "the home file is there"
    );
}

#[tokio::test]
async fn following_other_sources_replaces_the_contexts() {
    let dir = tempfile::tempdir().unwrap();
    let one = dir.path().join("one");
    let two = dir.path().join("two");
    fs::write(
        &one,
        "contexts: [{ name: kind-one, context: { cluster: c } }]",
    )
    .unwrap();
    fs::write(
        &two,
        "contexts: [{ name: kind-two, context: { cluster: c } }]",
    )
    .unwrap();
    let catalog = Catalog::default();
    catalog.follow(Sources::explicit(one.clone()));
    catalog.follow(Sources::explicit(two));
    let contexts = catalog.contexts().await;
    assert!(contexts.find("kind-two").is_some());
    assert!(contexts.find("kind-one").is_none());

    let mut changes = catalog.subscribe();
    changes.borrow_and_update();
    fs::write(
        &one,
        "contexts: [{ name: kind-three, context: { cluster: c } }]",
    )
    .unwrap();
    let changed = tokio::time::timeout(std::time::Duration::from_secs(1), changes.changed()).await;
    assert!(changed.is_err(), "no change from the replaced source");
}
