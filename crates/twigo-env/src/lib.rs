//! The environment of the user's login shell (ARCHITECTURE 6.1). An app
//! started from the Dock gets launchd's minimal `PATH`, so Twigo asks the
//! login shell to run Twigo again with `--dump-env`, reads the environment
//! that copy was given, and hands it to every child process it starts.
//! Twigo's own process environment is never changed.

mod environment;
mod frame;
mod shell;
#[cfg(test)]
mod tests;

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};

use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, Uid, User};
use tokio::io::AsyncReadExt;
use tokio::net::unix::pipe;
use tokio::process::Command;
use tokio::time::{Duration, Instant, timeout_at};

pub use environment::{Environment, Status};
use frame::Vars;
use shell::Syntax;

/// The argument that makes Twigo print its environment and exit, followed
/// by the marker to frame it with; `main()` checks for it before anything
/// else starts.
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

/// Prints this process's environment framed by `marker`, for [`DUMP_ENV`].
pub fn dump(marker: &OsStr) -> io::Result<()> {
    frame::write(marker, std::env::vars_os(), &mut io::stdout().lock())
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
/// own binary, it runs `/usr/bin/env -0` instead.
pub async fn resolve(shell: &Path) -> Result<ShellEnv, Failure> {
    resolve_with(shell, std::env::current_exe().ok().as_deref()).await
}

/// [`resolve`], with `exe` standing in for Twigo's binary.
async fn resolve_with(shell: &Path, exe: Option<&Path>) -> Result<ShellEnv, Failure> {
    let marker = OsString::from(format!("{:032x}", fastrand::u128(..)));
    let mut earlier = String::new();
    if let Some(exe) = exe {
        let dump = [exe.as_os_str(), OsStr::new(DUMP_ENV), &marker];
        match run(shell, &[&dump], &marker).await {
            Err(Failure {
                reason: Reason::NoEnvironment(_),
                output,
                ..
            }) => earlier = output,
            resolved => return resolved,
        }
    }
    let printf = [OsStr::new("printf"), OsStr::new("%s"), &marker];
    let env = [OsStr::new("/usr/bin/env"), OsStr::new("-0")];
    run(shell, &[&printf, &env, &printf], &marker)
        .await
        .map_err(|mut failure| {
            failure.output = earlier + &failure.output;
            failure
        })
}

async fn run(shell: &Path, calls: &[&[&OsStr]], marker: &OsStr) -> Result<ShellEnv, Failure> {
    let deadline = Instant::now() + TIMEOUT;
    let failure = |reason, output: &[u8]| Failure {
        shell: shell.to_owned(),
        reason,
        output: tail(output),
    };
    let (mut child, mut printed) =
        spawn(shell, calls).map_err(|error| failure(Reason::Start(error), b""))?;
    let group = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .map(Pid::from_raw);

    let marker = marker.as_encoded_bytes();
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

/// The shell in its own process group, without input, its stdout and
/// stderr on one pipe so that what it prints keeps its order.
fn spawn(shell: &Path, calls: &[&[&OsStr]]) -> io::Result<(tokio::process::Child, pipe::Receiver)> {
    let (reader, writer) = io::pipe()?;
    let mut command = Command::new(shell);
    command
        .args(Syntax::of(shell).args(calls))
        .stdin(Stdio::null())
        .stdout(writer.try_clone()?)
        .stderr(writer)
        .process_group(0);
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
