//! A file that moves aside past a size and keeps a few of the older ones, as
//! the audit log and the diagnostics log are written.

use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use tracing_subscriber::fmt::MakeWriter;

/// How big a [`Rotating`] file may grow, and how many it keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The size past which the file moves aside.
    pub size: u64,
    /// How many files that moved aside stay: `<name>.1.<ext>` to
    /// `<name>.<kept>.<ext>`, the newest first.
    pub kept: usize,
}

/// What a [`Rotating`] could not do to its file.
#[derive(Debug)]
pub struct Failure<'a> {
    pub path: &'a Path,
    /// What could not be done and what follows, to read after the file's
    /// name: `could not be written`.
    pub what: &'static str,
    pub error: &'a io::Error,
}

impl fmt::Display for Failure<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self { path, what, error } = self;
        write!(f, "the log {} {what}: {error}", path.display())
    }
}

/// Says a failure on stderr, for the log that has no other place to say it.
pub(crate) fn to_stderr(failure: &Failure<'_>) {
    // Not `eprintln!`, which panics when the write fails, as one to a broken
    // pipe does, and a panic inside the panic hook aborts the process.
    let _ = writeln!(io::stderr(), "{failure}");
}

type Failed = Arc<dyn Fn(&Failure<'_>) + Send + Sync>;

/// A file written one append at a time, synchronously, under a lock: lines
/// of concurrent writers never interleave, and a line is on disk when the
/// call returns. Past [`Limits::size`] it moves to `<name>.1.<ext>`, each
/// older one up by one, and the ones past [`Limits::kept`] go.
///
/// A failure, whether to open, move or write, goes to the owner's `failed`
/// once and never stops the caller: a log records and guards nothing. It goes
/// again only after a write succeeded in between. `failed` runs under the
/// file's lock, so it must not write to the file.
///
/// Cloning gives another handle to the same file.
#[derive(Clone)]
pub struct Rotating {
    path: Arc<Path>,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    path: PathBuf,
    file: File,
    /// Whether `file` is the one at `path`: not once a rotation moved it
    /// and no new one could be opened there.
    in_place: bool,
    /// What it holds, as far as this process knows.
    size: u64,
    limits: Limits,
    failed: Failed,
    /// Whether the failure under way was said.
    said: bool,
}

impl Rotating {
    /// Appends to the file at `path`, which is made, with its directory, if
    /// it is not there.
    pub fn open(
        path: &Path,
        limits: Limits,
        failed: impl Fn(&Failure<'_>) + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let (file, size) = create(path)?;
        Ok(Self::of(path, file, size, limits, Arc::new(failed)))
    }

    /// Starts a new file at `path`: one that is there and not empty, the
    /// previous run's, moves to `<name>.1.<ext>` first.
    pub fn open_new(
        path: &Path,
        limits: Limits,
        failed: impl Fn(&Failure<'_>) + Send + Sync + 'static,
    ) -> io::Result<Self> {
        if std::fs::metadata(path).is_ok_and(|file| file.len() > 0)
            && let Err(error) = shift(path, limits.kept)
        {
            failed(&Failure {
                path,
                what: "could not move aside, so this run appends to it",
                error: &error,
            });
        }
        let (file, size) = create(path)?;
        Ok(Self::of(path, file, size, limits, Arc::new(failed)))
    }

    fn of(path: &Path, file: File, size: u64, limits: Limits, failed: Failed) -> Self {
        Self {
            path: path.into(),
            inner: Arc::new(Mutex::new(Inner {
                path: path.to_owned(),
                file,
                in_place: true,
                size,
                limits,
                failed,
                said: false,
            })),
        }
    }

    /// The file being written, `<name>.<ext>`.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends `bytes` with one write, so a line is never split.
    pub fn append(&self, bytes: &[u8]) {
        self.state().append(bytes);
    }

    /// As [`append`](Self::append), but gives up when the lock stays taken
    /// for `within`, and says whether it wrote: for a panic hook, which may
    /// run on the thread that holds the lock and must never wait for it.
    pub fn try_append(&self, bytes: &[u8], within: Duration) -> bool {
        let deadline = Instant::now() + within;
        loop {
            match self.inner.try_lock() {
                Ok(mut inner) => return inner.append(bytes),
                Err(TryLockError::Poisoned(poisoned)) => {
                    return poisoned.into_inner().append(bytes);
                }
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(TryLockError::WouldBlock) => return false,
            }
        }
    }

    /// Takes the lock back from a thread that panicked holding it: a log
    /// that stops for that would lose the panic's own line.
    fn state(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl<'a> MakeWriter<'a> for Rotating {
    type Writer = &'a Rotating;

    fn make_writer(&'a self) -> Self::Writer {
        self
    }
}

impl Write for &Rotating {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.append(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Inner {
    /// Whether the bytes reached the file.
    fn append(&mut self, bytes: &[u8]) -> bool {
        let size = bytes.len() as u64;
        if !self.in_place {
            self.reopen();
        }
        if self.in_place && self.size > 0 && self.size + size > self.limits.size {
            self.rotate();
        }
        // One write per line on a file opened to append, so lines of
        // concurrent writers never interleave.
        match self.file.write_all(bytes) {
            Ok(()) => {
                self.size += size;
                if self.in_place {
                    self.said = false;
                }
                true
            }
            Err(error) => {
                self.fail("could not be written", &error);
                false
            }
        }
    }

    /// Moves the file to `<name>.1.<ext>`, each older one up by one, and
    /// opens a new one; a file gone from its place moves none of them. A move
    /// that fails is said and the file goes on where it is, to try again after
    /// another `limit`.
    fn rotate(&mut self) {
        self.size = 0;
        if !matches!(std::fs::exists(&self.path), Ok(false))
            && let Err(error) = shift(&self.path, self.limits.kept)
        {
            self.fail("could not move aside", &error);
            return;
        }
        self.in_place = false;
        self.reopen();
    }

    /// Opens a new file at `path` for the one that left it. One that cannot
    /// be opened is said, and the lines go on to the one that left until the
    /// next line opens one.
    fn reopen(&mut self) {
        match create(&self.path) {
            Ok((file, size)) => {
                self.file = file;
                self.size = size;
                self.in_place = true;
            }
            Err(error) => self.fail(
                "could not be opened anew, so this line goes to the one that left its place",
                &error,
            ),
        }
    }

    fn fail(&mut self, what: &'static str, error: &io::Error) {
        if !std::mem::replace(&mut self.said, true) {
            (self.failed)(&Failure {
                path: &self.path,
                what,
                error,
            });
        }
    }
}

/// Moves `path` to number 1 and each numbered file up by one, those past
/// `kept` overwritten.
fn shift(path: &Path, kept: usize) -> io::Result<()> {
    (1..=kept)
        .rev()
        .map(|number| (numbered(path, number - 1), numbered(path, number)))
        .try_for_each(|(from, to)| match std::fs::rename(&from, &to) {
            Err(error) if error.kind() == io::ErrorKind::NotFound && from != path => Ok(()),
            moved => moved,
        })
}

/// `<name>.<number>.<ext>`, and `path` itself for 0.
pub(crate) fn numbered(path: &Path, number: usize) -> PathBuf {
    match (number, path.extension()) {
        (0, _) => path.to_owned(),
        (_, None) => path.with_extension(number.to_string()),
        (_, Some(extension)) => {
            path.with_extension(format!("{number}.{}", extension.to_string_lossy()))
        }
    }
}

/// Opens `path` to append, made 0600 if it is new, with what it holds.
fn create(path: &Path) -> io::Result<(File, u64)> {
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    let size = file.metadata()?.len();
    Ok((file, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: Limits = Limits { size: 1, kept: 2 };

    fn lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn put(rotating: &Rotating, line: &str) {
        rotating.append(format!("{line}\n").as_bytes());
    }

    #[test]
    fn opens_a_file_in_a_directory_that_does_not_exist_yet() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("app-data/nested/log.jsonl");
        put(&Rotating::open(&path, LIMITS, to_stderr).unwrap(), "a");
        assert_eq!(lines(&path), ["a"]);
    }

    #[test]
    fn past_its_size_the_file_moves_aside_and_the_oldest_past_the_count_goes() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("log.jsonl");
        let rotating = Rotating::open(&path, LIMITS, to_stderr).unwrap();
        for line in ["a", "b", "c", "d"] {
            put(&rotating, line);
        }
        let names = |number: usize| home.path().join(format!("log.{number}.jsonl"));
        assert_eq!(lines(&path), ["d"]);
        assert_eq!(lines(&names(1)), ["c"]);
        assert_eq!(lines(&names(2)), ["b"]);
        let mut files: Vec<_> = std::fs::read_dir(home.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        files.sort();
        assert_eq!(files, ["log.1.jsonl", "log.2.jsonl", "log.jsonl"]);
        #[cfg(unix)]
        for file in [path, names(1), names(2)] {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{}", file.display());
        }
    }

    #[test]
    fn a_file_that_cannot_move_aside_goes_on_and_tries_again_after_another_size() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("log.jsonl");
        let taken = home.path().join("log.1.jsonl");
        std::fs::create_dir(&taken).unwrap();
        std::fs::write(taken.join("kept"), "").unwrap();
        let rotating = Rotating::open(&path, Limits { size: 9, kept: 1 }, to_stderr).unwrap();
        for line in ["l1", "l2", "l3", "l4"] {
            put(&rotating, line);
        }
        assert_eq!(lines(&path), ["l1", "l2", "l3", "l4"]);
        std::fs::remove_dir_all(&taken).unwrap();
        for line in ["l5", "l6", "l7"] {
            put(&rotating, line);
        }
        assert_eq!(lines(&path), ["l7"]);
        assert_eq!(lines(&taken), ["l1", "l2", "l3", "l4", "l5", "l6"]);
    }

    #[test]
    fn a_file_that_left_its_place_opens_anew_and_moves_no_older_one() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("log.jsonl");
        let names = |number: usize| home.path().join(format!("log.{number}.jsonl"));
        let rotating = Rotating::open(&path, Limits { size: 1, kept: 4 }, to_stderr).unwrap();
        put(&rotating, "a");
        put(&rotating, "b");
        {
            let mut inner = rotating.state();
            std::fs::rename(names(1), names(2)).unwrap();
            std::fs::rename(&path, names(1)).unwrap();
            inner.in_place = false;
            inner.size = 0;
        }
        put(&rotating, "c");
        put(&rotating, "d");
        assert_eq!(lines(&path), ["d"]);
        assert_eq!(lines(&names(1)), ["c"]);
        assert_eq!(lines(&names(2)), ["b"]);
        assert_eq!(lines(&names(3)), ["a"]);

        std::fs::remove_file(&path).unwrap();
        put(&rotating, "e");
        assert_eq!(lines(&path), ["e"]);
        assert_eq!(lines(&names(1)), ["c"]);
        assert_eq!(lines(&names(2)), ["b"]);
        assert_eq!(lines(&names(3)), ["a"]);
    }

    #[test]
    fn a_new_file_moves_the_previous_run_s_aside() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("twigo.log");
        let limits = Limits {
            size: 1 << 20,
            kept: 2,
        };
        for run in ["first", "second", "third"] {
            put(&Rotating::open_new(&path, limits, to_stderr).unwrap(), run);
        }
        assert_eq!(lines(&path), ["third"]);
        assert_eq!(lines(&home.path().join("twigo.1.log")), ["second"]);
        assert_eq!(lines(&home.path().join("twigo.2.log")), ["first"]);
    }

    #[test]
    fn a_new_file_after_an_empty_one_keeps_the_older_runs() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("twigo.log");
        let limits = Limits {
            size: 1 << 20,
            kept: 2,
        };
        put(
            &Rotating::open_new(&path, limits, to_stderr).unwrap(),
            "first",
        );
        Rotating::open_new(&path, limits, to_stderr).unwrap();
        Rotating::open_new(&path, limits, to_stderr).unwrap();
        put(
            &Rotating::open_new(&path, limits, to_stderr).unwrap(),
            "fourth",
        );
        assert_eq!(lines(&path), ["fourth"]);
        assert_eq!(lines(&home.path().join("twigo.1.log")), ["first"]);
    }

    #[test]
    fn a_thread_that_panicked_holding_the_lock_leaves_the_file_writable() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("log.jsonl");
        let rotating = Rotating::open(
            &path,
            Limits {
                size: 1 << 20,
                kept: 1,
            },
            to_stderr,
        )
        .unwrap();
        let poisoner = rotating.clone();
        std::thread::spawn(move || {
            let _held = poisoner.inner.lock().unwrap();
            panic!("a thread panics while it holds the lock");
        })
        .join()
        .unwrap_err();
        assert!(rotating.inner.is_poisoned());
        put(&rotating, "a");
        assert!(rotating.try_append(b"b\n", Duration::from_millis(10)));
        assert_eq!(lines(&path), ["a", "b"]);
    }

    #[test]
    fn a_hook_gives_up_on_a_lock_that_stays_taken() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("log.jsonl");
        let rotating = Rotating::open(
            &path,
            Limits {
                size: 1 << 20,
                kept: 1,
            },
            to_stderr,
        )
        .unwrap();
        let _held = rotating.state();
        let (done, finished) = std::sync::mpsc::channel();
        let other = rotating.clone();
        std::thread::spawn(move || {
            let _ = done.send(other.try_append(b"a\n", Duration::from_millis(20)));
        });
        assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok(false));
    }
}
