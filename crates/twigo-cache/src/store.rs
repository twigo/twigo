//! An upstream's row store (ARCHITECTURE 3.1): its items by uid, or by
//! namespace and name for objects without one, the columns of a Table
//! upstream, and a feed of what changed for each reader.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use tokio::sync::watch;

use crate::meta::Meta;
use crate::object::Object;
use crate::table::{Column, Row};

/// What a store holds: a row, or an editor's object.
pub trait Item: Send + Sync + 'static {
    fn meta(&self) -> &Meta;
}

impl Item for Row {
    fn meta(&self) -> &Meta {
        &self.meta
    }
}

impl Item for Object {
    fn meta(&self) -> &Meta {
        &self.meta
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RowKey {
    Uid(Box<str>),
    /// Objects the server builds without a uid, such as ComponentStatus.
    Name {
        namespace: Option<Box<str>>,
        name: Box<str>,
    },
}

impl RowKey {
    pub fn of(meta: &Meta) -> Self {
        match &meta.uid {
            Some(uid) => RowKey::Uid(uid.clone()),
            None => RowKey::Name {
                namespace: meta.namespace.clone(),
                name: meta.name.clone(),
            },
        }
    }
}

pub type Items<T> = HashMap<RowKey, Arc<T>>;

pub struct Store<T> {
    contents: Mutex<Contents<T>>,
    /// Counts the changes, so readers learn of them.
    version: watch::Sender<u64>,
}

struct Contents<T> {
    items: Items<T>,
    columns: Option<Arc<[Column]>>,
    feeds: Vec<Weak<Mutex<Pending>>>,
}

/// What changed for one reader since it last drained the store, coalesced
/// by key. A key added since then and deleted again leaves it, since the
/// reader never held its item, so it holds no more keys than the reader
/// held and the store holds, however long the reader waits.
#[derive(Default)]
struct Pending {
    /// Everything changed: the reader is new, a relist replaced the
    /// items, or the columns changed.
    reset: bool,
    /// Each changed key, and whether it was added since the last drain.
    keys: HashMap<RowKey, bool>,
}

/// A reader's feed of a store's changes.
pub struct Feed(Arc<Mutex<Pending>>);

/// What [`Store::drain`] took from a feed.
pub enum Drained<T> {
    /// Every item, which replaces what the reader holds, and the columns,
    /// which change only with a reset.
    Reset {
        items: Vec<Arc<T>>,
        columns: Option<Arc<[Column]>>,
    },
    /// Each changed key with its item, or None once it is deleted.
    Changed(Vec<(RowKey, Option<Arc<T>>)>),
}

impl<T: Item> Default for Store<T> {
    fn default() -> Self {
        Self {
            contents: Mutex::new(Contents {
                items: HashMap::new(),
                columns: None,
                feeds: Vec::new(),
            }),
            version: watch::Sender::new(0),
        }
    }
}

/// What happened to a key in the store.
#[derive(Clone, Copy)]
enum Change {
    /// It had no item before.
    Added,
    Modified,
    Deleted,
}

impl<T> Contents<T> {
    fn record(&mut self, key: &RowKey, change: Change) {
        self.feeds.retain(|feed| match feed.upgrade() {
            Some(feed) => {
                let mut pending = feed.lock().expect("feed lock");
                if !pending.reset {
                    let added = pending.keys.get(key).copied();
                    match (added, change) {
                        (Some(true), Change::Deleted) => {
                            pending.keys.remove(key);
                        }
                        (Some(_), _) => {}
                        (None, change) => {
                            pending
                                .keys
                                .insert(key.clone(), matches!(change, Change::Added));
                        }
                    }
                }
                true
            }
            None => false,
        });
    }

    fn reset(&mut self) {
        self.feeds.retain(|feed| match feed.upgrade() {
            Some(feed) => {
                let mut pending = feed.lock().expect("feed lock");
                pending.reset = true;
                pending.keys.clear();
                true
            }
            None => false,
        });
    }
}

impl<T: Item> Store<T> {
    pub fn is_empty(&self) -> bool {
        self.contents().items.is_empty()
    }

    pub fn len(&self) -> usize {
        self.contents().items.len()
    }

    pub fn upsert(&self, item: T) {
        let key = RowKey::of(item.meta());
        let mut contents = self.contents();
        let change = match contents.items.insert(key.clone(), Arc::new(item)) {
            Some(_) => Change::Modified,
            None => Change::Added,
        };
        contents.record(&key, change);
        drop(contents);
        self.changed();
    }

    pub fn delete(&self, item: &T) {
        let key = RowKey::of(item.meta());
        let mut contents = self.contents();
        let removed = contents.items.remove(&key).is_some();
        if removed {
            contents.record(&key, Change::Deleted);
        }
        drop(contents);
        if removed {
            self.changed();
        }
    }

    /// Replaces every item, as a relist ends.
    pub fn replace(&self, items: Items<T>) {
        let mut contents = self.contents();
        contents.items = items;
        contents.reset();
        drop(contents);
        self.changed();
    }

    /// Keeps the columns unless they are the ones held.
    pub fn set_columns(&self, columns: Option<&Arc<[Column]>>) {
        let mut contents = self.contents();
        let same = match (&contents.columns, columns) {
            (Some(held), Some(new)) => Arc::ptr_eq(held, new),
            (None, None) => true,
            _ => false,
        };
        if !same {
            contents.columns = columns.cloned();
            contents.reset();
            drop(contents);
            self.changed();
        }
    }

    /// A feed whose first drain takes every item.
    pub fn feed(&self) -> Feed {
        let pending = Arc::new(Mutex::new(Pending {
            reset: true,
            keys: HashMap::new(),
        }));
        let mut contents = self.contents();
        contents.feeds.retain(|feed| feed.strong_count() > 0);
        contents.feeds.push(Arc::downgrade(&pending));
        Feed(pending)
    }

    /// What changed since the feed was last drained, read under the same
    /// lock as the items, so no change falls between the two.
    pub fn drain(&self, feed: &Feed) -> Drained<T> {
        let contents = self.contents();
        let mut pending = feed.0.lock().expect("feed lock");
        if pending.reset {
            return Self::reset_to(&contents, &mut pending);
        }
        Drained::Changed(
            pending
                .keys
                .drain()
                .map(|(key, _)| {
                    let item = contents.items.get(&key).cloned();
                    (key, item)
                })
                .collect(),
        )
    }

    /// Every item, as a reset gives them, whatever the feed holds: for a
    /// reader that starts anew, as when another of its stores was reset.
    pub fn reread(&self, feed: &Feed) -> Drained<T> {
        let contents = self.contents();
        let mut pending = feed.0.lock().expect("feed lock");
        Self::reset_to(&contents, &mut pending)
    }

    /// Every item and the columns, which the reader now holds, so nothing
    /// is pending.
    fn reset_to(contents: &Contents<T>, pending: &mut Pending) -> Drained<T> {
        pending.reset = false;
        pending.keys.clear();
        Drained::Reset {
            items: contents.items.values().cloned().collect(),
            columns: contents.columns.clone(),
        }
    }

    pub fn columns(&self) -> Option<Arc<[Column]>> {
        self.contents().columns.clone()
    }

    /// The items `keep` takes.
    pub fn items(&self, mut keep: impl FnMut(&T) -> bool) -> Vec<Arc<T>> {
        self.contents()
            .items
            .values()
            .filter(|item| keep(item))
            .cloned()
            .collect()
    }

    pub fn version(&self) -> watch::Receiver<u64> {
        self.version.subscribe()
    }

    fn contents(&self) -> MutexGuard<'_, Contents<T>> {
        self.contents.lock().expect("store lock")
    }

    fn changed(&self) {
        self.version.send_modify(|version| *version += 1);
    }
}

/// Inserts `item` into `items`, as a relist collects them.
pub fn collect<T: Item>(items: &mut Items<T>, item: T) {
    items.insert(RowKey::of(item.meta()), Arc::new(item));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::Cell;

    fn row(uid: &str, version: &str) -> Row {
        Row {
            meta: Meta {
                name: uid.into(),
                namespace: Some("default".into()),
                uid: Some(uid.into()),
                resource_version: version.into(),
                labels: Box::default(),
                owners: Box::default(),
                created: None,
            },
            cells: Box::new([Cell::Text(version.into())]),
        }
    }

    fn changed(drained: Drained<Row>) -> Vec<(String, Option<String>)> {
        let Drained::Changed(changes) = drained else {
            panic!("a reset");
        };
        let mut changes: Vec<_> = changes
            .into_iter()
            .map(|(key, item)| {
                let RowKey::Uid(uid) = key else {
                    panic!("a key without a uid");
                };
                let version = item.map(|item| item.meta.resource_version.to_string());
                (uid.to_string(), version)
            })
            .collect();
        changes.sort();
        changes
    }

    fn reset(drained: Drained<Row>) -> Vec<String> {
        let Drained::Reset { items, .. } = drained else {
            panic!("no reset");
        };
        let mut uids: Vec<_> = items
            .iter()
            .map(|item| item.meta.uid.as_deref().unwrap_or_default().to_owned())
            .collect();
        uids.sort();
        uids
    }

    #[test]
    fn a_new_feed_takes_every_item_first() {
        let store = Store::default();
        store.upsert(row("a", "1"));
        let feed = store.feed();
        store.upsert(row("b", "1"));
        assert_eq!(reset(store.drain(&feed)), ["a", "b"]);
        assert_eq!(changed(store.drain(&feed)), []);
    }

    #[test]
    fn changes_coalesce_by_key_and_read_the_latest_item() {
        let store = Store::default();
        store.upsert(row("b", "1"));
        let feed = store.feed();
        reset(store.drain(&feed));
        store.upsert(row("a", "1"));
        store.upsert(row("a", "2"));
        store.upsert(row("b", "2"));
        store.delete(&row("b", "2"));
        assert_eq!(
            changed(store.drain(&feed)),
            [
                ("a".to_owned(), Some("2".to_owned())),
                ("b".to_owned(), None)
            ]
        );
    }

    #[test]
    fn an_add_then_a_delete_leaves_nothing_pending() {
        let store = Store::default();
        store.upsert(row("held", "1"));
        let feed = store.feed();
        reset(store.drain(&feed));
        for n in 0..10_000 {
            let uid = format!("short-lived-{n}");
            store.upsert(row(&uid, "1"));
            store.upsert(row(&uid, "2"));
            store.delete(&row(&uid, "2"));
        }
        assert_eq!(feed.0.lock().unwrap().keys.len(), 0);
        store.delete(&row("held", "1"));
        store.upsert(row("held", "2"));
        assert_eq!(
            changed(store.drain(&feed)),
            [("held".to_owned(), Some("2".to_owned()))],
            "a key the reader held stays pending through a delete"
        );
        store.delete(&row("held", "2"));
        assert_eq!(changed(store.drain(&feed)), [("held".to_owned(), None)]);
    }

    #[test]
    fn a_reread_holds_what_the_reader_now_holds() {
        let store = Store::default();
        store.upsert(row("a", "1"));
        let feed = store.feed();
        reset(store.drain(&feed));
        store.upsert(row("b", "1"));
        assert_eq!(reset(store.reread(&feed)), ["a", "b"]);
        assert_eq!(changed(store.drain(&feed)), [], "b was in the reread");
        store.delete(&row("b", "1"));
        assert_eq!(
            changed(store.drain(&feed)),
            [("b".to_owned(), None)],
            "a key the reread gave stays pending through a delete"
        );
    }

    #[test]
    fn deleting_what_the_store_lacks_changes_nothing() {
        let store = Store::default();
        let feed = store.feed();
        reset(store.drain(&feed));
        store.delete(&row("a", "1"));
        assert_eq!(changed(store.drain(&feed)), []);
    }

    #[test]
    fn a_relist_and_new_columns_reset_every_feed() {
        let store = Store::default();
        let feed = store.feed();
        reset(store.drain(&feed));
        store.upsert(row("a", "1"));
        let mut items = Items::new();
        collect(&mut items, row("b", "1"));
        store.replace(items);
        assert_eq!(reset(store.drain(&feed)), ["b"]);

        let columns: Arc<[Column]> = Arc::new([]);
        store.set_columns(Some(&columns));
        assert_eq!(reset(store.drain(&feed)), ["b"]);
        store.set_columns(Some(&columns));
        assert_eq!(changed(store.drain(&feed)), []);
    }

    #[test]
    fn feeds_are_their_own_and_a_dropped_one_goes() {
        let store = Store::default();
        let first = store.feed();
        let second = store.feed();
        reset(store.drain(&first));
        store.upsert(row("a", "1"));
        assert_eq!(changed(store.drain(&first)).len(), 1);
        assert_eq!(reset(store.drain(&second)), ["a"]);
        drop(second);
        store.upsert(row("b", "1"));
        assert_eq!(store.contents().feeds.len(), 1);
    }
}
