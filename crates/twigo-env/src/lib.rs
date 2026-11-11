//! The environment of the user's login shell (ARCHITECTURE 6.1). An app
//! started from the Dock gets launchd's minimal `PATH`, so Twigo asks the
//! login shell to run Twigo again with `--dump-env`, reads the environment
//! that copy was given, and hands it to every child process it starts.
//! Twigo's own process environment is never changed.

mod environment;
mod frame;
mod shell;
mod terminal;
#[cfg(test)]
mod tests;

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};

use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, Uid, User, setsid};
use tokio::io::AsyncReadExt;
use tokio::net::unix::pipe;
use tokio::process::Command;
use tokio::time::{Duration, Instant, timeout_at};

pub use environment::{Environment, Status};
use frame::Vars;
use shell::Syntax;
pub use terminal::Startup;

/// The argument that makes Twigo print its environment and exit, followed
/// by the two halves of the marker to frame it with; `main()` checks for it
/// before anything else starts.
pub const DUMP_ENV: &str = "--dump-env";

/// Long enough for slow startup files, short enough that one which waits
/// for input, or runs `exec tmux`, does not hold Twigo up for long.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// An environment is far smaller; past this a startup file is printing
/// without end.
const MAX_PRINTED: usize = 4 << 20;

/// How much of a failed shell's output a failure keeps.
const OUTPUT_TAIL: usize = 16 << 10;

/// The environment that child processes get.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellEnv(Vars);

impl ShellEnv {
    /// Twigo's own environment, for when the login shell's is unknown.
    pub fn from_process() -> Self {
        Self(std::env::vars_os().collect())
    }

    pub fn get(&self, name: impl AsRef<OsStr>) -> Option<&OsStr> {
        self.0.get(name.as_ref()).map(OsString::as_os_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&OsStr, &OsStr)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str()))
    }
}

impl FromIterator<(OsString, OsString)> for ShellEnv {
    fn from_iter<I: IntoIterator<Item = (OsString, OsString)>>(vars: I) -> Self {
        Self(vars.into_iter().collect())
    }
}

/// Prints this process's environment framed by the marker whose halves
/// are `head` and `tail`, for [`DUMP_ENV`].
pub fn dump(head: &OsStr, tail: &OsStr) -> io::Result<()> {
    let marker = [head.as_encoded_bytes(), tail.as_encoded_bytes()].concat();
    frame::write(&marker, std::env::vars_os(), &mut io::stdout().lock())
}

