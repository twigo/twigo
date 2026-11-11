//! The shells a terminal starts, run on a pty of their own with the
//! arguments, environment and files `Startup` gives them, over a home of
//! fixture startup files, while the test types into them. What the typed
//! commands find goes to files beside the home, so the terminal's own
//! output only shows when a test fails. zsh and bash must be on `PATH`;
//! fish and pwsh run where they are.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nix::pty::{Winsize, openpty};
use nix::sys::termios::{LocalFlags, tcgetattr};
use nix::unistd::setsid;
use twigo_env::Startup;

const KUBECONFIG: &str = "/data/terminals/1/kube config:/home/it's/.kube/config";
const WAIT: Duration = Duration::from_secs(30);

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

fn required(name: &str) -> PathBuf {
    on_path(name).unwrap_or_else(|| panic!("{name} is not on PATH"))
}

fn installed(name: &str) -> Option<PathBuf> {
    let found = on_path(name);
    if found.is_none() {
        eprintln!("{name} is not on PATH: its cases did not run");
    }
    found
}

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fixture = Self {
            root: tempfile::tempdir().expect("a directory"),
        };
        for dir in ["home", "terminal", "out"] {
            std::fs::create_dir(fixture.root.path().join(dir)).expect("a directory");
        }
        fixture
    }

    fn home(&self) -> PathBuf {
        self.root.path().join("home")
    }

    fn terminal(&self) -> PathBuf {
        self.root.path().join("terminal")
    }

    fn out(&self, name: &str) -> PathBuf {
        self.root.path().join("out").join(name)
    }

    fn write(&self, path: &str, text: &str) {
        let path = self.home().join(path);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
        std::fs::write(path, text).expect("a startup file");
    }

    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.out(name))
            .unwrap_or_else(|error| panic!("{name}: {error}"))
            .trim_end_matches('\n')
            .to_owned()
    }

    fn ran(&self) -> Vec<String> {
        self.read("ran").lines().map(str::to_owned).collect()
    }

    fn record(&self, name: &str) -> String {
        format!("echo {name} >> '{}'\n", self.out("ran").display())
    }

    fn run(&self, shell: &Path, login: bool, extra: &[(&str, &OsStr)], typed: &str) -> String {
        let flag = if shell.ends_with("pwsh") {
            "-Login"
        } else {
            "-l"
        };
        let args: Vec<OsString> = if login { vec![flag.into()] } else { vec![] };
        let zdotdir = extra
            .iter()
            .find(|(name, _)| *name == "ZDOTDIR")
            .map(|(_, value)| *value);
        let startup = Startup::of(
            shell,
            &args,
            OsStr::new(KUBECONFIG),
            &self.terminal(),
            zdotdir,
        )
        .unwrap_or_else(|| panic!("{} keeps no KUBECONFIG", shell.display()));
        for (name, text) in &startup.files {
            std::fs::write(self.terminal().join(name), text).expect("Twigo's file");
        }
        let mut command = Command::new(shell);
        command
            .args(&startup.args)
            .env_clear()
            .env("HOME", self.home())
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("TERM", "xterm-256color")
            .env("LANG", "en_US.UTF-8")
            .env("KUBECONFIG", KUBECONFIG)
            // Ubuntu's /etc/zsh/zshrc runs compinit unless this is set, and on the CI
            // runner compinit found insecure directories and took the first key typed
            // as the answer to its question.
            .env("skip_global_compinit", "1")
            .envs(extra.iter().copied())
            .envs(startup.env.iter().map(|(name, value)| (name, value)))
            .current_dir(self.home());
        let shell_name = shell.display().to_string();
        let output = on_a_pty(command, typed);
        output.unwrap_or_else(|output| panic!("{shell_name} did not end in time:\n{output}"))
    }
}

