use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use twigo_ipc::ContextColor;

use super::*;

fn write(dir: &Path, name: &str, yaml: &str) -> PathBuf {
    let file = dir.join(name);
    fs::write(&file, yaml).unwrap();
    file
}

fn kubectl(files: &[&Path]) -> Sources {
    let list = std::env::join_paths(files).unwrap();
    Sources::kubectl(Some(&list), None)
}

fn names(catalog: &Catalog) -> Vec<&str> {
    catalog.contexts.iter().map(|c| c.name.as_str()).collect()
}

fn context<'a>(catalog: &'a Catalog, name: &str) -> &'a Context {
    catalog.contexts.iter().find(|c| c.name == name).unwrap()
}

const FIRST: &str = "
apiVersion: v1
kind: Config
clusters:
- name: shared
  cluster: { server: 'https://first:6443' }
users:
- name: shared
  user: { token: first }
contexts:
- name: kind-a
  context: { cluster: shared, user: shared }
";

const SECOND: &str = "
apiVersion: v1
kind: Config
clusters:
- name: shared
  cluster: { server: 'https://second:6443' }
- name: other
  cluster: { server: 'https://other:6443' }
users:
- name: shared
  user: { token: second }
contexts:
- name: kind-a
  context: { cluster: other, user: shared }
- name: kind-b
  context: { cluster: shared, user: shared }
";

#[test]
fn the_first_file_to_define_a_name_wins() {
    let dir = tempfile::tempdir().unwrap();
    let first = write(dir.path(), "first", FIRST);
    let second = write(dir.path(), "second", SECOND);
    let catalog = kubectl(&[&first, &second]).load();
    assert_eq!(names(&catalog), ["kind-a", "kind-b"]);
    assert!(catalog.failures.is_empty());

    let only_second = kubectl(&[&second]).load();
    assert_ne!(
        context(&catalog, "kind-a").fingerprint,
        context(&only_second, "kind-a").fingerprint,
        "kind-a is the first file's"
    );

    let alone = write(
        dir.path(),
        "alone",
        &FIRST.replace("name: kind-a", "name: kind-b"),
    );
    let reference = kubectl(&[&alone]).load();
    assert_eq!(
        context(&catalog, "kind-b").fingerprint,
        context(&reference, "kind-b").fingerprint
    );
}

#[test]
fn a_context_names_the_file_that_defines_it_from_home() {
    let dir = tempfile::tempdir().unwrap();
    let kube = dir.path().join(".kube");
    fs::create_dir(&kube).unwrap();
    let first = write(&kube, "first", FIRST);
    let second = write(dir.path(), "second", SECOND);
    let elsewhere = tempfile::tempdir().unwrap();
    let third = write(
        elsewhere.path(),
        "third",
        &FIRST.replace("name: kind-a", "name: kind-c"),
    );
    let list = std::env::join_paths([&first, &second, &third]).unwrap();
    let catalog = Sources::kubectl(Some(&list), Some(dir.path())).load();
    let source = |name| context(&catalog, name).source.clone();
    let separator = std::path::MAIN_SEPARATOR;
    assert_eq!(
        source("kind-a"),
        format!("~{separator}.kube{separator}first")
    );
    assert_eq!(source("kind-b"), format!("~{separator}second"));
    assert_eq!(source("kind-c"), third.display().to_string());
}

#[test]
fn a_context_says_its_server_without_what_could_be_secret() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "config",
        "
clusters:
- name: plain
  cluster: { server: 'https://10.0.0.1:6443' }
- name: secret
  cluster: { server: 'https://admin:hunter2@rancher.example:8443/k8s/clusters/c-1/t0ken?token=t#f' }
- name: ipv6
  cluster: { server: 'https://[::1]:6443/' }
- name: none
  cluster: {}
contexts:
- name: kind-plain
  context: { cluster: plain }
- name: kind-secret
  context: { cluster: secret }
- name: kind-ipv6
  context: { cluster: ipv6 }
- name: kind-none
  context: { cluster: none }
- name: kind-missing
  context: { cluster: gone }
",
    );
    let catalog = kubectl(&[&file]).load();
    let server = |name| context(&catalog, name).server.clone();
    assert_eq!(
        server("kind-plain").as_deref(),
        Some("https://10.0.0.1:6443")
    );
    assert_eq!(
        server("kind-secret").as_deref(),
        Some("https://rancher.example:8443")
    );
    assert_eq!(server("kind-ipv6").as_deref(), Some("https://[::1]:6443"));
    assert_eq!(server("kind-none"), None);
    assert_eq!(server("kind-missing"), None);
}

