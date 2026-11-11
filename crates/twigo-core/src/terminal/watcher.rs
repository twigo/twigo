//! Follows a terminal's file for entries to offer. It watches the file's
//! directory, not the file: kubectl, aws and gcloud write in place, az
//! replaces the file by a rename, gcloud may rename it to a backup and write
//! a new one, and kubectl creates and removes `<file>.lock` beside it. A
//! read that does not parse, as one in the middle of a write in place,
//! waits for the next event or 200 ms.

use std::ffi::OsString;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use notify_debouncer_full::notify::{self, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};
use twigo_kube::kubeconfig::Names;

use super::offers::{Offers, Source};

/// As twigo-kube's watch of the user's files: a writer's temporary file,
/// rename and chmod as one change.
const DEBOUNCE: Duration = Duration::from_millis(250);
const RETRY: Duration = Duration::from_millis(200);

pub(super) struct Watcher {
    source: Arc<Source>,
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.source.stopped.store(true, Ordering::Release);
    }
}

/// Offers the names the file gets that were not in it as Twigo wrote it,
/// `written`, and were never offered for this terminal.
pub(super) fn watch(
    offers: Arc<Offers>,
    source: Arc<Source>,
    written: Names,
) -> notify::Result<Watcher> {
    let (events, received) = mpsc::channel();
    let mut debouncer = new_debouncer_opt(
        DEBOUNCE,
        Some(DEBOUNCE),
        events,
        NoCache,
        notify::Config::default(),
    )?;
    let dir = source.file.parent().expect("a file in a directory");
    debouncer.watch(dir, RecursiveMode::NonRecursive)?;
    let followed = Arc::clone(&source);
    std::thread::Builder::new()
        .name("terminal-kubeconfig".into())
        .spawn(move || follow(&received, &offers, &followed, &written))?;
    Ok(Watcher {
        source,
        _debouncer: debouncer,
    })
}

/// Ends with the debouncer, which holds the channel's sender.
fn follow(
    received: &mpsc::Receiver<DebounceEventResult>,
    offers: &Offers,
    source: &Arc<Source>,
    written: &Names,
) {
    let name = source.file.file_name().expect("a file name").to_owned();
    let mut offered = Names::default();
    let mut live = None;
    while let Ok(result) = received.recv() {
        if !touches(&result, &name) {
            continue;
        }
        let text = loop {
            match std::fs::read_to_string(&source.file) {
                Ok(text) if Names::of(&text).is_ok() => break Some(text),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break None,
                _ => match received.recv_timeout(RETRY) {
                    Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                },
            }
        };
        let Some(text) = text else { continue };
        let names = Names::of(&text).expect("parsed above");
        let fresh = names.without(written).without(&offered);
        if fresh.is_empty() {
            offers.read(source, live, &text, &names);
            continue;
        }
        offered.extend(fresh.clone());
        live = offers.offer(source, live, &text, &names, &fresh);
        if live.is_none() {
            return;
        }
    }
}

/// Whether the events change the file, as a write, a rename to or from its
/// name or its removal does, or say that events were lost. Reads do not
/// count: inotify reports every open, the follower's own among them.
fn touches(result: &DebounceEventResult, name: &OsString) -> bool {
    match result {
        Ok(events) => events
            .iter()
            .filter(|event| !matches!(event.kind, EventKind::Access(_)))
            .any(|event| {
                event.need_rescan()
                    || event
                        .paths
                        .iter()
                        .any(|path| path.file_name() == Some(name.as_os_str()))
            }),
        Err(errors) => {
            for error in errors {
                eprintln!("the watch of a terminal's kubeconfig failed: {error}");
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    use notify_debouncer_full::DebouncedEvent;
    use notify_debouncer_full::notify::Event;
    use notify_debouncer_full::notify::event::ModifyKind;
    use twigo_ipc::{KubeconfigOfferEvent, SubscriptionId};
    use twigo_kube::kubeconfig::Sources;

    use super::*;

    #[test]
    fn a_read_that_does_not_parse_is_read_again_200_ms_later_with_no_event() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kubeconfig");
        std::fs::write(&file, "users:\n- name: half\n  user: [").unwrap();
        let mine = dir.path().join("config");
        let source = Arc::new(Source {
            window: "main".into(),
            label: "Terminal 1".into(),
            context: "kind-a".to_owned(),
            session: OnceLock::from(SubscriptionId(4)),
            file: file.clone(),
            sources: Sources::explicit(mine.clone()),
            target: mine,
            chained: true,
            stopped: AtomicBool::new(false),
        });
        let offers = Offers::new();
        let (told, offered) = mpsc::channel();
        offers.follow("main", move |event| {
            told.send((Instant::now(), event)).is_ok()
        });
        let (events, received) = mpsc::channel();
        let followed = Arc::clone(&source);
        let follower = std::thread::spawn(move || {
            follow(&received, &offers, &followed, &Names::default());
        });
        let modified = Event::new(EventKind::Modify(ModifyKind::Any)).add_path(file.clone());
        events
            .send(Ok(vec![DebouncedEvent::new(modified, Instant::now())]))
            .unwrap();
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&file, "users:\n- name: whole\n  user: {}\n").unwrap();
        let fixed = Instant::now();
        let (at, event) = offered.recv_timeout(Duration::from_secs(2)).unwrap();
        let KubeconfigOfferEvent::Offered { offer } = event else {
            panic!("{event:?}");
        };
        assert_eq!(offer.users, ["whole"]);
        assert_eq!(
            (offer.session, offer.context.as_str()),
            (SubscriptionId(4), "kind-a")
        );
        assert!(at.duration_since(fixed) < Duration::from_millis(400));
        drop(events);
        follower.join().unwrap();
    }
}
