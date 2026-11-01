use std::collections::HashSet;
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
    /// thread of its own with every new one, until the watch is dropped.
    pub fn start(
        sources: Sources,
        mut on_change: impl FnMut(Catalog) + Send + 'static,
    ) -> Result<Self, notify::Error> {
        let (events, received) = mpsc::channel::<DebounceEventResult>();
        let mut watched = Watched {
            debouncer: new_debouncer_opt(
                DEBOUNCE,
                None,
                events,
                NoCache,
                notify::Config::default(),
            )?,
            dirs: HashSet::new(),
            targets: HashSet::new(),
        };
        watched.follow(&sources);
        let shared = Arc::new(Mutex::new(watched));
        let weak = Arc::downgrade(&shared);
        let mut last = sources.load();
        on_change(last.clone());
        std::thread::Builder::new()
            .name("kubeconfig-watch".into())
            .spawn(move || {
                // Ends once the watch is dropped: the debouncer goes with it,
                // and so does the sending half of the channel.
                for result in received {
                    let Some(shared) = weak.upgrade() else { return };
                    {
                        let mut watched = lock(&shared);
                        if !watched.relevant(&result) {
                            continue;
                        }
                        // Before the load, so that a file written meanwhile
                        // in a directory that has just appeared is seen.
                        watched.follow(&sources);
                    }
                    drop(shared);
                    let next = sources.load();
                    if next != last {
                        last = next.clone();
                        on_change(next);
                    }
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
                    eprintln!("the kubeconfig watch failed: {error}");
                }
                true
            }
        }
    }

    /// Watches the directories the source files need now, afresh: a
    /// directory deleted and created again is another directory to the OS,
    /// and inotify drops the watch of a deleted one by itself.
    fn follow(&mut self, sources: &Sources) {
        let mut dirs = HashSet::new();
        let mut targets = HashSet::new();
        for file in sources.files() {
            for (dir, target) in watched(file) {
                targets.insert(target);
                dirs.insert(dir);
            }
        }
        for dir in self.dirs.drain() {
            match self.debouncer.unwatch(&dir) {
                Err(error) if !matches!(error.kind, ErrorKind::WatchNotFound) => {
                    eprintln!("could not stop watching {}: {error}", dir.display());
                }
                _ => {}
            }
        }
        for dir in dirs {
            match self.debouncer.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.dirs.insert(dir);
                }
                Err(error) => eprintln!("could not watch {}: {error}", dir.display()),
            }
        }
        self.targets = targets;
    }
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
