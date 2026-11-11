use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Pid, getpgid};
use tempfile::TempDir;
use tokio::sync::mpsc;
use twigo_ipc::{ShellEnd, ShellEvent};

use super::{Spec, Terminal};
use crate::shell::Frame;

const WAIT: Duration = Duration::from_secs(10);

fn spec(dir: &Path, args: &[&str]) -> Spec {
    Spec {
        program: PathBuf::from("/bin/sh"),
        args: args.iter().map(OsString::from).collect(),
        env: [
            ("PATH", "/usr/bin:/bin"),
            ("TERM", "xterm-256color"),
            ("PS1", "$ "),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .chain([("HOME".into(), dir.into())])
        .collect(),
        cwd: dir.to_owned(),
    }
}

fn script(dir: &Path, script: &str) -> Spec {
    spec(dir, &["-c", script])
}

fn interactive(dir: &Path) -> Spec {
    spec(dir, &["-i"])
}

struct Opened {
    terminal: Terminal,
    frames: mpsc::UnboundedReceiver<Frame>,
    output: Vec<u8>,
}

impl Opened {
    fn new(spec: Spec) -> Self {
        let terminal = Terminal::park(spec);
        let (frames, received) = mpsc::unbounded_channel();
        terminal
            .open(80, 24, move |frame| frames.send(frame).is_ok())
            .unwrap();
        Self {
            terminal,
            frames: received,
            output: Vec::new(),
        }
    }

    async fn frame(&mut self) -> Frame {
        tokio::time::timeout(WAIT, self.frames.recv())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "a frame within 10 s, after {:?}",
                    String::from_utf8_lossy(&self.output)
                )
            })
            .expect("the terminal sends until it ends")
    }

    async fn until(&mut self, wanted: &[u8]) {
        while !contains(&self.output, wanted) {
            match self.frame().await {
                Frame::Output(bytes) => {
                    self.terminal.ack(bytes.len() as u32);
                    self.output.extend(bytes);
                }
                Frame::Event(ShellEvent::Running) => {}
                Frame::Event(event) => panic!(
                    "{event:?} before {:?} in {:?}",
                    String::from_utf8_lossy(wanted),
                    String::from_utf8_lossy(&self.output)
                ),
            }
        }
    }

    async fn end(&mut self) -> ShellEnd {
        loop {
            match self.frame().await {
                Frame::Output(bytes) => {
                    self.terminal.ack(bytes.len() as u32);
                    self.output.extend(bytes);
                }
                Frame::Event(ShellEvent::Ended { end }) => return end,
                Frame::Event(_) => {}
            }
        }
    }

    async fn typed(&self, text: &str) {
        self.terminal.input(text.as_bytes().to_vec()).await;
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

async fn wait_for_pid(file: &Path) -> Pid {
    for _ in 0..500 {
        if let Ok(text) = std::fs::read_to_string(file)
            && let Ok(pid) = text.trim().parse()
        {
            return Pid::from_raw(pid);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no pid in {}", file.display());
}

/// Whether `pid` ends within `within`: it is gone, or a zombie, as the
/// terminal keeps its shell unreaped through the kill's grace.
async fn gone(pid: Pid, within: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < within {
        if kill(pid, None) == Err(Errno::ESRCH) || zombie(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[cfg(target_os = "linux")]
fn zombie(pid: Pid) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rsplit_once(") ")
            .is_some_and(|(_, rest)| rest.starts_with('Z'))
    })
}

/// macOS 27.2 gives no `PROC_PIDTBSDINFO` of a zombie, which `kill` still
/// finds: `ESRCH`, as for a pid nobody has.
#[cfg(target_os = "macos")]
fn zombie(pid: Pid) -> bool {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid.as_raw(),
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    read <= 0 && Errno::last() == Errno::ESRCH
}

#[tokio::test]
async fn it_runs_then_typed_input_reaches_the_shell_and_its_output_comes_back() {
    let dir = TempDir::new().unwrap();
    let mut opened = Opened::new(interactive(dir.path()));
    assert_eq!(opened.frame().await, Frame::Event(ShellEvent::Running));
    opened.typed("echo $((6 * 7))\n").await;
    opened.until(b"42\r\n").await;
    opened.typed("exit 3\n").await;
    assert_eq!(opened.end().await, ShellEnd::Exited { code: 3 });
}

#[tokio::test]
async fn a_shell_a_signal_ends_says_which() {
    let dir = TempDir::new().unwrap();
    let mut opened = Opened::new(interactive(dir.path()));
    opened.typed("kill -KILL $$\n").await;
    assert_eq!(
        opened.end().await,
        ShellEnd::Signaled {
            signal: "KILL".to_owned()
        }
    );
}

#[tokio::test]
async fn a_program_that_cannot_start_ends_failed_in_words() {
    let dir = TempDir::new().unwrap();
    let mut spec = interactive(dir.path());
    spec.program = dir.path().join("missing");
    let mut opened = Opened::new(spec);
    let Frame::Event(ShellEvent::Ended {
        end: ShellEnd::Failed { error },
    }) = opened.frame().await
    else {
        panic!("not a failure");
    };
    assert!(
        error.message.starts_with(&format!(
            "could not start {}: ",
            dir.path().join("missing").display()
        )),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn a_resize_reaches_the_program() {
    let dir = TempDir::new().unwrap();
    let mut opened = Opened::new(script(
        dir.path(),
        "trap 'stty size' WINCH; echo ready; while :; do sleep 1 & wait $!; done",
    ));
    opened.until(b"ready\r\n").await;
    opened.terminal.resize(100, 40);
    opened.until(b"40 100\r\n").await;
}

#[tokio::test]
async fn a_full_screen_program_takes_the_alternate_screen_and_keys_and_leaves() {
    let dir = TempDir::new().unwrap();
    let mut opened = Opened::new(script(dir.path(), "exec vi"));
    opened.until(b"\x1b[?1049h").await;
    opened.typed("ihello from vi\x1b").await;
    opened.until(b"hello from vi").await;
    opened.typed(":q!\r").await;
    opened.until(b"\x1b[?1049l").await;
    assert_eq!(opened.end().await, ShellEnd::Exited { code: 0 });
}

#[tokio::test]
async fn closing_hangs_up_the_shell_and_its_foreground_job_at_once() {
    let dir = TempDir::new().unwrap();
    let opened = Opened::new(interactive(dir.path()));
    opened
        .typed("echo $$ > shell.pid; sh -c 'echo $$ > job.pid; exec sleep 1000'\n")
        .await;
    let shell = wait_for_pid(&dir.path().join("shell.pid")).await;
    let job = wait_for_pid(&dir.path().join("job.pid")).await;
    assert_eq!(
        getpgid(Some(job)),
        Ok(job),
        "the job leads a group of its own"
    );
    drop(opened);
    let within = Duration::from_secs(2);
    assert!(gone(shell, within).await, "the shell outlived its hangup");
    assert!(
        gone(job, within).await,
        "the foreground job outlived its hangup"
    );
}

#[tokio::test]
async fn the_foreground_job_of_a_shell_that_ignores_the_hangup_goes_at_once() {
    let dir = TempDir::new().unwrap();
    let opened = Opened::new(interactive(dir.path()));
    opened
        .typed(concat!(
            "trap '' HUP; ",
            r#"perl -e '$SIG{HUP} = "DEFAULT"; open my $f, ">", "job.pid"; print $f $$; close $f; exec "sleep", "1000"'"#,
            "\n",
        ))
        .await;
    let job = wait_for_pid(&dir.path().join("job.pid")).await;
    drop(opened);
    assert!(
        gone(job, Duration::from_secs(2)).await,
        "the job outlived its hangup"
    );
}

#[tokio::test]
async fn a_foreground_job_that_ignores_the_hangup_is_killed_3_s_later() {
    let dir = TempDir::new().unwrap();
    let opened = Opened::new(interactive(dir.path()));
    opened
        .typed("sh -c 'trap \"\" HUP; echo $$ > job.pid; exec sleep 1000'\n")
        .await;
    let job = wait_for_pid(&dir.path().join("job.pid")).await;
    let closed = Instant::now();
    drop(opened);
    assert!(
        !gone(job, Duration::from_millis(2500)).await,
        "killed before 3 s"
    );
    assert!(gone(job, Duration::from_secs(2)).await, "alive after 3 s");
    assert!(closed.elapsed() >= Duration::from_secs(3));
}

#[tokio::test]
async fn the_group_of_a_shell_that_ignores_the_hangup_is_killed_3_s_later() {
    let dir = TempDir::new().unwrap();
    let opened = Opened::new(script(
        dir.path(),
        "trap '' HUP; echo $$ > shell.pid; while :; do sleep 0.1; done",
    ));
    let shell = wait_for_pid(&dir.path().join("shell.pid")).await;
    drop(opened);
    assert!(
        !gone(shell, Duration::from_millis(2500)).await,
        "killed before 3 s"
    );
    assert!(gone(shell, Duration::from_secs(2)).await, "alive after 3 s");
}

#[tokio::test]
async fn a_terminal_closed_after_its_shell_ended_signals_nothing() {
    let dir = TempDir::new().unwrap();
    let mut opened = Opened::new(script(
        dir.path(),
        "trap '' HUP; echo $$ > shell.pid; sleep 1000 & echo $! > job.pid; exit 0",
    ));
    assert_eq!(opened.end().await, ShellEnd::Exited { code: 0 });
    let shell = wait_for_pid(&dir.path().join("shell.pid")).await;
    let job = wait_for_pid(&dir.path().join("job.pid")).await;
    assert_eq!(
        getpgid(Some(job)),
        Ok(shell),
        "the job is in the group that bears the shell's pid"
    );
    drop(opened);
    let spared = !gone(job, Duration::from_secs(4)).await;
    let _ = kill(job, Signal::SIGKILL);
    assert!(spared, "the group that bears the shell's pid was signalled");
}

/// Gives the ended shell's pid to an unrelated process group through
/// `ns_last_pid`, as heavy forking would by chance.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "writes /proc/sys/kernel/ns_last_pid, which needs CAP_SYS_ADMIN: crates/twigo-sessions/linux.sh runs it privileged"]
async fn a_terminal_closed_after_its_shell_ended_spares_whoever_has_its_pid_now() {
    use std::os::unix::process::CommandExt;
    let dir = TempDir::new().unwrap();
    let mut opened = Opened::new(script(dir.path(), "echo $$ > shell.pid; exit 0"));
    assert_eq!(opened.end().await, ShellEnd::Exited { code: 0 });
    let shell = wait_for_pid(&dir.path().join("shell.pid")).await;
    assert_eq!(kill(shell, None), Err(Errno::ESRCH), "reaped");
    let mut other = None;
    for _ in 0..50 {
        std::fs::write(
            "/proc/sys/kernel/ns_last_pid",
            (shell.as_raw() - 1).to_string(),
        )
        .unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("1000")
            .process_group(0)
            .spawn()
            .unwrap();
        if child.id() == shell.as_raw().unsigned_abs() {
            other = Some(child);
            break;
        }
        child.kill().unwrap();
        child.wait().unwrap();
    }
    let mut other = other.expect("the shell's pid given to another process group");
    drop(opened);
    tokio::time::sleep(Duration::from_secs(4)).await;
    let ended = other.try_wait().unwrap();
    other.kill().unwrap();
    other.wait().unwrap();
    assert_eq!(ended, None, "the process that has the shell's pid now");
}

#[test]
fn a_terminal_dropped_with_its_runtime_gone_hangs_up_its_foreground_job_at_once() {
    let dir = TempDir::new().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (opened, job) = runtime.block_on(async {
        let opened = Opened::new(interactive(dir.path()));
        opened
            .typed(concat!(
                "trap '' HUP; ",
                r#"perl -e '$SIG{HUP} = "DEFAULT"; open my $f, ">", "job.pid"; print $f $$; close $f; exec "sleep", "1000"'"#,
                "\n",
            ))
            .await;
        let job = wait_for_pid(&dir.path().join("job.pid")).await;
        (opened, job)
    });
    drop(runtime);
    drop(opened);
    let waiting = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    assert!(
        waiting.block_on(gone(job, Duration::from_secs(2))),
        "the job outlived its hangup"
    );
}

#[test]
fn a_terminal_dropped_with_its_runtime_gone_hangs_up_at_once_and_kills_nothing_later() {
    let dir = TempDir::new().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (opened, job) = runtime.block_on(async {
        let mut opened = Opened::new(script(
            dir.path(),
            "trap '' HUP; sh -c 'echo $$ > job.pid; exec sleep 1000' & echo started; wait",
        ));
        opened.until(b"started").await;
        let job = wait_for_pid(&dir.path().join("job.pid")).await;
        (opened, job)
    });
    drop(runtime);
    let closed = Instant::now();
    drop(opened);
    assert!(
        closed.elapsed() < Duration::from_millis(100),
        "the drop blocked"
    );
    let waiting = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let survived = !waiting.block_on(gone(job, Duration::from_secs(4)));
    assert!(survived, "killed with no runtime");
    kill(job, nix::sys::signal::Signal::SIGKILL).unwrap();
}

#[tokio::test]
async fn output_the_shell_left_unread_when_it_exited_arrives_once_acks_come() {
    let dir = TempDir::new().unwrap();
    let mut spec = spec(
        dir.path(),
        &[
            "-f",
            "-c",
            "head -c 262144 /dev/zero | tr '\\0' x; sleep 1; touch printing; printf '%0512d' 0",
        ],
    );
    spec.program = PathBuf::from("/bin/zsh");
    let mut opened = Opened::new(spec);
    let mut unacked = Vec::new();
    while unacked.iter().map(Vec::len).sum::<usize>() < 256 << 10 {
        match opened.frame().await {
            Frame::Output(bytes) => unacked.push(bytes),
            Frame::Event(ShellEvent::Running) => {}
            Frame::Event(event) => panic!("{event:?} before 256 KiB"),
        }
    }
    while !dir.path().join("printing").exists() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let unread = if cfg!(target_os = "macos") { 1500 } else { 300 };
    tokio::time::sleep(Duration::from_millis(unread)).await;
    for bytes in unacked {
        opened.terminal.ack(bytes.len() as u32);
        opened.output.extend(bytes);
    }
    assert_eq!(opened.end().await, ShellEnd::Exited { code: 0 });
    let count = |byte| opened.output.iter().filter(|b| **b == byte).count();
    assert_eq!((count(b'x'), count(b'0')), (256 << 10, 512));
}

#[test]
fn a_shell_started_from_a_thread_that_blocks_sigint_still_takes_ctrl_c() {
    let dir = TempDir::new().unwrap();
    let spec = script(dir.path(), "echo ready; exec sleep 30");
    std::thread::spawn(move || {
        let mut blocked = nix::sys::signal::SigSet::empty();
        blocked.add(nix::sys::signal::Signal::SIGINT);
        blocked.thread_block().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut opened = Opened::new(spec);
            opened.until(b"ready\r\n").await;
            let typed = Instant::now();
            opened.typed("\x03").await;
            assert_eq!(
                opened.end().await,
                ShellEnd::Signaled {
                    signal: "INT".to_owned()
                }
            );
            assert!(typed.elapsed() < Duration::from_secs(1));
        });
    })
    .join()
    .unwrap();
}

#[tokio::test]
async fn a_descriptor_twigo_holds_open_on_exec_does_not_reach_the_shell() {
    let leaked = unsafe { libc::dup(2) };
    assert!(leaked > 2);
    let listing = if cfg!(target_os = "macos") {
        "ls /dev/fd"
    } else {
        "ls /proc/self/fd"
    };
    let dir = TempDir::new().unwrap();
    let mut opened = Opened::new(script(dir.path(), listing));
    assert_eq!(opened.end().await, ShellEnd::Exited { code: 0 });
    unsafe { libc::close(leaked) };
    let mut held: Vec<i32> = String::from_utf8_lossy(&opened.output)
        .split_whitespace()
        .map(|fd| fd.parse().unwrap())
        .collect();
    held.sort_unstable();
    assert!(held.starts_with(&[0, 1, 2]), "{held:?}");
    assert!(!held.contains(&leaked), "{leaked} in {held:?}");
}
