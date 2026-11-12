//! The state store (ARCHITECTURE 4.8): what the UI leaves behind, such as
//! layouts and recent items, and the spaces the rail shows. It lives in
//! memory and in one JSON file, which a thread of its own rewrites
//! atomically a moment after a change; [`State::flush`] writes at once, for
//! the app's exit.

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atomic_write_file::AtomicWriteFile;
use jiff::{SignedDuration, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use twigo_ipc::{ForwardId, Space, StateEntry, StateSnapshot};
use twigo_policy::Choices;

use crate::forward::Saved;

/// A write waits this long after the change that starts it, so the changes
/// that follow within it share the write.
const WRITE_DELAY: Duration = Duration::from_secs(1);

/// A space is dropped, with its state, as the store opens once the catalog
/// has been noted this long after it first lacked one of its contexts, and
/// lacked it every time in between. Only a noting moves the clock: each
/// run's first reading of the sources and each change of the catalog. So a
/// context back at the first reading after a long break keeps its space.
const MISSING: SignedDuration = SignedDuration::from_hours(90 * 24);

/// Bumped when the file's shape changes; a file of another version is set
/// aside, and the store starts empty.
const VERSION: u32 = 1;

/// What the person chose for each context's mode (ARCHITECTURE 6.4), the one
/// key no webview writes, as the webview only shows a mode.
/// @todo: move the mode to settings.json once the settings files come in M3
const CHOICES: &str = "policy/choices";

/// A space's forwards and the local port each target's port had last
/// (ARCHITECTURE 4.6), which only the port-forward manager writes.
const FORWARDS: &str = "forwards";

/// The id the last forward got, in the app's scope, so that no id is used
/// twice across restarts.
const LAST_FORWARD: &str = "forwards/last";

const RESERVED: [&str; 3] = [CHOICES, FORWARDS, LAST_FORWARD];

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no space {0:?}")]
    NoSpace(String),
    #[error("{0:?} is set only through its command")]
    Reserved(String),
    #[error("the value of {key:?} is not JSON: {source}")]
    NotJson {
        key: String,
        #[source]
        source: serde_json::Error,
    },
}

pub struct State {
    inner: Arc<Inner>,
    wake: Sender<()>,
}

struct Inner {
    path: PathBuf,
    data: Mutex<Data>,
    /// The version last written, so that a slow write never replaces a newer
    /// one.
    written: Mutex<u64>,
    scheduled: AtomicBool,
}

struct Data {
    file: File,
    /// Counts changes; compared with `Inner::written`.
    version: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    version: u32,
    /// When the catalog was last noted ([`State::saw`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saw: Option<Timestamp>,
    app: BTreeMap<String, Box<RawValue>>,
    /// In the rail's order.
    spaces: Vec<SpaceRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SpaceRecord {
    id: String,
    contexts: Vec<String>,
    /// Since when a context of the space has been missing from the sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    missing_since: Option<Timestamp>,
    state: BTreeMap<String, Box<RawValue>>,
}

impl SpaceRecord {
    fn space(&self) -> Space {
        Space {
            id: self.id.clone(),
            name: self.contexts.join(" + "),
            contexts: self.contexts.clone(),
        }
    }
}

impl State {
    /// Reads the file at `path`, and drops the spaces whose contexts have
    /// been missing too long: here, before the webview reads any, so it
    /// never holds a space the store has dropped. A file that cannot be read
    /// as state is moved aside, so the app starts, with nothing remembered.
    pub fn open(path: PathBuf) -> Self {
        Self::open_with(path, WRITE_DELAY)
    }

    fn open_with(path: PathBuf, delay: Duration) -> Self {
        let mut file = read(&path);
        if let Some(saw) = file.saw {
            file.spaces.retain(|record| {
                record
                    .missing_since
                    .is_none_or(|since| saw.duration_since(since) < MISSING)
            });
        }
        let inner = Arc::new(Inner {
            path,
            data: Mutex::new(Data { file, version: 0 }),
            written: Mutex::new(0),
            scheduled: AtomicBool::new(false),
        });
        let (wake, woken) = mpsc::channel();
        let writer = Arc::clone(&inner);
        std::thread::Builder::new()
            .name("state-writer".into())
            .spawn(move || writer.write_after(delay, &woken))
            .expect("the state writer thread starts");
        Self { inner, wake }
    }

