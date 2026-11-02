//! An upstream's row store (ARCHITECTURE 3.1): its items by uid, or by
//! namespace and name for objects without one, and the columns of a Table
//! upstream.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

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
}

impl<T: Item> Default for Store<T> {
    fn default() -> Self {
        Self {
            contents: Mutex::new(Contents {
                items: HashMap::new(),
                columns: None,
            }),
            version: watch::Sender::new(0),
        }
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
        self.contents().items.insert(key, Arc::new(item));
        self.changed();
    }

    pub fn delete(&self, item: &T) {
        let removed = self
            .contents()
            .items
            .remove(&RowKey::of(item.meta()))
            .is_some();
        if removed {
            self.changed();
        }
    }

    /// Replaces every item, as a relist ends.
    pub fn replace(&self, items: Items<T>) {
        self.contents().items = items;
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
            drop(contents);
            self.changed();
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
