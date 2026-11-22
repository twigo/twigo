use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::notify::{
    self, ErrorKind, EventKind, RecommendedWatcher, RecursiveMode,
};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt,
};

use twigo_panic::inject;

use super::{Catalog, Sources};

/// Long enough to take a writer's temporary file, rename and chmod as one
/// change.
const DEBOUNCE: Duration = Duration::from_millis(250);

type Shared = Arc<Mutex<Watched>>;

/// Follows the source files and reports each catalog that differs from the
/// last. Writers replace kubeconfigs by rename, so it watches the files'
/// directories rather than the files: the closest one that exists, so that a
/// `~/.kube` created later is seen too, and the directory of a symlink's
/// target, which is where writes through the symlink land.
pub struct Watch {
    _watched: Shared,
}

struct Watched {
    /// No file id cache: renames need no tracking, as every change rereads
    /// all files, and the cache would walk the watched directories.
    debouncer: Debouncer<RecommendedWatcher, NoCache>,
    dirs: HashSet<PathBuf>,
    /// The entries of the watched directories that lead to a source file.
    targets: HashSet<PathBuf>,
}

impl Watch {
    /// Calls `on_change` with the catalog before it returns, then on a
    /// thread of its own with every new one, and `on_write` after every
    /// change to the files, whether or not it changed the catalog, until the
    /// watch is dropped. A panic on that thread ends it, and `on_panic` is
    /// called from it: the caller starts the watch again.
    pub fn start(
        sources: Sources,
        mut on_change: impl FnMut(Catalog) + Send + 'static,
        mut on_write: impl FnMut() + Send + 'static,
        on_panic: impl FnOnce() + Send + 'static,
    ) -> Result<Self, notify::Error> {
        let (events, received) = mpsc::channel::<DebounceEventResult>();
        let mut watched = Watched {
            debouncer: new_debouncer_opt(
                DEBOUNCE,
                Some(DEBOUNCE),
                events,
                NoCache,
                notify::Config::default(),
            )?,
            dirs: HashSet::new(),
            targets: HashSet::new(),
        };
        let unseen = watched.follow(&sources);
        let shared = Arc::new(Mutex::new(watched));
        let weak = Arc::downgrade(&shared);
        let mut last = sources.load().unwatched(&sources, &unseen);
        on_change(last.clone());
        std::thread::Builder::new()
            .name("kubeconfig-watch".into())
            .spawn(move || {
                // Ends once the watch is dropped: the debouncer goes with it,
                // and so does the sending half of the channel.
                let followed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    for result in received {
                        inject::check("kubeconfig watch");
                        let Some(shared) = weak.upgrade() else { return };
                        let unseen = {
                            let mut watched = lock(&shared);
                            if !watched.relevant(&result) {
                                continue;
                            }
                            // Before the load, so that a file written meanwhile
                            // in a directory that has just appeared is seen.
                            watched.follow(&sources)
                        };
                        drop(shared);
                        let next = sources.load().unwatched(&sources, &unseen);
                        if next != last {
                            last = next.clone();
                            on_change(next);
                        }
                        on_write();
                    }
                }));
                if followed.is_err() {
                    on_panic();
                }
            })?;
        Ok(Self { _watched: shared })
    }
}

fn lock(shared: &Shared) -> std::sync::MutexGuard<'_, Watched> {
    shared.lock().expect("kubeconfig watch lock")
}

impl Watched {
    fn relevant(&self, result: &DebounceEventResult) -> bool {
        match result {
            Ok(events) => touches(events, &self.targets, &self.dirs),
            Err(errors) => {
                for error in errors {
                    tracing::warn!(%error, "the kubeconfig watch failed");
                }
                true
            }
        }
    }

    /// Watches the directories the source files need now, afresh: a
    /// directory deleted and created again is another directory to the OS,
    /// and inotify drops the watch of a deleted one by itself. Says which
    /// files go unseen for a directory the OS would not watch, and why.
    fn follow(&mut self, sources: &Sources) -> Vec<(PathBuf, String)> {
        let files: Vec<_> = sources
            .files()
            .iter()
            .map(|file| (file, watched(file)))
            .collect();
        let dirs: HashSet<_> = files
            .iter()
            .flat_map(|(_, found)| found.iter().map(|(dir, _)| dir.clone()))
            .collect();
        let targets = files
            .iter()
            .flat_map(|(_, found)| found.iter().map(|(_, target)| target.clone()))
            .collect();
        for dir in self.dirs.drain() {
            match self.debouncer.unwatch(&dir) {
                Err(error) if !matches!(error.kind, ErrorKind::WatchNotFound) => {
                    tracing::warn!(path = %dir.display(), %error, "could not stop watching a directory");
                }
                _ => {}
            }
        }
        let mut failed = HashMap::new();
        for dir in dirs {
            match self.debouncer.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.dirs.insert(dir);
                }
                Err(error) => {
                    tracing::warn!(path = %dir.display(), %error, "could not watch a directory");
                    failed.insert(dir, error.set_paths(Vec::new()).to_string());
                }
            }
        }
        self.targets = targets;
        unseen(&files, &failed)
    }
}