fn on_a_pty(mut command: Command, typed: &str) -> Result<String, String> {
    let size = Winsize {
        ws_row: 24,
        ws_col: 200,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = openpty(Some(&size), None).expect("a pty");
    command
        .stdin(Stdio::from(pty.slave.try_clone().expect("a slave")))
        .stdout(Stdio::from(pty.slave.try_clone().expect("a slave")))
        .stderr(Stdio::from(pty.slave));
    // SAFETY: setsid and ioctl are async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            setsid()?;
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().expect("the shell starts");
    drop(command);
    let mut master = File::from(pty.master);
    let mut answers = master.try_clone().expect("the master");
    let mut typing = master.try_clone().expect("the master");
    let printed = Arc::new(Mutex::new(Vec::new()));
    let reader = std::thread::spawn({
        let printed = Arc::clone(&printed);
        move || {
            let mut buffer = [0; 4096];
            while let Ok(read @ 1..) = master.read(&mut buffer) {
                let chunk = &buffer[..read];
                for (query, answer) in [
                    (&b"\x1b[6n"[..], &b"\x1b[1;1R"[..]),
                    (b"\x1b[c", b"\x1b[?62;22c"),
                    (b"\x1b[0c", b"\x1b[?62;22c"),
                ] {
                    if chunk.windows(query.len()).any(|window| window == query) {
                        let _ = answers.write_all(answer);
                    }
                }
                printed.lock().expect("printed").extend_from_slice(chunk);
            }
        }
    });
    let deadline = Instant::now() + WAIT;
    while tcgetattr(&typing).is_ok_and(|mode| mode.local_flags.contains(LocalFlags::ICANON))
        && Instant::now() < deadline
        && child.try_wait().expect("wait").is_none()
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = typing.write_all(typed.as_bytes());
    let ended = loop {
        if child.try_wait().expect("wait").is_some() {
            break true;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let until = Instant::now() + Duration::from_secs(2);
    while !reader.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    let printed = String::from_utf8_lossy(&printed.lock().expect("printed")).into_owned();
    if ended { Ok(printed) } else { Err(printed) }
}

fn posix_typed(fixture: &Fixture) -> String {
    format!(
        "printf '%s\\n' \"$KUBECONFIG\" > '{}'; twigo_alias > '{}'; twigo_function > '{}'; exit\n",
        fixture.out("kubeconfig").display(),
        fixture.out("alias").display(),
        fixture.out("function").display(),
    )
}

fn assert_kept_and_theirs_ran(fixture: &Fixture, output: &str) {
    assert_eq!(fixture.read("kubeconfig"), KUBECONFIG, "{output}");
    assert_eq!(fixture.read("alias"), "from an alias", "{output}");
    assert_eq!(fixture.read("function"), "from a function", "{output}");
}

const THEIR_DEFINITIONS: &str = "alias twigo_alias='echo from an alias'
twigo_function() { echo from a function; }
";

#[test]
fn zsh_keeps_the_terminal_s_kubeconfig_after_each_startup_file_that_exports_one() {
    let zsh = required("zsh");
    for login in [false, true] {
        let fixture = Fixture::new();
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let mut text = fixture.record(name);
            text.push_str(&format!("export KUBECONFIG=/theirs/{name}\n"));
            if name == ".zshrc" {
                text.push_str(THEIR_DEFINITIONS);
            }
            fixture.write(name, &text);
        }
        let output = fixture.run(&zsh, login, &[], &posix_typed(&fixture));
        assert_kept_and_theirs_ran(&fixture, &output);
        let read = if login {
            &[".zshenv", ".zprofile", ".zshrc", ".zlogin"][..]
        } else {
            &[".zshenv", ".zshrc"][..]
        };
        assert_eq!(fixture.ran(), read, "login {login}: {output}");
    }
}

#[test]
fn zsh_keeps_the_terminal_s_kubeconfig_with_nounset_and_no_histfile_from_any_file_before_its_line()
{
    let zsh = required("zsh");
    for login in [false, true] {
        let read = if login {
            &[".zshenv", ".zprofile", ".zshrc", ".zlogin"][..]
        } else {
            &[".zshenv", ".zshrc"][..]
        };
        for strict in read {
            let fixture = Fixture::new();
            for name in read {
                let mut text = fixture.record(name);
                if name == strict {
                    text.push_str("setopt nounset no_global_rcs\n");
                }
                text.push_str(&format!("export KUBECONFIG=/theirs/{name}\n"));
                if *name == ".zshrc" {
                    text.push_str(THEIR_DEFINITIONS);
                }
                fixture.write(name, &text);
            }
            let output = fixture.run(&zsh, login, &[], &posix_typed(&fixture));
            assert_eq!(
                fixture.ran(),
                read,
                "nounset in {strict}, login {login}: {output}"
            );
            assert_kept_and_theirs_ran(&fixture, &output);
        }
    }
}

#[test]
fn bash_keeps_the_terminal_s_kubeconfig_after_the_startup_files_it_reads() {
    let bash = required("bash");
    for login in [false, true] {
        let fixture = Fixture::new();
        let file = if login { ".bash_profile" } else { ".bashrc" };
        fixture.write(
            file,
            &format!(
                "{}export KUBECONFIG=/theirs\n{THEIR_DEFINITIONS}",
                fixture.record(file)
            ),
        );
        let output = fixture.run(&bash, login, &[], &posix_typed(&fixture));
        assert_kept_and_theirs_ran(&fixture, &output);
        assert_eq!(fixture.ran(), [file], "{output}");
    }
}

#[test]
fn bash_as_a_login_shell_reads_the_first_profile_there_is_and_bashrc_only_through_it() {
    let bash = required("bash");
    let cases: [(&[&str], &[&str], &[&str]); 4] = [
        (
            &[".bash_profile", ".bash_login", ".profile", ".bashrc"],
            &[],
            &[".bash_profile"],
        ),
        (
            &[".bash_profile", ".bashrc"],
            &[".bash_profile"],
            &[".bash_profile", ".bashrc"],
        ),
        (&[".bash_login", ".profile"], &[], &[".bash_login"]),
        (&[".profile", ".bashrc"], &[], &[".profile"]),
    ];
    for (files, sourcing, read) in cases {
        let fixture = Fixture::new();
        for file in files {
            let mut text = fixture.record(file);
            if sourcing.contains(file) {
                text.push_str(". ~/.bashrc\n");
            }
            fixture.write(file, &text);
        }
        let typed = format!(
            "printf '%s\\n' \"$KUBECONFIG\" > '{}'; exit\n",
            fixture.out("kubeconfig").display()
        );
        let output = fixture.run(&bash, true, &[], &typed);
        assert_eq!(fixture.ran(), read, "{files:?}: {output}");
        assert_eq!(fixture.read("kubeconfig"), KUBECONFIG, "{output}");
    }
}

fn zdotdir_typed(fixture: &Fixture) -> String {
    format!(
        "print -r -- ${{+ZDOTDIR}}:${{ZDOTDIR-}} > '{}'; print -r -- ${{HISTFILE-}} > '{}'; exit\n",
        fixture.out("zdotdir").display(),
        fixture.out("histfile").display()
    )
}

#[test]
fn zsh_ends_with_the_person_s_zdotdir_set_or_unset_and_reads_their_files_where_it_points() {
    let zsh = required("zsh");
    for login in [false, true] {
        let fixture = Fixture::new();
        fixture.write(".zshrc", &fixture.record("home"));
        let output = fixture.run(&zsh, login, &[], &zdotdir_typed(&fixture));
        assert_eq!(
            fixture.read("zdotdir"),
            "0:",
            "unset, login {login}: {output}"
        );
        assert_eq!(fixture.ran(), ["home"], "{output}");
        let terminal = fixture.terminal().display().to_string();
        let histfile = fixture.read("histfile");
        assert!(!histfile.starts_with(&terminal), "{histfile}: {output}");

        let fixture = Fixture::new();
        let elsewhere = fixture.root.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(elsewhere.join(".zshrc"), fixture.record("elsewhere")).unwrap();
        fixture.write(".zshrc", &fixture.record("home"));
        let output = fixture.run(
            &zsh,
            login,
            &[("ZDOTDIR", elsewhere.as_os_str())],
            &zdotdir_typed(&fixture),
        );
        assert_eq!(
            fixture.read("zdotdir"),
            format!("1:{}", elsewhere.display()),
            "set, login {login}: {output}"
        );
        assert_eq!(fixture.ran(), ["elsewhere"], "{output}");

        let fixture = Fixture::new();
        let config = fixture.home().join(".config").join("zsh");
        fixture.write(
            ".zshenv",
            &format!("{}ZDOTDIR=$HOME/.config/zsh\n", fixture.record(".zshenv")),
        );
        fixture.write(".zshrc", &fixture.record("home"));
        fixture.write(".config/zsh/.zshrc", &fixture.record("config"));
        fixture.write(".config/zsh/.zlogin", &fixture.record("config login"));
        let output = fixture.run(&zsh, login, &[], &zdotdir_typed(&fixture));
        assert_eq!(
            fixture.read("zdotdir"),
            format!("1:{}", config.display()),
            "moved, login {login}: {output}"
        );
        let read = if login {
            &[".zshenv", "config", "config login"][..]
        } else {
            &[".zshenv", "config"][..]
        };
        assert_eq!(fixture.ran(), read, "{output}");
    }
}

#[test]
fn a_startup_file_that_fails_leaves_the_shell_running_and_twigo_s_line_after_it() {
    let broken = |fixture: &Fixture, name: &str| {
        format!(
            "{}export KUBECONFIG=/theirs\nno_such_command_anywhere\nfalse\nif then fi (\n",
            fixture.record(name)
        )
    };
    let zsh = required("zsh");
    let bash = required("bash");
    for (shell, login, file) in [
        (&zsh, false, ".zshrc"),
        (&zsh, true, ".zlogin"),
        (&bash, false, ".bashrc"),
        (&bash, true, ".bash_profile"),
    ] {
        let fixture = Fixture::new();
        fixture.write(file, &broken(&fixture, file));
        let typed = format!(
            "printf '%s\\n' \"$KUBECONFIG\" > '{}'; exit\n",
            fixture.out("kubeconfig").display()
        );
        let output = fixture.run(shell, login, &[], &typed);
        assert_eq!(fixture.ran(), [file], "{output}");
        assert_eq!(fixture.read("kubeconfig"), KUBECONFIG, "{file}: {output}");
    }
}

#[test]
fn fish_sets_the_terminal_s_kubeconfig_after_its_configuration_where_installed() {
    let Some(fish) = installed("fish") else {
        return;
    };
    for login in [false, true] {
        let fixture = Fixture::new();
        fixture.write(
            ".config/fish/config.fish",
            &format!(
                "{}set -gx KUBECONFIG /theirs\nalias twigo_alias 'echo from an alias'\nfunction twigo_function; echo from a function; end\nno_such_command_anywhere\n",
                fixture.record("config.fish")
            ),
        );
        let typed = format!(
            "printf '%s\\n' \"$KUBECONFIG\" > '{}'; twigo_alias > '{}'; twigo_function > '{}'; exit\n",
            fixture.out("kubeconfig").display(),
            fixture.out("alias").display(),
            fixture.out("function").display(),
        );
        let output = fixture.run(&fish, login, &[], &typed);
        assert_kept_and_theirs_ran(&fixture, &output);
        assert_eq!(fixture.ran(), ["config.fish"], "{output}");
    }
}

#[test]
fn pwsh_sets_the_terminal_s_kubeconfig_after_its_profile_where_installed() {
    let Some(pwsh) = installed("pwsh") else {
        return;
    };
    for login in [false, true] {
        let fixture = Fixture::new();
        fixture.write(
            ".config/powershell/Microsoft.PowerShell_profile.ps1",
            &format!(
                "Add-Content -Path '{}' -Value profile\n$env:KUBECONFIG = '/theirs'\nSet-Alias twigo_alias Write-TwigoAlias\nfunction Write-TwigoAlias {{ 'from an alias' }}\nfunction twigo_function {{ 'from a function' }}\nthrow 'a profile that fails'\n",
                fixture.out("ran").display()
            ),
        );
        fixture.write(".profile", "export KUBECONFIG=/theirs/.profile\n");
        let typed = format!(
            "Set-Content -Path '{}' -Value $env:KUBECONFIG; twigo_alias > '{}'; twigo_function > '{}'; exit\r",
            fixture.out("kubeconfig").display(),
            fixture.out("alias").display(),
            fixture.out("function").display(),
        );
        let output = fixture.run(&pwsh, login, &[], &typed);
        assert_kept_and_theirs_ran(&fixture, &output);
        assert_eq!(fixture.ran(), ["profile"], "{output}");
    }
}