    /// Everything the webview keeps, for its start.
    pub fn snapshot(&self) -> StateSnapshot {
        let data = self.inner.lock();
        let text = |values: &BTreeMap<String, Box<RawValue>>| -> HashMap<String, String> {
            values
                .iter()
                .map(|(key, value)| (key.clone(), value.get().to_owned()))
                .collect()
        };
        StateSnapshot {
            app: text(&data.file.app),
            spaces: data
                .file
                .spaces
                .iter()
                .map(|space| (space.id.clone(), text(&space.state)))
                .collect(),
        }
    }

    /// What the person chose for each context's mode; nothing, when the
    /// value does not read back.
    pub fn choices(&self) -> Choices {
        let data = self.inner.lock();
        let Some(value) = data.file.app.get(CHOICES) else {
            return Choices::default();
        };
        serde_json::from_str(value.get()).unwrap_or_else(|error| {
            eprintln!("could not read the contexts' modes from the state: {error}");
            Choices::default()
        })
    }

    pub fn set_choices(&self, choices: &Choices) {
        let value = serde_json::value::to_raw_value(choices)
            .expect("maps of strings and plain enums serialize to JSON");
        let mut data = self.inner.lock();
        data.file.app.insert(CHOICES.to_owned(), value);
        self.changed(&mut data);
    }

    /// A space's forwards; none where it has none or they do not read back.
    pub(crate) fn forwards(&self, space: &str) -> Saved {
        let data = self.inner.lock();
        let value = data
            .file
            .spaces
            .iter()
            .find(|record| record.id == space)
            .and_then(|record| record.state.get(FORWARDS));
        value
            .map(|value| {
                serde_json::from_str(value.get()).unwrap_or_else(|error| {
                    eprintln!("could not read the forwards of {space} from the state: {error}");
                    Saved::default()
                })
            })
            .unwrap_or_default()
    }

    /// Replaces a space's forwards, unless the space is gone.
    pub(crate) fn set_forwards(&self, space: &str, saved: &Saved) -> Result<(), Error> {
        let value = serde_json::value::to_raw_value(saved).expect("plain data serializes to JSON");
        let mut data = self.inner.lock();
        let record = data
            .file
            .spaces
            .iter_mut()
            .find(|record| record.id == space)
            .ok_or_else(|| Error::NoSpace(space.to_owned()))?;
        record.state.insert(FORWARDS.to_owned(), value);
        self.changed(&mut data);
        Ok(())
    }

    /// The next forward's id, which is greater than every one given before,
    /// this run or earlier, and `taken` ones the store holds.
    pub(crate) fn next_forward_id(&self, taken: u32) -> ForwardId {
        let mut data = self.inner.lock();
        let last = data
            .file
            .app
            .get(LAST_FORWARD)
            .and_then(|value| serde_json::from_str::<u32>(value.get()).ok())
            .unwrap_or(0);
        let next = last.max(taken) + 1;
        let value = serde_json::value::to_raw_value(&next).expect("a number is JSON");
        data.file.app.insert(LAST_FORWARD.to_owned(), value);
        self.changed(&mut data);
        ForwardId(next)
    }

    /// Stores the entries, all or none.
    pub fn set(&self, entries: Vec<StateEntry>) -> Result<(), Error> {
        let mut parsed = Vec::with_capacity(entries.len());
        for StateEntry { space, key, value } in entries {
            if RESERVED.contains(&key.as_str()) {
                return Err(Error::Reserved(key));
            }
            let value = RawValue::from_string(value).map_err(|source| Error::NotJson {
                key: key.clone(),
                source,
            })?;
            parsed.push((space, key, value));
        }
        let mut data = self.inner.lock();
        for (space, ..) in &parsed {
            if let Some(id) = space
                && !data.file.spaces.iter().any(|record| &record.id == id)
            {
                return Err(Error::NoSpace(id.clone()));
            }
        }
        for (space, key, value) in parsed {
            let values = match space {
                None => &mut data.file.app,
                Some(id) => {
                    let record = data.file.spaces.iter_mut().find(|r| r.id == id);
                    &mut record.expect("checked above").state
                }
            };
            values.insert(key, value);
        }
        self.changed(&mut data);
        Ok(())
    }

