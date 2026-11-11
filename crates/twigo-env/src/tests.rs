//! Fake shells: `/bin/sh` scripts that act out a startup file, then run the
//! command line they were given, which their POSIX syntax can `eval`.

use std::os::unix::fs::PermissionsExt;
use std::time::Duration as StdDuration;

use nix::errno::Errno;
use nix::sys::signal::kill;
use tempfile::TempDir;

use super::*;

struct Fakes {
    dir: TempDir,
}

impl Fakes {
    fn new() -> Self {
        let fakes = Self {
            dir: tempfile::tempdir().expect("a directory"),
        };
        // Prints its frame as Twigo's `--dump-env` does.
        fakes.script(
            "twigo",
            r#"[ "$1" = --dump-env ] || exit 2; printf %s%s "$2" "$3"; /usr/bin/env -0; printf %s%s "$2" "$3""#,
        );
        fakes
    }

    fn script(&self, name: &str, body: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        let draft = self.dir.path().join(format!("{name}.draft"));
        std::fs::write(&draft, format!("#!/bin/sh\n{body}\n")).expect("a draft");
        let copied = std::process::Command::new("/bin/cp")
            .arg(&draft)
            .arg(&path)
            .status()
            .expect("cp");
        assert!(copied.success());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    async fn resolve(&self, shell: &Path) -> Result<ShellEnv, Failure> {
        resolve_with(shell, Some(&self.path("twigo")), TIMEOUT).await
    }
}

#[tokio::test]
async fn noise_around_the_frame_is_left_out() {
    let fakes = Fakes::new();
    let shell = fakes.script(
        "sh",
        r#"echo 'Last login: today'; echo 'warning: no completion' >&2
export FROM_RC=1
eval "$4"
echo 'bye'"#,
    );
    let env = fakes.resolve(&shell).await.expect("an environment");
    assert_eq!(env.get("FROM_RC"), Some(OsStr::new("1")));
}

#[tokio::test]
async fn values_keep_their_newlines() {
    let fakes = Fakes::new();
    let shell = fakes.script("sh", "export MULTI='one\n\ntwo\n'; eval \"$4\"");
    let env = fakes.resolve(&shell).await.expect("an environment");
    assert_eq!(env.get("MULTI"), Some(OsStr::new("one\n\ntwo\n")));
}

#[tokio::test]
async fn a_prompt_reads_no_input_and_the_shell_goes_on() {
    let fakes = Fakes::new();
    let shell = fakes.script(
        "sh",
        r#"printf 'Update now? [Y/n] '
read answer && exit 9
export ANSWERED="${answer:-none}"
eval "$4""#,
    );
    let env = fakes.resolve(&shell).await.expect("an environment");
    assert_eq!(env.get("ANSWERED"), Some(OsStr::new("none")));
}

#[tokio::test]
async fn a_failed_re_exec_falls_back_to_env() {
    let fakes = Fakes::new();
    let log = fakes.path("calls");
    let shell = fakes.script(
        "sh",
        &format!(
            r#"printf '%s\n' "$4" >> '{}'
export FROM_RC=1
eval "$4""#,
            log.display()
        ),
    );
    let env = resolve_with(&shell, Some(&fakes.path("gone")), TIMEOUT)
        .await
        .expect("an environment");
    assert_eq!(env.get("FROM_RC"), Some(OsStr::new("1")));
    let calls = std::fs::read_to_string(&log).expect("the calls");
    let calls: Vec<_> = calls.lines().collect();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].contains("/gone' '--dump-env'"), "{calls:?}");
    assert!(calls[1].contains("'/bin/sh' '-c'"), "{calls:?}");
}

#[tokio::test]
async fn a_shell_that_prints_no_environment_fails_with_its_output() {
    let fakes = Fakes::new();
    let shell = fakes.script("sh", "echo 'rc: broken'; exit 3");
    let failure = fakes.resolve(&shell).await.expect_err("no environment");
    assert!(
        matches!(failure.reason, Reason::NoEnvironment(status) if status.code() == Some(3)),
        "{failure}"
    );
    assert_eq!(failure.output, "rc: broken\nrc: broken\n");
}

#[tokio::test]
async fn a_missing_shell_fails_to_start() {
    let fakes = Fakes::new();
    let failure = fakes
        .resolve(&fakes.path("no-shell"))
        .await
        .expect_err("no shell");
    assert!(matches!(failure.reason, Reason::Start(_)), "{failure}");
}