#[test]
fn a_missing_file_is_skipped_and_a_broken_one_reported() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing");
    let broken = write(dir.path(), "broken", "contexts: [unclosed");
    let first = write(dir.path(), "first", FIRST);
    let catalog = kubectl(&[&missing, &broken, &first]).load();
    assert_eq!(names(&catalog), ["kind-a"]);
    assert_eq!(catalog.failures.len(), 1);
    assert_eq!(catalog.failures[0].file, broken);
}

#[test]
fn a_context_without_its_cluster_or_user_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "config",
        "
clusters:
- name: here
  cluster: { server: 'https://here:6443' }
users:
- name: here
  user: { token: t }
contexts:
- name: kind-no-cluster
  context: { cluster: gone, user: here }
- name: kind-no-user
  context: { cluster: here, user: gone }
- name: kind-anonymous
  context: { cluster: here }
- name: kind-empty
",
    );
    let catalog = kubectl(&[&file]).load();
    let problem = |name| context(&catalog, name).problem.clone();
    assert_eq!(
        problem("kind-no-cluster"),
        Some(Problem::MissingCluster("gone".into()))
    );
    assert_eq!(
        problem("kind-no-user"),
        Some(Problem::MissingUser("gone".into()))
    );
    assert_eq!(problem("kind-anonymous"), None);
    assert_eq!(problem("kind-empty"), Some(Problem::NoContext));
}

#[test]
fn the_twigo_extension_gives_colour_and_order() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "config",
        "
contexts:
- name: kind-red
  context:
    cluster: c
    extensions:
    - name: other
      extension: { color: blue }
    - name: twigo
      extension: { color: red, order: 2, readOnly: true }
- name: kind-unknown-colour
  context:
    cluster: c
    extensions:
    - name: twigo
      extension: { color: pink, order: -1 }
- name: kind-plain
  context: { cluster: c }
",
    );
    let catalog = kubectl(&[&file]).load();
    let red = context(&catalog, "kind-red");
    assert_eq!((red.color, red.order), (Some(ContextColor::Red), Some(2)));
    let unknown = context(&catalog, "kind-unknown-colour");
    assert_eq!((unknown.color, unknown.order), (None, Some(-1)));
    let plain = context(&catalog, "kind-plain");
    assert_eq!((plain.color, plain.order), (None, None));
}

#[test]
fn a_fingerprint_changes_only_with_its_own_entries_and_files() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a.crt", "a");
    write(dir.path(), "b.crt", "b");
    let yaml = |b_token: &str| {
        format!(
            "
clusters:
- name: a
  cluster: {{ server: 'https://a:6443', certificate-authority: a.crt }}
- name: b
  cluster: {{ server: 'https://b:6443', certificate-authority: b.crt }}
users:
- name: a
  user:
    token: a
    as: someone
    as-user-extra: {{ one: [x], two: [y], three: [z], four: [w] }}
- name: b
  user: {{ token: {b_token} }}
contexts:
- name: kind-a
  context: {{ cluster: a, user: a }}
- name: kind-b
  context: {{ cluster: b, user: b }}
"
        )
    };
    let file = write(dir.path(), "config", &yaml("b"));
    let sources = kubectl(&[&file]);
    let fingerprints = || {
        let catalog = sources.load();
        (
            context(&catalog, "kind-a").fingerprint,
            context(&catalog, "kind-b").fingerprint,
        )
    };
    let (a, b) = fingerprints();
    assert_eq!(fingerprints(), (a, b), "a reread changes nothing");

    write(dir.path(), "a.crt", "a, renewed");
    let (a2, b2) = fingerprints();
    assert_ne!(a2, a, "a referenced file changed");
    assert_eq!(b2, b);

    write(dir.path(), "config", &yaml("b-rotated"));
    let (a3, b3) = fingerprints();
    assert_eq!(a3, a2);
    assert_ne!(b3, b2, "the user entry changed");
}

