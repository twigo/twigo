//! Fake plugins: `/bin/sh` scripts that count their runs in a file and
//! print an `ExecCredential`.

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use jiff::{SignedDuration, Timestamp};
use kube::config::Kubeconfig;
use secrecy::ExposeSecret;
use tempfile::TempDir;
use tokio::sync::watch;
use twigo_env::ShellEnv;

use super::*;

const V1: &str = "client.authentication.k8s.io/v1";

struct Plugins {
    dir: TempDir,
}

impl Plugins {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("a directory"),
        }
    }

    /// A script that notes each run, then runs `body`.
    fn script(&self, name: &str, body: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        let runs = self.runs_file();
        std::fs::write(
            &path,
            format!("#!/bin/sh\necho run >> '{}'\n{body}\n", runs.display()),
        )
        .expect("a script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn runs_file(&self) -> PathBuf {
        self.dir.path().join("runs")
    }

    fn runs(&self) -> usize {
        std::fs::read_to_string(self.runs_file())
            .map(|runs| runs.lines().count())
            .unwrap_or(0)
    }

    fn token(&self, name: &str, token: &str, expires: Option<Timestamp>) -> PathBuf {
        let expiry = expires
            .map(|at| format!(r#","expirationTimestamp":"{at}""#))
            .unwrap_or_default();
        self.script(
            name,
            &format!(
                r#"printf '%s' '{{"apiVersion":"{V1}","kind":"ExecCredential","status":{{"token":"{token}"{expiry}}}}}'"#
            ),
        )
    }
}

/// The exec plugin of a kubeconfig whose only user runs `command`.
fn exec_of(user: &str) -> Result<Option<Exec>, ExecError> {
    let config = Kubeconfig::from_yaml(&format!(
        "
clusters:
- name: c
  cluster:
    server: https://c.example:6443
    certificate-authority-data: Q0EK
    extensions:
    - name: client.authentication.k8s.io/exec
      extension: {{ audience: twigo }}
users:
- name: u
  user:
{user}
"
    ))
    .expect("a kubeconfig");
    Exec::of(
        "u",
        config.auth_infos[0].auth_info.as_ref().unwrap(),
        config.clusters[0].cluster.as_ref().unwrap(),
    )
}

fn exec(command: &Path, extra: &str) -> Exec {
    exec_of(&format!(
        "    exec:\n      apiVersion: {V1}\n      interactiveMode: Never\n      command: '{}'\n{extra}",
        command.display()
    ))
    .expect("a valid exec entry")
    .expect("an exec entry")
}

fn env(vars: &[(&str, &str)]) -> watch::Receiver<Option<Arc<ShellEnv>>> {
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    env.extend(vars.iter().map(|(name, value)| (name.into(), value.into())));
    watch::channel(Some(Arc::new(env.into_iter().collect()))).1
}

fn focused(focused: bool) -> watch::Receiver<bool> {
    watch::channel(focused).1
}

fn registry() -> Registry {
    Registry::new(env(&[]), focused(true), Timeouts::default())
}

fn token(credential: &Credential) -> &str {
    credential.token.as_ref().unwrap().expose_secret()
}

#[test]
fn entries_are_checked_as_client_go_checks_them() {
    let entry = |body: &str| exec_of(&format!("    exec:\n{body}"));
    assert_eq!(
        entry(&format!("      apiVersion: {V1}\n      command: aws")),
        Err(ExecError::MissingMode("u".to_owned())),
        "v1 has no default mode"
    );
    let beta = entry("      apiVersion: client.authentication.k8s.io/v1beta1\n      command: aws")
        .unwrap()
        .unwrap();
    assert_eq!(beta.mode(), Mode::IfAvailable);
    assert_eq!(
        entry("      apiVersion: client.authentication.k8s.io/v1alpha1\n      command: aws"),
        Err(ExecError::InvalidApiVersion(
            "client.authentication.k8s.io/v1alpha1".to_owned()
        ))
    );
    assert_eq!(
        entry(&format!(
            "      apiVersion: {V1}\n      interactiveMode: Never"
        )),
        Err(ExecError::MissingCommand("u".to_owned()))
    );
    assert_eq!(
        entry(&format!(
            "      apiVersion: {V1}\n      interactiveMode: Never\n      command: aws\n      env: [{{ value: x }}]"
        )),
        Err(ExecError::UnnamedEnv("u".to_owned()))
    );
}

#[test]
fn a_token_or_a_certificate_in_the_entry_wins_over_its_plugin() {
    let plugin = format!("    exec: {{ apiVersion: {V1}, interactiveMode: Never, command: aws }}");
    assert!(exec_of(&plugin).unwrap().is_some());
    assert_eq!(exec_of(&format!("{plugin}\n    token: t")), Ok(None));
    assert!(
        exec_of(&format!("{plugin}\n    token: ''"))
            .unwrap()
            .is_some(),
        "an empty token is no token"
    );
    assert_eq!(exec_of(&format!("{plugin}\n    username: admin")), Ok(None));
    assert_eq!(
        exec_of(&format!(
            "{plugin}\n    client-certificate-data: Yw==\n    client-key-data: aw=="
        )),
        Ok(None)
    );
    assert!(
        exec_of(&format!("{plugin}\n    client-certificate-data: Yw=="))
            .unwrap()
            .is_some(),
        "a certificate without its key is no client certificate"
    );
}

#[test]
fn the_exec_info_carries_the_cluster_only_when_asked() {
    let info = |extra: &str| -> serde_json::Value {
        let exec = exec(Path::new("/bin/true"), extra);
        serde_json::from_str(&exec.info()).unwrap()
    };
    assert_eq!(
        info(""),
        serde_json::json!({"kind": "ExecCredential", "apiVersion": V1, "spec": {"interactive": false}})
    );
    assert_eq!(
        info("      provideClusterInfo: true\n")["spec"]["cluster"],
        serde_json::json!({
            "server": "https://c.example:6443",
            "certificate-authority-data": "Q0EK",
            "config": {"audience": "twigo"},
        })
    );
}

#[test]
fn trust_follows_the_command_its_arguments_and_its_environment() {
    let digest = |extra: &str| exec(Path::new("/usr/local/bin/aws"), extra).trust_digest();
    let plain = digest("");
    assert_eq!(plain, digest("      installHint: brew install awscli\n"));
    assert_ne!(plain, digest("      args: [eks, get-token]\n"));
    assert_ne!(
        plain,
        digest("      env: [{ name: AWS_PROFILE, value: prod }]\n")
    );
    assert_ne!(plain, exec(Path::new("/opt/aws"), "").trust_digest());
}

#[test]
fn output_is_read_by_client_go_s_rules() {
    let parse = |text: &str| output::parse(text.as_bytes(), ApiVersion::V1);
    let json = parse(&format!(
        r#"{{"apiVersion":"{V1}","kind":"ExecCredential","status":{{"token":"t","expirationTimestamp":"2030-01-02T03:04:05.678Z"}}}}"#
    ))
    .unwrap();
    assert_eq!(token(&json), "t");
    assert_eq!(
        json.expires(),
        Some("2030-01-02T03:04:05.678Z".parse().unwrap())
    );
    let yaml = parse(&format!(
        "apiVersion: {V1}\nstatus:\n  token: first\n  extra: ignored\n  token: y\n"
    ))
    .unwrap();
    assert_eq!(token(&yaml), "y", "the last of a repeated key");
    assert!(
        parse(r#"{"status":{"token":"t"}}"#).is_ok(),
        "no apiVersion"
    );

    assert_eq!(
        parse(r#"{"apiVersion":"client.authentication.k8s.io/v1beta1","status":{"token":"t"}}"#)
            .unwrap_err(),
        OutputError::ApiVersion {
            configured: V1,
            returned: "client.authentication.k8s.io/v1beta1".to_owned(),
        }
    );
    assert_eq!(
        parse(r#"{"kind":"ExecCredential"}"#).unwrap_err(),
        OutputError::NoStatus
    );
    assert_eq!(
        parse(r#"{"status":{"token":""}}"#).unwrap_err(),
        OutputError::Empty
    );
    assert_eq!(
        parse(r#"{"status":{"clientKeyData":"k"}}"#).unwrap_err(),
        OutputError::HalfPair
    );
    assert!(matches!(
        parse(r#"{"status":{"token":"t","expirationTimestamp":"tomorrow"}}"#),
        Err(OutputError::Expiry(_))
    ));
    let Err(OutputError::Decode(message)) =
        parse("status:\n  token: s3cr3t-token\n  expirationTimestamp: [1, 2]\n")
    else {
        panic!("broken output does not decode");
    };
    assert!(!message.contains("s3cr3t"), "{message}");
}

#[test]
fn a_certificate_and_its_key_come_as_pem() {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["twigo".to_owned()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let text = serde_json::json!({
        "status": {"clientCertificateData": cert.pem(), "clientKeyData": key.serialize_pem(), "token": "both"},
    })
    .to_string();
    let credential = output::parse(text.as_bytes(), ApiVersion::V1).unwrap();
    let identity = credential.identity.as_ref().unwrap();
    assert_eq!(identity.chain, [cert.der().clone()]);
    assert_eq!(
        token(&credential),
        "both",
        "a token and a certificate together"
    );
}

#[tokio::test]
async fn the_plugin_gets_the_shell_environment_its_entry_s_and_no_input() {
    let plugins = Plugins::new();
    let script = plugins.script(
        "plugin",
        r#"read line && exit 9
case "$KUBERNETES_EXEC_INFO" in *'"interactive":false'*) ;; *) exit 8 ;; esac
printf '{"status":{"token":"%s-%s"}}' "$FROM_SHELL" "$OVERRIDDEN""#,
    );
    let registry = Registry::new(
        env(&[("FROM_SHELL", "shell"), ("OVERRIDDEN", "shell")]),
        focused(true),
        Timeouts::default(),
    );
    let source = registry.source(exec(
        &script,
        "      env: [{ name: OVERRIDDEN, value: entry }]\n",
    ));
    assert_eq!(token(&source.credential().await.unwrap()), "shell-entry");
}

#[tokio::test]
async fn a_bare_command_is_found_on_the_shell_s_path() {
    let plugins = Plugins::new();
    plugins.token("only-in-shell-path", "found", None);
    let path = format!(
        "{}:{}",
        plugins.dir.path().display(),
        std::env::var("PATH").unwrap()
    );
    let registry = Registry::new(env(&[("PATH", &path)]), focused(true), Timeouts::default());
    let source = registry.source(exec(Path::new("only-in-shell-path"), ""));
    assert_eq!(token(&source.credential().await.unwrap()), "found");

    let missing = registry.source(exec(Path::new("twigo-no-such-plugin"), ""));
    assert_eq!(
        missing.credential().await.unwrap_err(),
        CredentialError::Run(RunError::NotFound("twigo-no-such-plugin".to_owned()))
    );
    assert!(missing.exec().on_path());
}

#[tokio::test]
async fn concurrent_first_requests_share_one_run() {
    let plugins = Plugins::new();
    let script = plugins.script(
        "slow",
        r#"sleep 0.3; printf '{"status":{"token":"shared"}}'"#,
    );
    let source = registry().source(exec(&script, ""));
    let credentials = join_all((0..10).map(|_| source.credential())).await;
    assert!(
        credentials
            .iter()
            .all(|c| token(c.as_ref().unwrap()) == "shared")
    );
    assert_eq!(plugins.runs(), 1);

    let failing = plugins.script("failing", "sleep 0.3; echo 'no such profile' >&2; exit 3");
    let source = registry().source(exec(&failing, ""));
    let failures = join_all((0..10).map(|_| source.credential())).await;
    assert!(failures.iter().all(Result::is_err));
    assert_eq!(plugins.runs(), 2, "waiters share a failure too");
    assert_eq!(
        *source.status().borrow(),
        Status::Failed {
            error: RunError::Exit {
                command: failing.display().to_string(),
                status: "exit code 3".to_owned(),
            },
            output: "no such profile\n".to_owned(),
        }
    );
}

#[tokio::test]
async fn contexts_naming_the_same_plugin_share_its_credential() {
    let plugins = Plugins::new();
    let script = plugins.token("shared", "one", None);
    let registry = registry();
    let a = registry.source(exec(&script, ""));
    let b = registry.source(exec(&script, ""));
    a.credential().await.unwrap();
    b.credential().await.unwrap();
    assert_eq!(plugins.runs(), 1);
    let other = registry.source(exec(&script, "      args: [other]\n"));
    other.credential().await.unwrap();
    assert_eq!(plugins.runs(), 2);
}

#[tokio::test]
async fn a_credential_is_kept_until_a_minute_before_it_expires() {
    let plugins = Plugins::new();
    let lasting = plugins.token(
        "lasting",
        "t",
        Some(Timestamp::now() + SignedDuration::from_hours(1)),
    );
    let source = registry().source(exec(&lasting, ""));
    source.credential().await.unwrap();
    source.credential().await.unwrap();
    assert_eq!(plugins.runs(), 1);
    assert!(matches!(
        *source.status().borrow(),
        Status::Ready { expires: Some(_) }
    ));

    let ending = plugins.token(
        "ending",
        "t",
        Some(Timestamp::now() + SignedDuration::from_secs(50)),
    );
    let source = registry().source(exec(&ending, ""));
    source.credential().await.unwrap();
    source.credential().await.unwrap();
    assert_eq!(plugins.runs(), 3);
}

#[tokio::test]
async fn a_rejected_credential_is_dropped_unless_already_replaced() {
    let plugins = Plugins::new();
    let script = plugins.token("plugin", "t", None);
    let source = registry().source(exec(&script, ""));
    let first = source.credential().await.unwrap();
    source.reject(&first);
    assert_eq!(*source.status().borrow(), Status::Idle);
    let second = source.credential().await.unwrap();
    assert_eq!(plugins.runs(), 2);
    source.reject(&first);
    assert!(Arc::ptr_eq(&second, &source.credential().await.unwrap()));
    assert_eq!(plugins.runs(), 2);
}

#[tokio::test]
async fn a_plugin_that_needs_a_terminal_never_runs() {
    let plugins = Plugins::new();
    let script = plugins.token("terminal", "t", None);
    let always = exec_of(&format!(
        "    exec: {{ apiVersion: {V1}, interactiveMode: Always, command: '{}' }}",
        script.display()
    ))
    .unwrap()
    .unwrap();
    let source = registry().source(always);
    assert_eq!(
        source.credential().await.unwrap_err(),
        CredentialError::Run(RunError::NeedsTerminal)
    );
    assert_eq!(plugins.runs(), 0);
}

#[tokio::test]
async fn endless_output_is_cut_off() {
    let plugins = Plugins::new();
    let script = plugins.script("chatty", "exec yes");
    let source = registry().source(exec(&script, ""));
    assert_eq!(
        source.credential().await.unwrap_err(),
        CredentialError::Run(RunError::TooMuchOutput(script.display().to_string()))
    );
}

/// The script's background child notes its pid, so the test can see the
/// whole group go.
fn hanging(plugins: &Plugins) -> PathBuf {
    let pid = plugins.dir.path().join("child");
    plugins.script(
        "hanging",
        &format!("sleep 1000 & echo $! > '{}'; wait", pid.display()),
    )
}

/// Waits for the pid the script's child noted.
async fn child(plugins: &Plugins) -> nix::unistd::Pid {
    loop {
        if let Ok(pid) = std::fs::read_to_string(plugins.dir.path().join("child"))
            && let Ok(pid) = pid.trim().parse()
        {
            return nix::unistd::Pid::from_raw(pid);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Whether `pid` ends within a second: the kernel reaps an orphan's
/// zombie a moment after it dies.
async fn gone(pid: nix::unistd::Pid) -> bool {
    for _ in 0..100 {
        if nix::sys::signal::kill(pid, None) == Err(nix::errno::Errno::ESRCH) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn a_plugin_that_never_answers_is_killed_with_its_group_at_the_timeout() {
    let plugins = Plugins::new();
    let script = hanging(&plugins);
    let timeout = Duration::from_secs(1);
    let timeouts = Timeouts {
        unattended: Duration::from_secs(60),
        sign_in: timeout,
    };
    let source = Registry::new(env(&[]), focused(true), timeouts).source(exec(&script, ""));
    let waiting = tokio::spawn({
        let source = Arc::clone(&source);
        async move { source.credential().await }
    });
    let pid = child(&plugins).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("the run ends")
            .unwrap()
            .unwrap_err(),
        CredentialError::Run(RunError::Timeout {
            command: script.display().to_string(),
            after: timeout,
        })
    );
    assert!(gone(pid).await);
}

#[tokio::test]
async fn a_cancel_ends_the_run() {
    let plugins = Plugins::new();
    let script = hanging(&plugins);
    let source = registry().source(exec(&script, ""));
    let waiting = tokio::spawn({
        let source = Arc::clone(&source);
        async move { source.credential().await }
    });
    let pid = child(&plugins).await;
    source.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("the run ends")
            .unwrap()
            .unwrap_err(),
        CredentialError::Run(RunError::Cancelled(script.display().to_string()))
    );
    assert!(gone(pid).await);
}

#[test]
fn only_plugins_known_never_to_ask_run_unattended() {
    let asks = |command: &str, args: &[&str], env: &[(&str, &str)]| {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        sign_in::needs(command, &args, &env)
    };
    assert!(!asks(
        "/usr/local/bin/aws",
        &[
            "--region",
            "eu-west-1",
            "eks",
            "get-token",
            "--cluster-name",
            "prod"
        ],
        &[]
    ));
    assert!(asks("aws", &["sso", "login"], &[]));
    assert!(!asks(
        "aws-iam-authenticator",
        &["token", "-i", "prod"],
        &[]
    ));
    assert!(!asks("gke-gcloud-auth-plugin", &[], &[]));
    assert!(!asks(
        "doctl",
        &[
            "kubernetes",
            "cluster",
            "kubeconfig",
            "exec-credential",
            "--version=v1beta1",
            "id"
        ],
        &[]
    ));
    assert!(asks(
        "doctl",
        &[
            "kubernetes",
            "cluster",
            "kubeconfig",
            "exec-credential",
            "--sso-issuer-url=https://sso",
            "id"
        ],
        &[]
    ));
    assert!(!asks(
        "oci",
        &["ce", "cluster", "generate-token", "--cluster-id", "x"],
        &[]
    ));
    assert!(!asks("pinniped", &["login", "static", "--token=t"], &[]));
    assert!(asks(
        "pinniped",
        &["login", "oidc", "--issuer=https://id"],
        &[]
    ));
    assert!(asks(
        "tsh",
        &["kube", "credentials", "--kube-cluster=prod"],
        &[]
    ));

    let azure = ["get-token", "--server-id", "6dae42f8"];
    assert!(asks("kubelogin", &azure, &[]), "devicecode by default");
    assert!(asks(
        "kubelogin",
        &[&azure[..], &["--login", "interactive"]].concat(),
        &[]
    ));
    assert!(!asks(
        "kubelogin",
        &[&azure[..], &["-l", "azurecli"]].concat(),
        &[]
    ));
    assert!(!asks(
        "kubelogin",
        &[&azure[..], &["--login=workloadidentity"]].concat(),
        &[]
    ));
    assert!(
        asks(
            "kubelogin",
            &[&azure[..], &["--login", "spn"]].concat(),
            &[("AAD_LOGIN_METHOD", "devicecode")]
        ),
        "the environment wins over the flag"
    );
    assert!(!asks(
        "kubelogin",
        &[
            &azure[..],
            &["--login", "spn", "--disable-environment-override"]
        ]
        .concat(),
        &[("AAD_LOGIN_METHOD", "devicecode")]
    ));

    let issuer = [
        "get-token",
        "--oidc-issuer-url=https://id",
        "--oidc-client-id=twigo",
    ];
    assert!(asks(
        "kubectl",
        &[&["oidc-login"][..], &issuer[..]].concat(),
        &[]
    ));
    assert!(
        asks("kubelogin", &issuer, &[]),
        "int128's kubelogin, by its issuer"
    );
    assert!(!asks(
        "kubectl-oidc_login",
        &[&issuer[..], &["--grant-type=client-credentials"]].concat(),
        &[]
    ));
    assert!(asks(
        "kubectl-oidc_login",
        &[
            &issuer[..],
            &["--grant-type", "password", "--username", "u"]
        ]
        .concat(),
        &[]
    ));
    assert!(!asks(
        "kubectl-oidc_login",
        &[
            &issuer[..],
            &[
                "--grant-type",
                "password",
                "--username",
                "u",
                "--password",
                "p"
            ]
        ]
        .concat(),
        &[]
    ));

    assert!(
        asks("/opt/company/k8s-token", &[], &[]),
        "an unknown command may ask"
    );
}

fn unattended(plugins: &Plugins, body: &str) -> PathBuf {
    plugins.script("gke-gcloud-auth-plugin", body)
}

#[tokio::test]
async fn a_plugin_that_may_ask_runs_only_while_the_window_has_the_focus() {
    let plugins = Plugins::new();
    let script = plugins.token("company-login", "t", None);
    let (focus, focused) = watch::channel(false);
    let source = Registry::new(env(&[]), focused, Timeouts::default()).source(exec(&script, ""));
    assert!(source.exec().sign_in());
    let waiting = tokio::spawn({
        let source = Arc::clone(&source);
        async move { source.credential().await }
    });
    let mut status = source.status();
    status
        .wait_for(|status| *status == Status::Waiting)
        .await
        .unwrap();
    assert_eq!(plugins.runs(), 0);
    focus.send_replace(true);
    assert_eq!(token(&waiting.await.unwrap().unwrap()), "t");
    assert_eq!(plugins.runs(), 1);

    let script = unattended(&plugins, r#"printf '{"status":{"token":"u"}}'"#);
    let source = Registry::new(env(&[]), watch::channel(false).1, Timeouts::default())
        .source(exec(&script, ""));
    assert_eq!(
        token(&source.credential().await.unwrap()),
        "u",
        "focus or not"
    );
}

#[tokio::test]
async fn after_a_failed_sign_in_the_plugin_waits_to_be_asked_again() {
    let plugins = Plugins::new();
    let script = plugins.script("company-login", "echo 'denied' >&2; exit 1");
    let source = registry().source(exec(&script, ""));
    let failed = RunError::Exit {
        command: script.display().to_string(),
        status: "exit code 1".to_owned(),
    };
    assert_eq!(
        source.credential().await.unwrap_err(),
        CredentialError::Run(failed.clone())
    );
    assert_eq!(
        source.credential().await.unwrap_err(),
        CredentialError::SignInFailed(failed)
    );
    assert_eq!(plugins.runs(), 1);
    source.sign_in();
    let mut status = source.status();
    status
        .wait_for(|status| matches!(status, Status::Failed { .. }))
        .await
        .unwrap();
    assert_eq!(plugins.runs(), 2);

    let script = unattended(&plugins, "exit 1");
    let source = registry().source(exec(&script, ""));
    assert!(source.credential().await.is_err());
    assert!(source.credential().await.is_err());
    assert_eq!(plugins.runs(), 4, "an unattended plugin runs again at once");
}

#[tokio::test]
async fn a_helper_left_holding_stderr_does_not_hold_the_credential() {
    let plugins = Plugins::new();
    let survived = plugins.dir.path().join("survived");
    let script = plugins.script(
        "helper",
        &format!(
            r#"(sleep 0.5; echo late >&2 && touch '{}') >/dev/null &
printf '{{"status":{{"token":"done"}}}}'"#,
            survived.display()
        ),
    );
    let timeouts = Timeouts {
        unattended: Duration::from_secs(2),
        sign_in: Duration::from_secs(2),
    };
    let source = Registry::new(env(&[]), focused(true), timeouts).source(exec(&script, ""));
    assert_eq!(token(&source.credential().await.unwrap()), "done");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(survived.exists(), "the helper's late write met a reader");
}

#[tokio::test]
async fn the_output_keeps_its_start_and_its_end() {
    let plugins = Plugins::new();
    let script = plugins.script(
        "verbose",
        r#"echo 'enter the code F3JQ7K9PL' >&2
i=0; while [ $i -lt 400 ]; do echo 'progress ................................................' >&2; i=$((i+1)); done
echo 'the last word' >&2
exit 1"#,
    );
    let source = registry().source(exec(&script, ""));
    assert!(source.credential().await.is_err());
    let Status::Failed { output, .. } = source.status().borrow().clone() else {
        panic!("the run failed");
    };
    assert!(
        output.starts_with("enter the code F3JQ7K9PL\n"),
        "{output:.60}"
    );
    assert!(output.contains("\n…\n"));
    assert!(output.ends_with("the last word\n"));
    assert!(output.len() < 17 << 10);
}

#[test]
fn the_login_shell_s_environment_can_make_a_plugin_ask() {
    let azure = exec(
        Path::new("kubelogin"),
        "      args: [get-token, --server-id, x, --login, azurecli]\n",
    );
    let shell = |vars: &[(&str, &str)]| -> ShellEnv {
        vars.iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    };
    assert!(!azure.signs_in_with(&shell(&[])));
    assert!(azure.signs_in_with(&shell(&[("AAD_LOGIN_METHOD", "devicecode")])));
}

#[tokio::test]
async fn the_plugins_under_way_die_with_the_app() {
    let plugins = Plugins::new();
    let script = hanging(&plugins);
    let registry = registry();
    let source = registry.source(exec(&script, ""));
    let waiting = tokio::spawn({
        let source = Arc::clone(&source);
        async move { source.credential().await }
    });
    let pid = child(&plugins).await;
    registry.shutdown();
    assert!(gone(pid).await);
    let ended = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .expect("the run ends")
        .unwrap();
    assert!(ended.is_err());
}
