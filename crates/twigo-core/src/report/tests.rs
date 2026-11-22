use serde_json::json;
use twigo_ipc::{FactId, Hidden};

use super::redact::{Kind, Known, Name, Redactor};
use super::*;

/// What the log's writer wrote, as its events are shaped: the first line of a
/// run, warnings with fields, a webview's error, a duty's panic and the
/// panic hook's record.
const LOG: &str = include_str!("fixtures/twigo.jsonl");

fn name(text: &str, kind: Kind, canonical: &str) -> Name {
    Name {
        text: text.to_owned(),
        kind,
        canonical: canonical.to_owned(),
    }
}

/// The catalog of a person with one context, the account `alice` and a home
/// under `/Users`.
fn known() -> Known {
    Known {
        names: vec![
            name("prod-eu", Kind::Context, "prod-eu"),
            name("prod-eu-cluster", Kind::Cluster, "prod-eu-cluster"),
            name("oidc-alice", Kind::User, "oidc-alice"),
            name("payments", Kind::Namespace, "payments"),
            name(
                "https://10.0.0.1:6443",
                Kind::Server,
                "https://10.0.0.1:6443",
            ),
            name("10.0.0.1:6443", Kind::Server, "https://10.0.0.1:6443"),
        ],
        homes: vec!["/Users/alice".to_owned()],
        accounts: vec!["alice".to_owned()],
    }
}

fn rendered(lines: &[&str]) -> (String, Hidden) {
    let lines: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
    log::render(&lines, known())
}

fn record(fields: serde_json::Value) -> String {
    json!({
        "timestamp": "2026-11-22T21:14:03.123456Z",
        "level": "WARN",
        "fields": fields,
        "target": "twigo_core::state",
    })
    .to_string()
}

