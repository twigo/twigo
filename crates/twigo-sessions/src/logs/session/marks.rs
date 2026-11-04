//! Where a logs session's pod marks stand (ARCHITECTURE 4.6): a pod's
//! `Joined` just before its first entry, and its `Left` just after its
//! latest while the buffer holds it, whatever the clocks of its node, the
//! API server and the session say.

use std::collections::HashMap;
use std::sync::Arc;

use crate::logs::buffer::{Buffer, Kind};
use crate::logs::view;

/// What a pod's streams wrote.
struct Written {
    /// When its first entry stands.
    first: i64,
    /// The time and id of its latest entry.
    last: (i64, u64),
}

/// A pod's marks, and what places them.
#[derive(Default)]
struct PodMarks {
    /// The id and time of its `Joined` entry, until the pod left or the
    /// bound dropped it.
    joined: Option<(u64, i64)>,
    written: Option<Written>,
    /// Once it left, its name and when the session saw it leave: its `Left`
    /// waits until its streams have ended, so it comes after the last of
    /// their entries.
    left: Option<(Box<str>, i64)>,
}

/// Each pod's marks, by its uid, which a pod made again under its name
/// does not share.
#[derive(Default)]
pub struct Marks(HashMap<Arc<str>, PodMarks>);

impl Marks {
    /// The pod's `Joined` entry is `id`, at `at`.
    pub fn joined(&mut self, uid: Arc<str>, id: u64, at: i64) {
        self.0.entry(uid).or_default().joined = Some((id, at));
    }

    /// The pod's streams wrote the entry `id`, at `at`.
    pub fn wrote(&mut self, uid: Arc<str>, at: i64, id: u64) {
        let written = &mut self.0.entry(uid).or_default().written;
        match written {
            Some(written) => {
                written.first = written.first.min(at);
                written.last = written.last.max((at, id));
            }
            None => {
                *written = Some(Written {
                    first: at,
                    last: (at, id),
                });
            }
        }
    }

    /// The pod `pod` left, as the session saw at `at`.
    pub fn left(&mut self, uid: &Arc<str>, pod: &str, at: i64) {
        self.0.entry(Arc::clone(uid)).or_default().left = Some((pod.into(), at));
    }

    /// The `Joined` entries the bound keeps: those of the pods that have
    /// written nothing, at their creation, so that each moves to its pod's
    /// first entry once one comes.
    pub fn held(&self) -> Vec<u64> {
        self.0
            .values()
            .filter(|marks| marks.written.is_none())
            .filter_map(|marks| marks.joined.map(|(id, _)| id))
            .collect()
    }

    /// Moves each `Joined` entry just before its pod's first entry, which
    /// may come long after the creation it stood at, or before it from a
    /// node whose clock runs behind the API server's: under its id, lower
    /// than those of its pod's entries, so it comes first at their time.
    /// Whether any moved.
    pub fn place(&mut self, buffer: &mut Buffer) -> bool {
        let mut moved = false;
        for marks in self.0.values_mut() {
            let (Some((id, at)), Some(Written { first, .. })) = (&mut marks.joined, &marks.written)
            else {
                continue;
            };
            if *first == *at {
                continue;
            }
            moved = true;
            let kept = buffer.place(*id, *at, *first);
            *at = *first;
            if !kept {
                marks.joined = None;
            }
        }
        moved
    }

    /// The `Left` entry of each pod that left and has no stream
    /// `streaming`, so every entry of the pod came: just after the latest
    /// of them while the buffer holds it, else at the leave, though not
    /// before its `Joined`.
    pub fn leave(&mut self, buffer: &Buffer, streaming: impl Fn(&str) -> bool) -> Vec<(i64, Kind)> {
        self.0
            .extract_if(|uid, marks| marks.left.is_some() && !streaming(uid))
            .map(|(_, marks)| {
                let (pod, left) = marks.left.expect("it left");
                let at = match marks.written {
                    Some(Written { last: (at, id), .. }) if buffer.holds(id, at) => at,
                    _ => marks.joined.map_or(left, |(_, at)| at.max(left)),
                };
                (
                    at,
                    Kind::Left {
                        pod,
                        time: view::rfc3339(left).into(),
                    },
                )
            })
            .collect()
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }
}

#[cfg(test)]
impl Marks {
    /// The pods whose `Left` waits for their streams, by their uids.
    pub fn leaving(&self) -> impl Iterator<Item = &str> {
        self.0
            .iter()
            .filter(|(_, marks)| marks.left.is_some())
            .map(|(uid, _)| &**uid)
    }
}