#[test]
fn kubectl_reads_kubeconfig_else_the_home_file() {
    let home = Path::new("/home/someone");
    let default = Sources::kubectl(None, Some(home));
    assert_eq!(default.files(), [home.join(".kube/config")]);
    let empty = Sources::kubectl(Some(OsStr::new("")), Some(home));
    assert_eq!(empty.files(), default.files());
    let listed = Sources::kubectl(Some(OsStr::new("/a::/b:/a")), Some(home));
    assert_eq!(listed.files(), [PathBuf::from("/a"), PathBuf::from("/b")]);
    let relative = Sources::kubectl(Some(OsStr::new("kind.yaml")), Some(home));
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(relative.files(), [cwd.join("kind.yaml")]);
}

#[test]
fn the_explicit_mode_keeps_only_kind_and_kwok_contexts() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "config",
        "
contexts:
- name: kind-dev
  context: { cluster: c }
- name: prod-eu
  context: { cluster: c }
- name: kwok-bench
  context: { cluster: c }
",
    );
    let catalog = Sources::explicit(file).load();
    assert_eq!(names(&catalog), ["kind-dev", "kwok-bench"]);
}

#[test]
fn a_kubeconfig_replaced_by_rename_changes_the_catalog_once() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(dir.path(), "config", FIRST);
    let (sender, changes) = mpsc::channel();
    let watch = Watch::start(kubectl(&[&file]), move |catalog| {
        sender.send(catalog).unwrap();
    })
    .unwrap();
    assert_eq!(names(&changes.try_recv().unwrap()), ["kind-a"]);

    let replacement = write(dir.path(), ".config.tmp", SECOND);
    fs::rename(&replacement, &file).unwrap();
    let changed = changes.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(names(&changed), ["kind-a", "kind-b"]);
    assert!(
        changes.recv_timeout(Duration::from_secs(1)).is_err(),
        "one change, reported once"
    );

    write(dir.path(), "config", SECOND);
    assert!(
        changes.recv_timeout(Duration::from_secs(1)).is_err(),
        "the same content written again"
    );
    write(dir.path(), "notes", "not a kubeconfig");
    assert!(
        changes.recv_timeout(Duration::from_secs(1)).is_err(),
        "an unrelated file"
    );
    drop(watch);
}

#[test]
fn a_directory_created_later_is_watched() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(".kube").join("config");
    let (sender, changes) = mpsc::channel();
    let _watch = Watch::start(kubectl(&[&file]), move |catalog| {
        sender.send(catalog).unwrap();
    })
    .unwrap();
    assert!(changes.try_recv().unwrap().contexts.is_empty());

    fs::create_dir(dir.path().join(".kube")).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut changed = None;
    while changed.is_none() && std::time::Instant::now() < deadline {
        fs::write(&file, FIRST).unwrap();
        changed = changes.recv_timeout(Duration::from_millis(500)).ok();
    }
    assert_eq!(names(&changed.expect("the new file is seen")), ["kind-a"]);
}

#[test]
fn a_watched_directory_deleted_and_made_again_is_watched_again() {
    let dir = tempfile::tempdir().unwrap();
    let kube = dir.path().join(".kube");
    fs::create_dir(&kube).unwrap();
    let file = write(&kube, "config", FIRST);
    let (sender, changes) = mpsc::channel();
    let _watch = Watch::start(kubectl(&[&file]), move |catalog| {
        sender.send(catalog).unwrap();
    })
    .unwrap();
    assert_eq!(names(&changes.try_recv().unwrap()), ["kind-a"]);

    fs::remove_dir_all(&kube).unwrap();
    let gone = changes.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(gone.contexts.is_empty());

    fs::create_dir(&kube).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut back = None;
    while back.is_none() && std::time::Instant::now() < deadline {
        fs::write(&file, SECOND).unwrap();
        back = changes.recv_timeout(Duration::from_millis(500)).ok();
    }
    assert_eq!(
        names(&back.expect("the new directory is watched")),
        ["kind-a", "kind-b"]
    );
}

#[cfg(unix)]
#[test]
fn a_write_through_a_symlink_is_seen() {
    let dir = tempfile::tempdir().unwrap();
    let dotfiles = dir.path().join("dotfiles");
    let kube = dir.path().join(".kube");
    fs::create_dir(&dotfiles).unwrap();
    fs::create_dir(&kube).unwrap();
    let target = write(&dotfiles, "kubeconfig", FIRST);
    let link = kube.join("config");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let (sender, changes) = mpsc::channel();
    let _watch = Watch::start(kubectl(&[&link]), move |catalog| {
        sender.send(catalog).unwrap();
    })
    .unwrap();
    assert_eq!(names(&changes.try_recv().unwrap()), ["kind-a"]);

    fs::write(&link, SECOND).unwrap();
    let changed = changes.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(names(&changed), ["kind-a", "kind-b"]);
}