#[test]
fn the_log_is_text_with_what_it_names_hidden_and_counted() {
    let lines: Vec<String> = LOG.lines().map(str::to_owned).collect();
    let (text, hidden) = log::render(&lines, known());

    for leaked in [
        "prod-eu",
        "staging-us",
        "dev-sandbox",
        "billing",
        "oidc-alice",
        "alice",
        "/Users",
        "10.0.0.1",
        "2001:db8",
        "dXNlcjpwYXNzd29yZA==",
        "example.com",
        "tauri://",
        "payments",
    ] {
        assert!(!text.contains(leaked), "{leaked} is in\n{text}");
    }
    assert!(
        text.contains("2026-11-22T21:14:03Z INFO  twigo_core::connections the route moved, so the connections were retired context=<context-1>\n"),
        "{text}"
    );
    assert!(
        text.contains("the watch of deployments failed context=<context-2> error=connection refused namespace=<namespace-1>\n"),
        "a name no list holds, carried as a field, is hidden\n{text}"
    );
    assert!(
        text.contains("server=<server-1>")
            && !text.contains("<server-2>")
            && text.contains("user=<user-1>"),
        "{text}"
    );
    assert!(
        text.contains("could not keep the forwards of a space error=No space left on device (os error 28) space=<context-3>\n"),
        "a space is a context\n{text}"
    );
    assert!(
        text.contains("127.0.0.1:8001") && text.contains("<address>"),
        "a loopback address stays, another goes\n{text}"
    );
    assert!(
        text.contains(r#"in the namespace "<namespace-2>""#)
            && text.contains(r#"User "<email>" cannot list resource "…""#),
        "{text}"
    );
    assert!(
        text.contains("path=<path>") && text.contains("url=<url>"),
        "{text}"
    );
    assert!(
        text.contains("command=~/.local/bin/aws-iam-authenticator"),
        "{text}"
    );
    let panic = text
        .lines()
        .position(|line| line.contains("twigo_log::panic panic"))
        .expect("the panic's record");
    let record: Vec<&str> = text.lines().skip(panic).take(4).collect();
    assert!(
        record[0].contains("location=crates/twigo-core/src/lib.rs:503:9")
            && record[0].contains(r#"payload=called `Result::unwrap()` on an `Err` value: ReadConfig(Os { code: 2, kind: NotFound, message: "…" }, "…")"#),
        "{record:?}"
    );
    assert_eq!(record[1], "    backtrace:");
    assert_eq!(
        record[2],
        "         0: std::backtrace::Backtrace::force_capture"
    );
    assert_eq!(
        hidden,
        Hidden {
            names: 11,
            paths: 3,
            tokens: 1,
            addresses: 4,
            quoted: 4,
            lines: 0,
        }
    );
}

#[test]
fn a_line_that_is_not_a_record_is_a_placeholder_and_never_its_text() {
    let whole = record(json!({
        "message": "the watch failed",
        "context": "staging-us",
        "namespace": "billing-team",
    }));
    let next = record(json!({ "message": "next", "context": "dev-x", "user": "carol-y" }));
    let cut = &whole[..whole.find("billing-team").unwrap() + 7];
    let glued = format!("{cut}{next}");
    let (text, hidden) = rendered(&[&whole, cut, &glued, &next]);
    assert_eq!(
        text,
        "2026-11-22T21:14:03Z WARN  twigo_core::state the watch failed context=<context-1> namespace=<namespace-1>\n\
         <a line that is not a record>\n\
         <a line that is not a record>\n\
         2026-11-22T21:14:03Z WARN  twigo_core::state next context=<context-2> user=<user-1>\n"
    );
    assert_eq!(hidden.lines, 2);
}

#[test]
fn a_server_is_one_alias_as_the_discovery_writes_it_and_as_the_catalog_and_the_text_do() {
    let (text, _) = rendered(&[
        &record(json!({
            "message": "could not read the cached discovery",
            "server": "https://10.0.0.1:6443/",
            "error": "x",
        })),
        &record(json!({ "message": "refused", "error": "rejected by 10.0.0.1:6443" })),
        &record(json!({
            "message": "could not cache the discovery",
            "server": "https://10.9.9.9:6443/",
        })),
        &record(json!({ "message": "refused", "error": "dialing https://10.9.9.9:6443/x" })),
    ]);
    assert_eq!(
        text,
        "2026-11-22T21:14:03Z WARN  twigo_core::state could not read the cached discovery error=x server=<server-1>\n\
         2026-11-22T21:14:03Z WARN  twigo_core::state refused error=rejected by <server-1>\n\
         2026-11-22T21:14:03Z WARN  twigo_core::state could not cache the discovery server=<server-2>\n\
         2026-11-22T21:14:03Z WARN  twigo_core::state refused error=dialing <server-2>/x\n"
    );
}

#[test]
fn a_value_that_a_field_carries_is_hidden_wherever_the_log_says_it() {
    let (text, hidden) = rendered(&[
        &record(json!({ "message": "the watch failed", "namespace": "billing" })),
        &record(json!({ "message": "retrying", "error": "no namespace billing here" })),
    ]);
    assert_eq!(
        text,
        "2026-11-22T21:14:03Z WARN  twigo_core::state the watch failed namespace=<namespace-1>\n\
         2026-11-22T21:14:03Z WARN  twigo_core::state retrying error=no namespace <namespace-1> here\n"
    );
    assert_eq!(hidden.names, 2);
}

#[test]
fn what_no_list_knows_goes_by_its_pattern() {
    let mut redactor = Redactor::new(known(), []);
    let mut hide = |text: &str| redactor.text(text);
    for (said, left) in [
        (
            "token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2ln end",
            "token <token> end",
        ),
        (
            "Authorization: Bearer abc123XYZ789 and Basic dXNlcjpwYXNz",
            "Authorization: Bearer <token> and Basic <token>",
        ),
        (
            "Basic information about bearer tokens",
            "Basic information about bearer tokens",
        ),
        (
            "mail bob@example.org, see https://git.example.org/a/b?c=d.",
            "mail <email>, see <url>.",
        ),
        (
            "from 10.1.2.3:6443 to 127.0.0.1:8001 and ::1 via [2001:db8::1]:443",
            "from <address> to 127.0.0.1:8001 and ::1 via <address>",
        ),
        (
            "at 21:14:03 in twigo_core::state, Result::unwrap, 1.37.2, aa:bb:cc:dd:ee:ff",
            "at 21:14:03 in twigo_core::state, Result::unwrap, 1.37.2, aa:bb:cc:dd:ee:ff",
        ),
        (
            r#"kept "prod-eu" but not "a secret" nor "an \"escaped\" one""#,
            r#"kept "<context-1>" but not "…" nor "…""#,
        ),
        (
            "/Users/alice/.kube/config of alice, not /Users/alice2/x",
            "~/.kube/config of <account>, not /Users/alice2/x",
        ),
    ] {
        assert_eq!(hide(said), left);
    }
    let hidden = redactor.hidden();
    assert_eq!(
        (hidden.tokens, hidden.paths, hidden.addresses, hidden.quoted),
        (3, 1, 3, 2)
    );
}

#[test]
fn an_address_goes_beside_any_punctuation_but_not_inside_a_word() {
    let mut redactor = Redactor::new(known(), []);
    for (said, left) in [
        (
            "error dialing backend: read tcp 10.0.0.7:54321->10.0.0.8:6443: read: connection reset by peer",
            "error dialing backend: read tcp <address>-><address>: read: connection reset by peer",
        ),
        ("addr:10.0.0.9:6443 refused", "addr:<address> refused"),
        (
            "host-10.0.0.13 and 10.0.0.14-",
            "host-<address> and <address>-",
        ),
        ("via ::ffff:10.0.0.15 and ::1", "via <address> and ::1"),
        ("pod10.0.0.16 and 10.0.0.17x", "pod10.0.0.16 and 10.0.0.17x"),
    ] {
        assert_eq!(redactor.text(said), left);
    }
    assert_eq!(redactor.hidden().addresses, 6);
}

#[test]
fn a_loopback_server_is_known_by_its_url_and_port_and_never_by_its_bare_host() {
    for (server, names) in [
        (
            "https://api.prod.example.com:6443",
            vec![
                "https://api.prod.example.com:6443",
                "api.prod.example.com:6443",
                "api.prod.example.com",
            ],
        ),
        (
            "https://127.0.0.1:44921",
            vec!["https://127.0.0.1:44921", "127.0.0.1:44921"],
        ),
        (
            "https://localhost:6443",
            vec!["https://localhost:6443", "localhost:6443"],
        ),
        (
            "https://[::1]:6443",
            vec!["https://[::1]:6443", "[::1]:6443"],
        ),
        ("https://127.0.0.1", vec!["https://127.0.0.1"]),
    ] {
        assert_eq!(server_names(server), names, "{server}");
    }

    let known = Known {
        names: server_names("https://127.0.0.1:44921")
            .into_iter()
            .map(|text| name(&text, Kind::Server, "https://127.0.0.1:44921"))
            .collect(),
        ..Known::default()
    };
    let mut redactor = Redactor::new(known, []);
    assert_eq!(
        redactor.text(
            "a forward listens on 127.0.0.1:8080, the proxy on 127.0.0.1:53712, the server on 127.0.0.1:44921"
        ),
        "a forward listens on 127.0.0.1:8080, the proxy on 127.0.0.1:53712, the server on <server-1>"
    );
}

fn write(directory: &Path, name: &str, lines: impl IntoIterator<Item = String>) -> PathBuf {
    let path = directory.join(name);
    let text: String = lines.into_iter().map(|line| format!("{line}\n")).collect();
    std::fs::write(&path, text).unwrap();
    path
}

fn numbered(prefix: &str, range: std::ops::Range<usize>) -> Vec<String> {
    range.map(|number| format!("{prefix}{number}")).collect()
}

#[test]
fn the_last_lines_reach_into_the_previous_file_and_stop_at_200_or_32_kib() {
    let directory = tempfile::tempdir().unwrap();
    let current = write(directory.path(), "twigo.log", numbered("now ", 0..150));
    let previous = write(directory.path(), "twigo.1.log", numbered("before ", 0..100));
    let files = [
        current.clone(),
        previous.clone(),
        directory.path().join("twigo.2.log"),
    ];
    let lines = log::tail(&files);
    assert_eq!(lines.len(), 200);
    assert_eq!(lines[0], "before 50");
    assert_eq!(lines[49], "before 99");
    assert_eq!(lines[50], "now 0");
    assert_eq!(lines[199], "now 149");

    let long = "x".repeat(999);
    let current = write(directory.path(), "twigo.log", (0..40).map(|_| long.clone()));
    let lines = log::tail(&[current, previous.clone()]);
    assert_eq!(lines.len(), 32, "32 KiB of 1,000 bytes a line");
    assert!(
        lines.iter().all(|line| line == &long),
        "a line cut in its middle is left out"
    );
    assert!(
        !lines.iter().any(|line| line.starts_with("before")),
        "no file is read past a gap"
    );
}

fn panic_record(location: &str) -> String {
    json!({
        "timestamp": "2026-11-22T21:14:03.123456Z",
        "level": "ERROR",
        "fields": { "message": "panic", "location": location, "payload": "bug" },
        "target": "twigo_log::panic",
    })
    .to_string()
}

fn started() -> String {
    json!({
        "timestamp": "2026-11-22T21:14:00.000000Z",
        "level": "INFO",
        "fields": { "message": "Twigo started" },
        "target": "twigo_log::facts",
    })
    .to_string()
}

#[test]
fn the_last_panic_is_the_newest_record_and_says_whether_this_run_wrote_it() {
    let directory = tempfile::tempdir().unwrap();
    let previous = write(
        directory.path(),
        "twigo.1.log",
        [
            started(),
            panic_record("crates/a.rs:1:1"),
            record(json!({ "message": "a panic was avoided" })),
        ],
    );
    let current = write(directory.path(), "twigo.log", [started()]);
    let files = [current.clone(), previous.clone()];

    let found = log::last_panic(&files).expect("the previous run's panic");
    assert_eq!(found.location, "crates/a.rs:1:1");
    assert!(!found.this_run);

    write(
        directory.path(),
        "twigo.log",
        [started(), panic_record("crates/b.rs:2:2")],
    );
    let found = log::last_panic(&files).expect("this run's panic");
    assert_eq!(found.location, "crates/b.rs:2:2");
    assert!(found.this_run);

    let quiet = write(directory.path(), "twigo.log", [started()]);
    assert!(log::last_panic(&[quiet]).is_none());
}

fn facts(commit: Option<&str>) -> Facts {
    Facts::detect("0.1.0", commit, Some("22625.2.8".to_owned()))
}

#[test]
fn the_facts_state_this_run_and_the_ones_that_may_go_are_marked() {
    let directory = tempfile::tempdir().unwrap();
    let current = write(directory.path(), "twigo.log", [started()]);
    let versions = BTreeSet::from(["v1.37.2".to_owned(), "v1.33.4-eks-2d5f260".to_owned()]);
    let detected = facts(Some("3f2a9c1d4e5b60718293a4b5c6d7e8f901234567"));
    let stated = stated(&detected, std::slice::from_ref(&current), &versions, &[]);
    let shown: Vec<(FactId, &str, &str, bool)> = stated
        .iter()
        .map(|fact| {
            (
                fact.id,
                fact.label.as_str(),
                fact.value.as_str(),
                fact.optional,
            )
        })
        .collect();
    let system = format!(
        "{} {} ({})",
        detected.os, detected.os_version, detected.arch
    );
    let engine = format!("{} 22625.2.8", detected.engine);
    assert_eq!(
        shown,
        [
            (FactId::Twigo, "Twigo", "0.1.0 (3f2a9c1)", false),
            (FactId::System, "System", system.as_str(), false),
            (FactId::Engine, "Engine", engine.as_str(), false),
            (
                FactId::Kubernetes,
                "Kubernetes",
                "v1.33.4-eks-2d5f260, v1.37.2",
                true
            ),
        ]
    );
}

#[test]
fn a_build_without_a_commit_says_so_and_a_panic_is_named_from_the_home_folder() {
    let directory = tempfile::tempdir().unwrap();
    let current = write(
        directory.path(),
        "twigo.log",
        [
            started(),
            panic_record(
                "/Users/alice/.cargo/registry/src/index.crates.io-1/tokio-1.54.1/src/a.rs:9:5",
            ),
        ],
    );
    let stated = stated(
        &facts(None),
        &[current],
        &BTreeSet::new(),
        &["/Users/alice".to_owned()],
    );
    assert_eq!(stated[0].value, "0.1.0 (local build)");
    let last = stated.last().unwrap();
    assert_eq!(last.id, FactId::LastPanic);
    assert!(last.optional);
    assert_eq!(
        last.value,
        "~/.cargo/registry/src/index.crates.io-1/tokio-1.54.1/src/a.rs:9:5 (this run)"
    );
    assert!(
        !stated.iter().any(|fact| fact.id == FactId::Kubernetes),
        "no cluster asked, no versions"
    );
}

fn fact(id: FactId, label: &str, value: &str) -> twigo_ipc::Fact {
    super::fact(id, label, value.to_owned(), true)
}

#[test]
fn the_link_is_the_bare_template_without_facts_and_carries_what_was_ticked() {
    let (bare, cut) = issue::link(&[], None, None);
    assert_eq!(
        bare,
        "https://github.com/twigo/twigo/issues/new?template=bug_report.yml"
    );
    assert!(cut.facts_cut.is_empty() && !cut.description_cut);

    let facts = [
        fact(FactId::Twigo, "Twigo", "0.1.0 (3f2a9c1)"),
        fact(FactId::Kubernetes, "Kubernetes", "v1.37.2, v1.33.4"),
    ];
    let (url, _) = issue::link(&facts, Some(" It crashes "), Some("Open a space"));
    assert_eq!(
        url,
        "https://github.com/twigo/twigo/issues/new?template=bug_report.yml\
         &title=It%20crashes\
         &environment=Twigo%3A%200%2E1%2E0%20%283f2a9c1%29%0AKubernetes%3A%20v1%2E37%2E2%2C%20v1%2E33%2E4\
         &description=Open%20a%20space"
    );
    let (url, _) = issue::link(&facts, Some("  "), Some(""));
    assert!(
        !url.contains("title=") && !url.contains("description="),
        "{url}"
    );
}

#[test]
fn a_link_past_the_budget_cuts_the_longest_facts_first_and_then_the_description() {
    let versions = (0..150)
        .map(|n| format!("v1.{n}.0-eks-2d5f260"))
        .collect::<Vec<_>>()
        .join(", ");
    let facts = [
        fact(FactId::Twigo, "Twigo", "0.1.0 (3f2a9c1)"),
        fact(FactId::Kubernetes, "Kubernetes", &versions),
    ];

    let (url, cut) = issue::link(&facts, None, Some(&"a".repeat(3000)));
    assert!(url.len() <= 6000, "{}", url.len());
    assert_eq!(cut.facts_cut, [FactId::Kubernetes]);
    assert!(
        !cut.description_cut,
        "the description was whole while a fact could still be cut"
    );
    assert!(url.contains(&"a".repeat(3000)));
    assert!(
        url.contains("Twigo%3A%200%2E1%2E0%20%283f2a9c1%29"),
        "a short fact stays whole"
    );

    let (url, cut) = issue::link(&facts, None, Some(&"b".repeat(20_000)));
    assert!(url.len() <= 6000 && url.len() > 5000, "{}", url.len());
    assert!(cut.description_cut);
    assert_eq!(cut.facts_cut, [FactId::Kubernetes]);
    assert!(
        url.ends_with("%E2%80%A6"),
        "the description ends with an ellipsis"
    );
}

#[test]
fn the_form_the_link_fills_has_the_fields_it_names() {
    let template = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.github/ISSUE_TEMPLATE")
            .join(issue::TEMPLATE),
    )
    .unwrap();
    let form: serde_json::Value = serde_saphyr::from_str(&template).unwrap();
    let field = |id: &str| {
        form["body"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["id"] == id)
            .unwrap_or_else(|| panic!("the template has no field {id}"))
    };
    for id in [issue::ENVIRONMENT, issue::DESCRIPTION] {
        assert_eq!(field(id)["type"], "textarea", "{id}");
    }
    assert_eq!(field(issue::ENVIRONMENT)["attributes"]["render"], "text");
}

#[test]
fn a_report_is_saved_as_twigo_report_with_the_date() {
    let name = file_name();
    let date = name
        .strip_prefix("twigo-report-")
        .and_then(|rest| rest.strip_suffix(".txt"))
        .expect(&name);
    assert!(date.parse::<jiff::civil::Date>().is_ok(), "{name}");
}

#[tokio::test]
async fn a_core_hides_the_names_its_catalog_and_its_state_hold() {
    use std::ffi::OsString;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::watch;
    use twigo_env::{ShellEnv, Status};

    let directory = tempfile::tempdir().unwrap();
    let kubeconfig = directory.path().join("config");
    std::fs::write(
        &kubeconfig,
        "
clusters: [{ name: prod-eu-cluster, cluster: { server: 'https://api.prod.example.com:6443' } }]
users: [{ name: oidc-alice, user: { token: t } }]
contexts: [{ name: prod-eu, context: { cluster: prod-eu-cluster, user: oidc-alice, namespace: payments } }]
",
    )
    .unwrap();
    let core = Core::new(
        directory.path(),
        &directory.path().join("cache"),
        &directory.path().join("policy.json"),
    );
    core.state.open_space("gone-context");
    core.state
        .set(vec![twigo_ipc::StateEntry {
            space: Some("gone-context".to_owned()),
            key: "namespaces".to_owned(),
            value: r#"["billing-eu"]"#.to_owned(),
        }])
        .unwrap();
    let saved = serde_json::from_value(json!({ "forwards": [{
        "id": 1,
        "target": {
            "space": "gone-context",
            "gvr": { "group": "", "version": "v1", "resource": "services" },
            "namespace": "checkout",
            "name": "payments-api",
        },
        "kind": "Service",
        "port": 8080,
        "port_name": null,
        "app_protocol": null,
        "local": 8080,
        "detour": false,
        "runs": true,
    }] }))
    .unwrap();
    core.state.set_forwards("gone-context", &saved).unwrap();
    let (status, followed) = watch::channel(Status::Resolving);
    core.start_for_tests(followed, None);
    status.send_replace(Status::Resolved(Arc::new(ShellEnv::from_iter([(
        OsString::from("KUBECONFIG"),
        kubeconfig.into_os_string(),
    )]))));
    tokio::time::timeout(
        Duration::from_secs(5),
        core.catalog.subscribe().wait_for(Option::is_some),
    )
    .await
    .expect("the catalog lists the context")
    .unwrap();

    let log = write(
        directory.path(),
        "twigo.log",
        [record(json!({
            "message": "api.prod.example.com refused oidc-alice for payments, prod-eu-cluster and gone-context, on billing-eu and Service payments-api in checkout",
        }))],
    );
    let report = core.report(&facts(None), &[log]).await;
    assert!(
        report.log.ends_with(
            "<server-1> refused <user-1> for <namespace-1>, <cluster-1> and <context-1>, \
             on <namespace-2> and Service <object-1> in <namespace-3>\n"
        ),
        "{}",
        report.log
    );
    assert_eq!(report.hidden.names, 8);
}

#[tokio::test]
async fn only_the_facts_left_ticked_go_in_the_link() {
    let directory = tempfile::tempdir().unwrap();
    let core = Core::new(
        directory.path(),
        &directory.path().join("cache"),
        &directory.path().join("policy.json"),
    );
    let run = facts(None);
    let ask = |ticked: Vec<FactId>| {
        core.report_issue(
            &run,
            &[],
            OpenIssue {
                facts: ticked,
                title: None,
                description: None,
            },
        )
    };
    let (url, _) = ask(vec![FactId::Engine, FactId::Kubernetes]).await;
    assert!(
        url.contains("Engine%3A") && !url.contains("Twigo%3A"),
        "{url}"
    );
    assert!(!url.contains("Kubernetes"), "no cluster was asked: {url}");
    let (bare, _) = ask(vec![]).await;
    assert!(!bare.contains("environment"), "{bare}");
}

/// The report the mock answers is what Rust renders from the log above, so
/// that the dialog shows the same text in the mock as in the app.
#[test]
fn the_mock_answers_the_report_rust_renders() {
    let directory = tempfile::tempdir().unwrap();
    let log = directory.path().join("twigo.log");
    std::fs::write(&log, LOG).unwrap();
    let run = Facts {
        version: "0.1.0".to_owned(),
        commit: "3f2a9c1d4e5b60718293a4b5c6d7e8f901234567".to_owned(),
        os: "Mac OS".to_owned(),
        os_version: "27.2.1".to_owned(),
        arch: "aarch64",
        engine: "WebKit",
        engine_version: Some("22625.2.8.11.9".to_owned()),
    };
    let versions = BTreeSet::from(["v1.37.2".to_owned(), "v1.33.4-eks-2d5f260".to_owned()]);
    let report = assemble(&run, &[log], &versions, known());
    let rendered = serde_json::to_string_pretty(&report).unwrap() + "\n";

    let mock =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src/mock/report.json");
    if std::env::var_os("TWIGO_UPDATE_REPORT").is_some() {
        std::fs::write(&mock, &rendered).unwrap();
    }
    assert!(
        std::fs::read_to_string(&mock).is_ok_and(|mock| mock == rendered),
        "run TWIGO_UPDATE_REPORT=1 cargo test -p twigo-core --lib report::tests::the_mock_answers"
    );
}

#[test]
fn a_message_of_several_lines_stays_under_its_record() {
    let (text, _) = rendered(&[&record(json!({ "message": "first\nsecond", "count": 2 }))]);
    assert_eq!(
        text,
        "2026-11-22T21:14:03Z WARN  twigo_core::state first\n    second count=2\n"
    );
}

#[tokio::test]
async fn a_report_is_written_as_it_is_and_a_failure_says_its_code() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("twigo-report.txt");
    super::write("what the person saw\n", &path).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "what the person saw\n"
    );
    let error = super::write("text", directory.path()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::FileUnwritten);
}