#[tokio::test(start_paused = true)]
async fn a_shell_that_never_returns_is_killed_with_its_group_at_the_timeout() {
    let fakes = Fakes::new();
    let pid = fakes.path("pid");
    let shell = fakes.script(
        "sh",
        &format!(
            "echo 'Continue? [y/N]'\nsleep 1000 &\necho $! > '{}'\nwait",
            pid.display()
        ),
    );
    let started = Instant::now();
    let resolving = tokio::spawn(async move { resolve_with(&shell, None, TIMEOUT).await });
    tokio::task::yield_now().await;
    // The clock stays put while this blocks the runtime, so the child
    // reaches `wait` before the timeout can fire.
    let sleeper = wait_for_pid(&pid);

    let failure = resolving.await.expect("the task").expect_err("a timeout");
    assert!(matches!(failure.reason, Reason::Timeout), "{failure}");
    assert_eq!(started.elapsed(), TIMEOUT);
    assert_eq!(failure.output, "Continue? [y/N]\n");
    assert_gone(sleeper);
}

fn wait_for_pid(file: &Path) -> Pid {
    for _ in 0..500 {
        if let Ok(text) = std::fs::read_to_string(file)
            && let Ok(pid) = text.trim().parse()
        {
            return Pid::from_raw(pid);
        }
        std::thread::sleep(StdDuration::from_millis(10));
    }
    panic!("the fake shell wrote no pid");
}

/// Killed, and reaped by init once its parent is gone.
fn assert_gone(pid: Pid) {
    for _ in 0..500 {
        if kill(pid, None) == Err(Errno::ESRCH) {
            return;
        }
        std::thread::sleep(StdDuration::from_millis(10));
    }
    panic!("{pid} outlived the timeout");
}

#[tokio::test]
async fn a_traced_command_line_is_not_taken_for_the_frame() {
    let fakes = Fakes::new();
    let shell = fakes.script("sh", "set -x\nexport FROM_RC=1\neval \"$4\"");
    let env = fakes.resolve(&shell).await.expect("an environment");
    assert_eq!(env.get("FROM_RC"), Some(OsStr::new("1")));
    let fallback = resolve_with(&shell, Some(&fakes.path("gone")), TIMEOUT)
        .await
        .expect("an environment");
    assert_eq!(fallback.get("FROM_RC"), Some(OsStr::new("1")));
}

#[tokio::test]
async fn the_fallback_shares_the_first_run_s_deadline() {
    let fakes = Fakes::new();
    let shell = fakes.script(
        "sh",
        "case \"$4\" in *--dump-env*) sleep 0.6; exit 1;; esac\nsleep 1000",
    );
    let started = std::time::Instant::now();
    let failure = resolve_with(&shell, Some(&fakes.path("twigo")), Duration::from_secs(1))
        .await
        .expect_err("a timeout");
    assert!(matches!(failure.reason, Reason::Timeout), "{failure}");
    let elapsed = started.elapsed();
    assert!(elapsed < StdDuration::from_millis(1400), "{elapsed:?}");
}

/// bash, `/bin/sh` on macOS, turns tracing on from an exported `SHELLOPTS`;
/// dash, `/bin/sh` on Debian and Ubuntu, ignores it.
#[tokio::test]
async fn an_exported_shellopts_does_not_trace_into_the_fallback_frame() {
    let fakes = Fakes::new();
    let shell = fakes.script("sh", "set -x\nexport SHELLOPTS\neval \"$4\"");
    let env = resolve_with(&shell, Some(&fakes.path("gone")), TIMEOUT)
        .await
        .expect("an environment");
    let mangled: Vec<_> = env
        .iter()
        .filter(|(name, _)| name.as_encoded_bytes().contains(&b'\n'))
        .collect();
    assert!(mangled.is_empty(), "{mangled:?}");
    assert!(env.get("PATH").is_some());
}

#[test]
fn a_terminal_starts_a_login_shell_on_macos_only() {
    let zsh = terminal_args(Path::new("/bin/zsh"));
    let pwsh = terminal_args(Path::new("/usr/local/bin/pwsh"));
    if cfg!(target_os = "macos") {
        assert_eq!((zsh, pwsh), (&["-l"][..], &["-Login"][..]));
    } else {
        assert_eq!((zsh, pwsh), (&[][..], &[][..]));
    }
}

#[test]
fn a_locale_in_utf_8_is_the_system_s_without_keywords_where_the_system_has_it() {
    let has = |name: &str| ["uk_UA.UTF-8", "en_GB.UTF-8"].contains(&name);
    assert_eq!(in_utf8(Some("uk_UA"), has), "uk_UA.UTF-8");
    assert_eq!(in_utf8(Some("en_GB@rg=uszzzz"), has), "en_GB.UTF-8");
    assert_eq!(in_utf8(Some("zh-Hans_CN"), has), "en_US.UTF-8");
    assert_eq!(in_utf8(None, has), "en_US.UTF-8");
}

#[test]
fn a_terminal_s_utf_8_locale_is_one_the_system_has() {
    let locale = utf8_locale();
    if cfg!(target_os = "macos") {
        assert!(
            Path::new("/usr/share/locale").join(&locale).is_dir(),
            "{locale}"
        );
    } else {
        assert_eq!(locale, "C.UTF-8");
    }
}