#[test]
fn a_context_carries_its_own_entries() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "config",
        "
clusters:
- name: a
  cluster: { server: 'https://a:6443', proxy-url: 'socks5://proxy:1080' }
- name: b
  cluster: { server: 'https://b:6443' }
users:
- name: a
  user: { token: a }
- name: b
  user: { token: b }
contexts:
- name: kind-a
  context: { cluster: a, user: a }
- name: kind-b
  context: { cluster: b, user: b }
",
    );
    let catalog = kubectl(&[&file]).load();
    let a = &context(&catalog, "kind-a").entries;
    let kubeconfig = a.kubeconfig();
    assert_eq!(kubeconfig.current_context.as_deref(), Some("kind-a"));
    let clusters: Vec<_> = kubeconfig
        .clusters
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    let users: Vec<_> = kubeconfig
        .auth_infos
        .iter()
        .map(|u| u.name.as_str())
        .collect();
    assert_eq!((clusters, users), (vec!["a"], vec!["a"]));
    assert_eq!(a.proxy_url(), Some("socks5://proxy:1080"));
    assert_eq!(context(&catalog, "kind-b").entries.proxy_url(), None);
    assert_ne!(*a, context(&catalog, "kind-b").entries);
}

const OIDC: &str = "
users:
- name: dev
  user:
    auth-provider:
      name: oidc
      config: { idp-issuer-url: 'https://id.example', client-id: twigo, id-token: ID, refresh-token: RT }
contexts:
- name: kind-oidc
  context: { cluster: c, user: dev }
clusters:
- name: c
  cluster: { server: 'https://c:6443' }
";

#[test]
fn a_user_entry_knows_the_first_file_that_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let first = write(dir.path(), "first", OIDC);
    let second = write(
        dir.path(),
        "second",
        &OIDC.replace("https://id.example", "https://other.example"),
    );
    let catalog = kubectl(&[&first, &second]).load();
    let oidc = context(&catalog, "kind-oidc")
        .entries
        .oidc()
        .unwrap()
        .unwrap();
    assert_eq!(oidc.origin.as_deref(), Some(first.as_path()));
    assert_eq!(oidc.user, "dev");
}

#[test]
fn an_oidc_provider_beside_an_exec_plugin_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "config",
        &OIDC.replace(
            "    auth-provider:",
            "    exec: { apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never, command: aws }\n    auth-provider:",
        ),
    );
    let catalog = kubectl(&[&file]).load();
    let entries = &context(&catalog, "kind-oidc").entries;
    assert!(entries.oidc().is_none());
    assert!(matches!(
        entries.exec(),
        Err(crate::credentials::ExecError::WithAuthProvider(_))
    ));
}

#[test]
fn a_token_in_the_entry_wins_over_its_oidc_provider() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "config",
        &OIDC.replace(
            "    auth-provider:",
            "    token: static\n    auth-provider:",
        ),
    );
    let catalog = kubectl(&[&file]).load();
    assert!(context(&catalog, "kind-oidc").entries.oidc().is_none());
}

#[test]
fn refreshed_oidc_tokens_leave_the_fingerprint_alone() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(dir.path(), "config", OIDC);
    let fingerprint = || context(&kubectl(&[&file]).load(), "kind-oidc").fingerprint;
    let before = fingerprint();
    write(
        dir.path(),
        "config",
        &OIDC.replace(
            "id-token: ID, refresh-token: RT",
            "id-token: ID2, refresh-token: RT2",
        ),
    );
    assert_eq!(fingerprint(), before);
    write(
        dir.path(),
        "config",
        &OIDC.replace("client-id: twigo", "client-id: other"),
    );
    assert_ne!(fingerprint(), before, "the provider itself changed");

    let ca = write(dir.path(), "idp.pem", "first");
    write(
        dir.path(),
        "config",
        &OIDC.replace(
            "client-id: twigo,",
            &format!(
                "client-id: twigo, idp-certificate-authority: '{}',",
                ca.display()
            ),
        ),
    );
    let with_ca = fingerprint();
    write(dir.path(), "idp.pem", "second");
    assert_ne!(fingerprint(), with_ca, "the IdP's CA file changed in place");
}
