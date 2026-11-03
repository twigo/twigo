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

#[tokio::test]
async fn the_webview_learns_where_a_context_comes_from() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("config");
    fs::write(
        &file,
        "
clusters: [{ name: c, cluster: { server: 'https://user:pass@kind:6443' } }]
contexts: [{ name: kind-a, context: { cluster: c } }]
",
    )
    .unwrap();
    let catalog = Catalog::default();
    catalog.follow(Sources::explicit(file.clone()));
    let contexts = catalog.contexts().await.ipc();
    assert_eq!(
        contexts,
        [twigo_ipc::Context {
            name: "kind-a".to_owned(),
            color: None,
            source: file.display().to_string(),
            server: Some("https://kind:6443".to_owned()),
        }]
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

#[tokio::test]
async fn a_fingerprint_changes_with_its_own_context_but_not_with_oidc_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let kubeconfig = |name: &str, server: &str, namespace: &str, token: &str| {
        let file = dir.path().join(name);
        fs::write(
            &file,
            format!(
                "clusters: [{{ name: c, cluster: {{ server: '{server}' }} }}]
users: [{{ name: u, user: {{ auth-provider: {{ name: oidc, config: {{ idp-issuer-url: 'https://issuer.example', client-id: twigo, id-token: {token}, refresh-token: {token}-refresh }} }} }} }}]
contexts: [{{ name: kind-a, context: {{ cluster: c, user: u }} }}, {{ name: kind-b, context: {{ cluster: c, namespace: {namespace} }} }}]
"
            ),
        )
        .unwrap();
        Sources::explicit(file)
    };
    let catalog = Catalog::default();
    catalog.follow(kubeconfig("one", "https://a.example:6443", "x", "t1"));
    catalog.contexts().await;
    let mut fingerprint = catalog.fingerprint("kind-a").await;
    let first = fingerprint.borrow_and_update().expect("kind-a is listed");

    catalog.follow(kubeconfig("two", "https://a.example:6443", "y", "t2"));
    let quiet =
        tokio::time::timeout(std::time::Duration::from_secs(1), fingerprint.changed()).await;
    assert!(quiet.is_err(), "another context and new tokens leave it");

    catalog.follow(kubeconfig("three", "https://b.example:6443", "y", "t2"));
    tokio::time::timeout(std::time::Duration::from_secs(1), fingerprint.changed())
        .await
        .expect("a new server changes it")
        .unwrap();
    assert_ne!(*fingerprint.borrow(), Some(first));
}

#[tokio::test]
async fn a_fingerprint_starts_from_the_catalog_once_read() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kubeconfig");
    fs::write(
        &file,
        "clusters: [{ name: c, cluster: { server: 'https://a.example:6443' } }]
contexts: [{ name: kind-a, context: { cluster: c } }]
",
    )
    .unwrap();
    let catalog = Arc::new(Catalog::default());
    let waiting = tokio::spawn({
        let catalog = Arc::clone(&catalog);
        async move { catalog.fingerprint("kind-a").await }
    });
    tokio::task::yield_now().await;
    catalog.follow(Sources::explicit(file));

    let mut fingerprint = waiting.await.unwrap();
    assert!(fingerprint.borrow_and_update().is_some());
    let quiet =
        tokio::time::timeout(std::time::Duration::from_secs(1), fingerprint.changed()).await;
    assert!(quiet.is_err(), "the first read is no change");
}