/// The user's shell from the password database, as login(1) starts it;
/// `/bin/sh` where it names none.
pub fn login_shell() -> PathBuf {
    User::from_uid(Uid::current())
        .ok()
        .flatten()
        .map(|user| user.shell)
        .filter(|shell| !shell.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

/// The arguments a terminal starts `shell` with, as VS Code's profiles start
/// it: a login shell on macOS, whose terminal apps start login shells, and
/// none on Linux, where the desktop session has read the login files.
pub fn terminal_args(shell: &Path) -> &'static [&'static str] {
    match Syntax::of(shell) {
        _ if !cfg!(target_os = "macos") => &[],
        Syntax::Pwsh => &["-Login"],
        Syntax::Posix | Syntax::Fish | Syntax::Nu | Syntax::Xonsh => &["-l"],
    }
}

/// The `LANG` a terminal gets where nothing names UTF-8: the system locale
/// in UTF-8 on macOS, when the system has that locale, else `en_US.UTF-8`,
/// and `C.UTF-8` on Linux, which glibc has built in.
pub fn utf8_locale() -> String {
    #[cfg(target_os = "macos")]
    {
        let system = objc2_core_foundation::CFLocale::current()
            .and_then(|locale| locale.identifier())
            .map(|id| id.to_string());
        in_utf8(system.as_deref(), |name| {
            Path::new("/usr/share/locale").join(name).is_dir()
        })
    }
    #[cfg(not(target_os = "macos"))]
    "C.UTF-8".to_owned()
}

/// A locale identifier, which may carry keywords (`en_GB@rg=uszzzz`), as
/// the name of its UTF-8 locale, if `exists`.
#[cfg(any(target_os = "macos", test))]
fn in_utf8(identifier: Option<&str>, exists: impl Fn(&str) -> bool) -> String {
    identifier
        .and_then(|id| id.split('@').next())
        .map(|id| format!("{id}.UTF-8"))
        .filter(|name| exists(name))
        .unwrap_or_else(|| "en_US.UTF-8".to_owned())
}

#[derive(Debug, thiserror::Error)]
#[error("{} {reason}", shell.display())]
pub struct Failure {
    pub shell: PathBuf,
    pub reason: Reason,
    /// The end of what the shell printed, without the environment.
    pub output: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Reason {
    #[error("did not answer in {} s", TIMEOUT.as_secs())]
    Timeout,
    #[error("could not be started: {0}")]
    Start(#[source] io::Error),
    #[error("could not be read: {0}")]
    Read(#[source] io::Error),
    #[error("printed no environment ({0})")]
    NoEnvironment(ExitStatus),
    #[error("printed more than {} MiB without an environment", MAX_PRINTED >> 20)]
    TooMuchOutput,
}

/// Runs `shell` as a login and interactive shell and returns the
/// environment a program it starts gets. If the shell cannot run Twigo's
/// own binary, it runs `/usr/bin/env -0` instead. Both runs share one
/// [`TIMEOUT`].
pub async fn resolve(shell: &Path) -> Result<ShellEnv, Failure> {
    resolve_with(shell, std::env::current_exe().ok().as_deref(), TIMEOUT).await
}

/// [`resolve`], with `exe` standing in for Twigo's binary.
async fn resolve_with(
    shell: &Path,
    exe: Option<&Path>,
    timeout: Duration,
) -> Result<ShellEnv, Failure> {
    let deadline = Instant::now() + timeout;
    // The marker goes to the shell in two halves and frames the environment
    // whole, so a shell that echoes its command lines (`set -x`) never
    // prints it.
    let head = OsString::from(format!("{:016x}", fastrand::u64(..)));
    let tail = OsString::from(format!("{:016x}", fastrand::u64(..)));
    let marker = [head.as_encoded_bytes(), tail.as_encoded_bytes()].concat();
    let mut earlier = String::new();
    if let Some(exe) = exe {
        let dump = [exe.as_os_str(), OsStr::new(DUMP_ENV), &head, &tail];
        match run(shell, &dump, &marker, deadline).await {
            Err(Failure {
                reason: Reason::NoEnvironment(_),
                output,
                ..
            }) => earlier = output,
            resolved => return resolved,
        }
    }
    let env = [
        OsStr::new("/bin/sh"),
        OsStr::new("-c"),
        // bash as `/bin/sh` traces when an exported `SHELLOPTS` says so.
        OsStr::new(r#"set +x; printf %s%s "$1" "$2"; /usr/bin/env -0; printf %s%s "$1" "$2""#),
        OsStr::new("sh"),
        &head,
        &tail,
    ];
    run(shell, &env, &marker, deadline)
        .await
        .map_err(|mut failure| {
            failure.output = earlier + &failure.output;
            failure
        })
}

async fn run(
    shell: &Path,
    call: &[&OsStr],
    marker: &[u8],
    deadline: Instant,
) -> Result<ShellEnv, Failure> {
    let failure = |reason, output: &[u8]| Failure {
        shell: shell.to_owned(),
        reason,
        output: tail(output),
    };
    let (mut child, mut printed) =
        spawn(shell, call).map_err(|error| failure(Reason::Start(error), b""))?;
    let group = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .map(Pid::from_raw);

    let mut buffer = Vec::new();
    let read = async {
        loop {
            if let Some(vars) = frame::scan(&buffer, marker) {
                return Ok(ShellEnv(vars));
            }
            if buffer.len() > MAX_PRINTED {
                return Err(Reason::TooMuchOutput);
            }
            match printed.read_buf(&mut buffer).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => return Err(Reason::Read(error)),
            }
        }
        match child.wait().await {
            Ok(status) => Err(Reason::NoEnvironment(status)),
            Err(error) => Err(Reason::Read(error)),
        }
    };
    let reason = match timeout_at(deadline, read).await {
        Ok(Ok(env)) => return Ok(env),
        Ok(Err(reason)) => reason,
        Err(_) => {
            // The shell and everything its startup files left running.
            if let Some(group) = group
                && let Err(error) = killpg(group, Signal::SIGKILL)
            {
                eprintln!("could not stop {}: {error}", shell.display());
            }
            if let Err(error) = child.wait().await {
                eprintln!("could not reap {}: {error}", shell.display());
            }
            Reason::Timeout
        }
    };
    Err(failure(
        reason,
        &buffer[..frame::output_len(&buffer, marker)],
    ))
}

/// The shell in a session of its own, and so in a process group of its own
/// and without a controlling terminal, without input, its stdout and stderr
/// on one pipe so that what it prints keeps its order. An interactive shell
/// in a mere process group of its own, started from a terminal as Twigo is
/// by `pnpm tauri dev`, stops when it first touches the terminal.
fn spawn(shell: &Path, call: &[&OsStr]) -> io::Result<(tokio::process::Child, pipe::Receiver)> {
    let (reader, writer) = io::pipe()?;
    let mut command = Command::new(shell);
    command
        .args(Syntax::of(shell).args(call))
        .stdin(Stdio::null())
        .stdout(writer.try_clone()?)
        .stderr(writer);
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            setsid()?;
            Ok(())
        });
    }
    let child = command.spawn()?;
    // The command holds the pipe's write end until it is dropped, and the
    // reader sees the end of the output only once every write end closed.
    drop(command);
    Ok((child, pipe::Receiver::from_owned_fd(reader.into())?))
}

fn tail(output: &[u8]) -> String {
    let start = output.len().saturating_sub(OUTPUT_TAIL);
    String::from_utf8_lossy(&output[start..]).into_owned()
}
