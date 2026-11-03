//! A session's buffer (ARCHITECTURE 4.6): the entries of every stream in
//! time order, each with an id it keeps while buffered, bounded by lines
//! and bytes of text, oldest out first, with one `Dropped` entry before
//! them once any went.

use std::collections::VecDeque;
use std::sync::Arc;

use twigo_ipc::{Level, ObjectRef, TextStyle};

/// What the buffer holds at most: 50,000 entries and 32 MiB of their text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub entries: usize,
    pub bytes: usize,
}

pub const LIMITS: Limits = Limits {
    entries: 50_000,
    bytes: 32 << 20,
};

/// The pod and container a line or an end came from, shared by its
/// stream's entries.
#[derive(Debug, PartialEq, Eq)]
pub struct Origin {
    pub pod: Box<str>,
    pub container: Box<str>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Line {
        origin: Arc<Origin>,
        level: Option<Level>,
        text: Box<str>,
        styles: Box<[TextStyle]>,
    },
    Ended {
        origin: Arc<Origin>,
        time: Box<str>,
        exit_code: Option<i32>,
        reason: Option<Box<str>>,
        restarting: Option<Box<str>>,
    },
    Joined {
        pod: Box<str>,
        time: Box<str>,
        /// Boxed, as few entries have one.
        owner: Option<Box<ObjectRef>>,
    },
    Left {
        pod: Box<str>,
        time: Box<str>,
    },
}

impl Kind {
    fn bytes(&self) -> usize {
        match self {
            Kind::Line { text, .. } => text.len(),
            _ => 0,
        }
    }
}

/// What the view made of an entry, kept so that a new line costs only its
/// own filtering and search.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Judged {
    /// It passes the level and the filter, its range aside.
    pub passes: bool,
    /// The search's matches in its text.
    pub hits: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: u64,
    /// Nanoseconds since the Unix epoch, which orders entries, ties by id.
    pub at: i64,
    pub kind: Kind,
    pub judged: Judged,
}

impl Entry {
    fn key(&self) -> (i64, u64) {
        (self.at, self.id)
    }
}

/// The `Dropped` entry: its id and how many entries went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dropped {
    pub id: u64,
    pub count: u64,
}

#[derive(Debug)]
pub struct Buffer {
    limits: Limits,
    entries: VecDeque<Entry>,
    bytes: usize,
    next: u64,
    dropped: Option<Dropped>,
    /// Since the buffer was made, across clears.
    dropped_ever: u64,
}