    /// The spaces the rail shows, in its order.
    pub fn spaces(&self) -> Vec<Space> {
        self.inner
            .lock()
            .file
            .spaces
            .iter()
            .map(SpaceRecord::space)
            .collect()
    }

    /// The one-context space of `context`, added at the end of the rail if it
    /// has none. The space's id is the context's name, which stays the same
    /// wherever its kubeconfig moves.
    pub fn open_space(&self, context: &str) -> Space {
        let mut data = self.inner.lock();
        let at = data
            .file
            .spaces
            .iter()
            .position(|record| record.contexts == [context]);
        if let Some(at) = at {
            return data.file.spaces[at].space();
        }
        let record = SpaceRecord {
            id: context.to_owned(),
            contexts: vec![context.to_owned()],
            missing_since: None,
            state: BTreeMap::new(),
        };
        let space = record.space();
        data.file.spaces.push(record);
        self.changed(&mut data);
        space
    }

    /// Notes which contexts the sources list now, so that a space knows
    /// since when one of its contexts has been missing.
    pub fn saw(&self, contexts: &HashSet<String>, now: Timestamp) {
        let mut data = self.inner.lock();
        data.file.saw = Some(now);
        for record in &mut data.file.spaces {
            let missing = !record.contexts.iter().all(|c| contexts.contains(c));
            let since = match record.missing_since {
                Some(since) if missing => Some(since),
                _ if missing => Some(now),
                _ => None,
            };
            record.missing_since = since;
        }
        self.changed(&mut data);
    }

    /// Writes what changed since the last write, now.
    pub fn flush(&self) -> io::Result<()> {
        self.inner.write()
    }

    fn changed(&self, data: &mut Data) {
        data.version += 1;
        if !self.inner.scheduled.swap(true, Ordering::AcqRel) {
            // The writer thread lives as long as the store.
            let _ = self.wake.send(());
        }
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, Data> {
        self.data.lock().expect("state lock")
    }

    /// The writer thread: once woken, waits [`WRITE_DELAY`], then writes
    /// everything changed so far. Ends with the store.
    fn write_after(&self, delay: Duration, woken: &Receiver<()>) {
        while woken.recv().is_ok() {
            std::thread::sleep(delay);
            self.scheduled.store(false, Ordering::Release);
            if let Err(error) = self.write() {
                eprintln!(
                    "could not save the state to {}: {error}",
                    self.path.display()
                );
            }
        }
    }

    fn write(&self) -> io::Result<()> {
        let mut written = self.written.lock().expect("state write lock");
        let (version, json) = {
            let data = self.lock();
            if data.version == *written {
                return Ok(());
            }
            let json = serde_json::to_vec_pretty(&data.file).expect("the state serializes");
            (data.version, json)
        };
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut options = AtomicWriteFile::options();
        #[cfg(unix)]
        {
            use atomic_write_file::unix::OpenOptionsExt as _;
            use std::os::unix::fs::OpenOptionsExt as _;
            // It names the user's clusters.
            options.preserve_mode(false).mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        file.write_all(&json)?;
        file.commit()?;
        *written = version;
        Ok(())
    }
}

fn read(path: &Path) -> File {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return File {
                version: VERSION,
                ..File::default()
            };
        }
        Err(error) => return set_aside(path, &error),
    };
    match serde_json::from_slice::<File>(&bytes) {
        Ok(file) if file.version == VERSION => file,
        Ok(file) => set_aside(path, &format!("version {}", file.version)),
        Err(error) => set_aside(path, &error),
    }
}

fn set_aside(path: &Path, reason: &dyn std::fmt::Display) -> File {
    let aside = path.with_extension("json.unreadable");
    eprintln!(
        "the state in {} cannot be read ({reason}); it moves to {}",
        path.display(),
        aside.display()
    );
    if let Err(error) = std::fs::rename(path, &aside) {
        eprintln!("could not move the state aside: {error}");
    }
    File {
        version: VERSION,
        ..File::default()
    }
}

impl From<&Error> for twigo_ipc::IpcError {
    fn from(error: &Error) -> Self {
        let kind = match error {
            Error::NoSpace(_) => twigo_ipc::ErrorKind::NotFound,
            Error::Reserved(_) => twigo_ipc::ErrorKind::Permissions,
            Error::NotJson { .. } => twigo_ipc::ErrorKind::InvalidInput,
        };
        Self::new(kind, error.to_string())
    }
}
