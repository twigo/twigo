//! A terminal's program, spawned on a new pty as the leader of a session of
//! its own, the pty its controlling terminal (pty-process's `setsid` and
//! `TIOCSCTTY`). It starts with no signal blocked, every catchable signal at
//! its default, and every descriptor above 2 closed on exec: a child inherits
//! the mask of the thread that forks it, which std no longer resets
//! ([`do_exec`]), the signals the parent ignores, and every descriptor not
//! marked close-on-exec.
//!
//! [`do_exec`]: https://github.com/rust-lang/rust/blob/1.99.1/library/std/src/sys/process/unix/unix.rs#L357-L358

use std::io;
use std::ops::RangeInclusive;
use std::os::fd::AsFd;

use libc::c_int;
use nix::unistd::Pid;
use pty_process::{Pty, Size};
use tokio::process::Child;

use super::Spec;
use super::hangup::Hangup;

pub(super) struct Spawned {
    pub pty: Pty,
    pub child: Child,
    pub hangup: Hangup,
}

pub(super) fn spawn(spec: &Spec, size: Size) -> pty_process::Result<Spawned> {
    let (pty, pts) = pty_process::open()?;
    pty.resize(size)?;
    let master = pty.as_fd().try_clone_to_owned()?;
    // Twigo's own, taken before the spawn drops the crate's: macOS drops
    // what nobody has read from a pty once its last slave closes.
    let slave = pts.as_fd().try_clone_to_owned()?;
    let signals = signals();
    let command = pty_process::Command::new(&spec.program)
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .current_dir(&spec.cwd);
    // SAFETY: `reset` makes only async-signal-safe calls and allocates
    // nothing, as the child of a process with threads must.
    let command = unsafe { command.pre_exec(move || reset(signals.clone())) };
    let child = command.spawn(pts)?;
    let id = child
        .id()
        .expect("a child is not reaped before it is waited for");
    let shell = Pid::from_raw(i32::try_from(id).expect("a pid fits an i32"));
    Ok(Spawned {
        pty,
        child,
        hangup: Hangup::new(shell, master, slave),
    })
}

/// Every signal number: Darwin's `NSIG` is 32, and Linux has real-time
/// signals up to `SIGRTMAX`.
fn signals() -> RangeInclusive<c_int> {
    #[cfg(target_os = "macos")]
    let last = 31;
    #[cfg(target_os = "linux")]
    let last = libc::SIGRTMAX();
    1..=last
}

fn reset(signals: RangeInclusive<c_int>) -> io::Result<()> {
    // SAFETY: system calls on values of this frame.
    unsafe {
        let mut none: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut none);
        let error = libc::pthread_sigmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        let mut default: libc::sigaction = std::mem::zeroed();
        default.sa_sigaction = libc::SIG_DFL;
        for signal in signals {
            // EINVAL is a signal nobody can catch: SIGKILL, SIGSTOP and those
            // glibc keeps for its threads.
            if libc::sigaction(signal, &default, std::ptr::null_mut()) == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINVAL) {
                    return Err(error);
                }
            }
        }
    }
    close_on_exec()
}

/// Marked, not closed: std reports a failed `exec` over a close-on-exec pipe
/// of its own.
#[cfg(target_os = "linux")]
fn close_on_exec() -> io::Result<()> {
    // SAFETY: a system call that takes no pointer.
    let marked = unsafe {
        libc::syscall(
            libc::SYS_close_range,
            3 as libc::c_uint,
            libc::c_uint::MAX,
            libc::CLOSE_RANGE_CLOEXEC,
        )
    };
    if marked == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Marked, not closed: std reports a failed `exec` over a close-on-exec pipe
/// of its own. A number no descriptor holds fails with EBADF.
#[cfg(target_os = "macos")]
fn close_on_exec() -> io::Result<()> {
    // SAFETY: system calls that take no pointer.
    unsafe {
        for fd in 3..libc::getdtablesize() {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    Ok(())
}