impl Buffer {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            entries: VecDeque::new(),
            bytes: 0,
            next: 0,
            dropped: None,
            dropped_ever: 0,
        }
    }

    fn id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    /// Adds entries in the order they came, each with the next id and what
    /// `judge` makes of it, at its place in time.
    pub fn insert(&mut self, incoming: Vec<(i64, Kind)>, judge: impl Fn(&Kind) -> Judged) {
        let mut fresh: Vec<Entry> = incoming
            .into_iter()
            .map(|(at, kind)| Entry {
                id: self.id(),
                at,
                judged: judge(&kind),
                kind,
            })
            .collect();
        fresh.sort_by_key(Entry::key);
        let Some(first) = fresh.first().map(Entry::key) else {
            return;
        };
        self.bytes += fresh.iter().map(|entry| entry.kind.bytes()).sum::<usize>();
        // Lines mostly come in order, so only the few entries after the
        // earliest new one move.
        let split = self.entries.partition_point(|entry| entry.key() < first);
        let later: Vec<Entry> = self.entries.drain(split..).collect();
        let (mut later, mut fresh) = (later.into_iter().peekable(), fresh.into_iter().peekable());
        loop {
            let next = match (later.peek(), fresh.peek()) {
                (Some(old), Some(new)) if old.key() < new.key() => later.next(),
                (Some(_), Some(_)) | (None, Some(_)) => fresh.next(),
                (Some(_), None) => later.next(),
                (None, None) => break,
            };
            self.entries.extend(next);
        }
        self.bound();
    }

    fn bound(&mut self) {
        let mut count = 0;
        while self.entries.len() > self.limits.entries || self.bytes > self.limits.bytes {
            let Some(oldest) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= oldest.kind.bytes();
            count += 1;
        }
        if count == 0 {
            return;
        }
        self.dropped_ever += count;
        let id = match self.dropped {
            Some(dropped) => dropped.id,
            None => self.id(),
        };
        let before = self.dropped.map_or(0, |dropped| dropped.count);
        self.dropped = Some(Dropped {
            id,
            count: before + count,
        });
    }

    /// Empties it for a source read anew; ids go on from where they were.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.dropped = None;
    }

    /// Judges every entry again, for a new view.
    pub fn judge(&mut self, judge: impl Fn(&Kind) -> Judged) {
        for entry in &mut self.entries {
            entry.judged = judge(&entry.kind);
        }
    }

    pub fn entries(&self) -> &VecDeque<Entry> {
        &self.entries
    }

    pub fn dropped(&self) -> Option<Dropped> {
        self.dropped
    }

    /// The entries it dropped since it was made.
    pub fn dropped_ever(&self) -> u64 {
        self.dropped_ever
    }

    /// The bytes of text it holds.
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> Kind {
        Kind::Line {
            origin: Arc::new(Origin {
                pod: "web-1".into(),
                container: "web".into(),
            }),
            level: None,
            text: text.into(),
            styles: Box::new([]),
        }
    }

    fn texts(buffer: &Buffer) -> Vec<(u64, &str)> {
        buffer
            .entries()
            .iter()
            .map(|entry| match &entry.kind {
                Kind::Line { text, .. } => (entry.id, &**text),
                _ => (entry.id, "marker"),
            })
            .collect()
    }

    fn judged(_: &Kind) -> Judged {
        Judged::default()
    }

    #[test]
    fn streams_merge_in_time_and_keep_their_ids() {
        let mut buffer = Buffer::new(LIMITS);
        buffer.insert(vec![(10, line("a10")), (30, line("a30"))], judged);
        buffer.insert(
            vec![(20, line("b20")), (30, line("b30")), (5, line("b5"))],
            judged,
        );
        assert_eq!(
            texts(&buffer),
            [(5, "b5"), (1, "a10"), (3, "b20"), (2, "a30"), (4, "b30")]
        );
    }

    #[test]
    fn the_bound_drops_the_oldest_and_counts_them() {
        let mut buffer = Buffer::new(Limits {
            entries: 3,
            bytes: 1 << 20,
        });
        buffer.insert(
            (1..=4).map(|at| (at, line(&format!("l{at}")))).collect(),
            judged,
        );
        assert_eq!(texts(&buffer), [(2, "l2"), (3, "l3"), (4, "l4")]);
        assert_eq!(buffer.dropped(), Some(Dropped { id: 5, count: 1 }));
        buffer.insert(vec![(5, line("l5")), (6, line("l6"))], judged);
        assert_eq!(texts(&buffer), [(4, "l4"), (6, "l5"), (7, "l6")]);
        assert_eq!(buffer.dropped(), Some(Dropped { id: 5, count: 3 }));
        assert_eq!(buffer.dropped_ever(), 3);

        buffer.clear();
        assert_eq!(buffer.dropped(), None);
        buffer.insert(vec![(1, line("again"))], judged);
        assert_eq!(texts(&buffer), [(8, "again")]);
        assert_eq!(buffer.dropped_ever(), 3);
    }

    #[test]
    fn the_bound_counts_bytes_of_text() {
        let mut buffer = Buffer::new(Limits {
            entries: 100,
            bytes: 10,
        });
        buffer.insert(vec![(1, line("12345")), (2, line("67890"))], judged);
        assert_eq!((buffer.entries().len(), buffer.bytes()), (2, 10));
        buffer.insert(vec![(3, line("x"))], judged);
        assert_eq!(texts(&buffer), [(2, "67890"), (3, "x")]);
        assert_eq!(buffer.bytes(), 6);
        assert_eq!(buffer.dropped().map(|dropped| dropped.count), Some(1));
    }

    #[test]
    fn a_late_line_older_than_all_is_the_one_dropped() {
        let mut buffer = Buffer::new(Limits {
            entries: 2,
            bytes: 1 << 20,
        });
        buffer.insert(vec![(10, line("new")), (20, line("newer"))], judged);
        buffer.insert(vec![(1, line("late"))], judged);
        assert_eq!(texts(&buffer), [(1, "new"), (2, "newer")]);
    }
}