/// The files that need a directory that could not be watched, each with why:
/// a notify error's words name its paths, which a message never does.
fn unseen(
    files: &[(&PathBuf, Vec<(PathBuf, PathBuf)>)],
    failed: &HashMap<PathBuf, String>,
) -> Vec<(PathBuf, String)> {
    files
        .iter()
        .filter_map(|(file, found)| {
            let why = found.iter().find_map(|(dir, _)| failed.get(dir))?;
            Some(((*file).clone(), why.clone()))
        })
        .collect()
}

/// Whether the events change a source file or a watched directory, or say
/// that events were lost, as an overflowing inotify queue does. Reads do
/// not count: inotify reports every open, Twigo's own loads among them.
fn touches(events: &[DebouncedEvent], targets: &HashSet<PathBuf>, dirs: &HashSet<PathBuf>) -> bool {
    events
        .iter()
        .filter(|event| !matches!(event.kind, EventKind::Access(_)))
        .any(|event| {
            event.need_rescan()
                || event
                    .paths
                    .iter()
                    .any(|path| targets.contains(path) || dirs.contains(path))
        })
}

/// The directories to watch for `file`, canonical as the OS reports event
/// paths, each with its entry on the way to `file`: the closest existing
/// directory above it, and the directory of its target when it is a symlink.
fn watched(file: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut found = Vec::new();
    let mut entry = file;
    while let (Some(parent), Some(name)) = (entry.parent(), entry.file_name()) {
        if let Ok(dir) = parent.canonicalize() {
            found.push((dir.clone(), dir.join(name)));
            break;
        }
        entry = parent;
    }
    if let Ok(target) = file.canonicalize()
        && let Some(dir) = target.parent()
        && !found.iter().any(|(_, entry)| entry == &target)
    {
        found.push((dir.to_owned(), target.clone()));
    }
    found
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use notify_debouncer_full::notify::Event;
    use notify_debouncer_full::notify::event::Flag;
    use notify_debouncer_full::notify::event::{AccessKind, AccessMode, ModifyKind, RemoveKind};

    use super::*;

    fn event(kind: EventKind, path: &str) -> DebouncedEvent {
        DebouncedEvent::new(Event::new(kind).add_path(path.into()), Instant::now())
    }

    #[test]
    fn a_file_goes_unseen_when_any_directory_it_needs_cannot_be_watched() {
        let (plain, linked, fine) = (
            PathBuf::from("/home/.kube/config"),
            PathBuf::from("/home/.kube/linked"),
            PathBuf::from("/etc/kube/config"),
        );
        let needs = |dirs: &[&str]| -> Vec<(PathBuf, PathBuf)> {
            dirs.iter()
                .map(|dir| (PathBuf::from(dir), PathBuf::from(dir).join("entry")))
                .collect()
        };
        let files = [
            (&plain, needs(&["/home/.kube"])),
            (&linked, needs(&["/home/.kube", "/data/real"])),
            (&fine, needs(&["/etc/kube"])),
        ];
        let failed = HashMap::from([
            (PathBuf::from("/home/.kube"), "no space".to_owned()),
            (PathBuf::from("/other"), "unused".to_owned()),
        ]);
        assert_eq!(
            unseen(&files, &failed),
            [
                (plain.clone(), "no space".to_owned()),
                (linked.clone(), "no space".to_owned()),
            ]
        );
        let target = HashMap::from([(PathBuf::from("/data/real"), "denied".to_owned())]);
        assert_eq!(
            unseen(&files, &target),
            [(linked.clone(), "denied".to_owned())]
        );
        assert!(unseen(&files, &HashMap::new()).is_empty());
    }

    #[test]
    fn reads_never_count_and_changes_do() {
        let targets = HashSet::from([PathBuf::from("/home/.kube/config")]);
        let dirs = HashSet::from([PathBuf::from("/home/.kube")]);
        let touched = |kind, path| touches(&[event(kind, path)], &targets, &dirs);
        let open = EventKind::Access(AccessKind::Open(AccessMode::Any));
        assert!(!touched(open, "/home/.kube/config"));
        assert!(!touched(open, "/home/.kube"));
        assert!(touched(
            EventKind::Modify(ModifyKind::Any),
            "/home/.kube/config"
        ));
        assert!(touched(
            EventKind::Remove(RemoveKind::Folder),
            "/home/.kube"
        ));
        assert!(!touched(
            EventKind::Modify(ModifyKind::Any),
            "/home/.kube/cache"
        ));
        let lost = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(touches(
            &[DebouncedEvent::new(lost, Instant::now())],
            &targets,
            &dirs
        ));
    }
}
