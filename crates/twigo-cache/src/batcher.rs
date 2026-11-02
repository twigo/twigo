//! The batcher (ARCHITECTURE 3.5): one task per list subscription that
//! flushes its query view on a 50 ms interval, or sooner when the window
//! moves, and keeps at most one batch unacknowledged. It sends nothing
//! before the webview's first window, which comes once the webview has the
//! subscription's id: a first batch over rows already listed would show a
//! list with none of them. While it waits, the
//! changes coalesce in the row stores' feeds, so a hidden window, which
//! acknowledges nothing since the webview acks on an animation frame, costs
//! no more memory than its rows, and the next batch carries everything.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use twigo_ipc::ListBatch;

use crate::hub::Subscription;
use crate::table::Row;
use crate::view::{QueryView, Spec};

pub const FLUSH: Duration = Duration::from_millis(50);

/// A running list: dropping it ends its task and its subscription.
pub struct Batcher {
    control: Arc<Control>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Control {
    pending: Mutex<Pending>,
    wake: Notify,
}

/// What the webview asked for since the task last looked.
#[derive(Default)]
struct Pending {
    window: Option<(u32, u32)>,
    acked: Option<u32>,
}

impl Batcher {
    /// Sends each batch through `send` until it says the webview is gone.
    pub fn spawn(
        subscription: Subscription<Row>,
        spec: Spec,
        send: impl FnMut(ListBatch) -> bool + Send + 'static,
    ) -> Self {
        let control = Arc::new(Control::default());
        let task = tokio::spawn(run(subscription, spec, Arc::clone(&control), send));
        Self { control, task }
    }

    /// The rows from `start` up to `end`, exclusive, flushed without
    /// waiting for the interval once nothing is unacknowledged.
    pub fn set_window(&self, start: u32, end: u32) {
        self.control.pending.lock().expect("batcher lock").window = Some((start, end));
        self.control.wake.notify_one();
    }

    pub fn ack(&self, seq: u32) {
        self.control.pending.lock().expect("batcher lock").acked = Some(seq);
        self.control.wake.notify_one();
    }
}

impl Drop for Batcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn run(
    subscription: Subscription<Row>,
    spec: Spec,
    control: Arc<Control>,
    mut send: impl FnMut(ListBatch) -> bool,
) {
    let mut view = QueryView::new(spec);
    let mut interval = tokio::time::interval(FLUSH);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut unacked = None;
    let mut windowed = false;
    let mut moved = false;
    loop {
        let ticked = tokio::select! {
            _ = interval.tick() => true,
            () = control.wake.notified() => false,
        };
        let Pending { window, acked } =
            std::mem::take(&mut *control.pending.lock().expect("batcher lock"));
        if let Some((start, end)) = window {
            view.set_window(start, end);
            windowed = true;
            moved = true;
        }
        if acked.is_some() && acked == unacked {
            unacked = None;
        }
        if !windowed || unacked.is_some() || !(ticked || moved) {
            continue;
        }
        moved = false;
        // The state first: a list that ends between the two then shows
        // its rows on the next tick, rather than ready with some of them.
        let state = subscription.state();
        view.apply(subscription.drain());
        if let Some(batch) = view.batch(state) {
            unacked = Some(batch.seq);
            if !send(batch) {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;
    use tokio::time::{Instant, sleep};
    use twigo_ipc::{Gvr, ListQuery, ViewState};
    use twigo_kube::client::{Budgets, Clients};

    use super::*;
    use crate::fake::Fake;
    use crate::hub::{Hub, Query, Resource, RowFormat};

    struct Rig {
        fake: Fake,
        /// The hub's upstreams end with it.
        _hub: (Hub, Arc<Clients>),
        batcher: Batcher,
        batches: mpsc::UnboundedReceiver<(Instant, ListBatch)>,
    }

    async fn rig() -> Rig {
        let rig = unwindowed().await;
        rig.batcher.set_window(0, 100);
        rig
    }

    async fn unwindowed() -> Rig {
        let fake = Fake::default();
        fake.add("pods", Some("a"), "p1");
        let (hub, clients) = fake.hub(Budgets::default());
        let subscription = hub
            .rows(Query {
                context: "kind-test".to_owned(),
                resource: Resource {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: "pods".to_owned(),
                    namespaced: true,
                },
                format: RowFormat::Metadata,
                namespaces: vec!["a".to_owned()],
                field_selector: None,
            })
            .await
            .unwrap();
        let query = ListQuery {
            space: "kind-test".to_owned(),
            gvr: Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
            },
            namespaced: true,
            namespaces: vec!["a".to_owned()],
            label_selector: None,
            text: None,
            columns: None,
            sort: None,
            count_by: None,
            values: None,
        };
        let (sender, batches) = mpsc::unbounded_channel();
        let spec = Spec::new("kind-test", &query).unwrap();
        let batcher = Batcher::spawn(subscription, spec, move |batch| {
            sender.send((Instant::now(), batch)).is_ok()
        });
        Rig {
            fake,
            _hub: (hub, clients),
            batcher,
            batches,
        }
    }

    impl Rig {
        async fn next(&mut self) -> (Instant, ListBatch) {
            tokio::time::timeout(Duration::from_secs(600), self.batches.recv())
                .await
                .expect("a batch within ten minutes")
                .expect("the batcher runs")
        }

        /// Acks every batch until one is ready with `total` rows.
        async fn until_total(&mut self, total: u32) -> (Instant, ListBatch) {
            loop {
                let (at, batch) = self.next().await;
                self.batcher.ack(batch.seq);
                if batch.status == ViewState::Ready && batch.total == total {
                    return (at, batch);
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_goes_before_the_first_window() {
        let mut rig = unwindowed().await;
        sleep(FLUSH * 10).await;
        assert!(rig.batches.try_recv().is_err());
        rig.batcher.set_window(0, 100);
        let (_, first) = rig.next().await;
        assert_eq!(first.seq, 1);
        assert_eq!(first.status, ViewState::Ready, "listed while it waited");
        assert_eq!(first.total, 1);
        assert_eq!(first.window.unwrap().ids.len(), 1, "with its rows");
    }

    #[tokio::test(start_paused = true)]
    async fn flushes_at_most_every_fifty_milliseconds() {
        let mut rig = rig().await;
        let (mut last, _) = rig.until_total(1).await;
        for n in 2..=40 {
            rig.fake.add("pods", Some("a"), &format!("p{n}"));
            sleep(Duration::from_millis(5)).await;
            while let Ok((at, batch)) = rig.batches.try_recv() {
                assert!(at - last >= FLUSH, "{:?} after the last", at - last);
                last = at;
                rig.batcher.ack(batch.seq);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn sends_nothing_more_until_the_batch_is_acknowledged() {
        let mut rig = rig().await;
        let (_, ready) = rig.until_total(1).await;
        rig.fake.add("pods", Some("a"), "p2");
        let (_, unacked) = rig.next().await;
        assert_eq!(unacked.seq, ready.seq + 1);
        for n in 3..=10 {
            rig.fake.add("pods", Some("a"), &format!("p{n}"));
            sleep(FLUSH).await;
        }
        assert!(rig.batches.try_recv().is_err(), "it waits for the ack");
        rig.batcher.ack(unacked.seq);
        let (_, coalesced) = rig.next().await;
        assert_eq!(coalesced.seq, unacked.seq + 1);
        assert_eq!(coalesced.total, 10, "every change since, in one batch");
        assert_eq!(coalesced.upserts.len(), 8);
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_change_flushes_without_waiting_for_the_interval() {
        let mut rig = rig().await;
        for n in 2..=5 {
            rig.fake.add("pods", Some("a"), &format!("p{n}"));
        }
        let (ticked, _) = rig.until_total(5).await;
        sleep(Duration::from_millis(10)).await;
        rig.batcher.set_window(2, 4);
        let (at, batch) = rig.next().await;
        assert!(at - ticked < FLUSH, "{:?}", at - ticked);
        assert_eq!(batch.window.unwrap().start, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_change_while_unacknowledged_goes_out_with_the_ack() {
        let mut rig = rig().await;
        rig.until_total(1).await;
        rig.fake.add("pods", Some("a"), "p2");
        let (_, unacked) = rig.next().await;
        rig.batcher.set_window(1, 2);
        sleep(FLUSH * 3).await;
        assert!(rig.batches.try_recv().is_err());
        sleep(Duration::from_millis(10)).await;
        let acked = Instant::now();
        rig.batcher.ack(unacked.seq);
        let (at, batch) = rig.next().await;
        assert_eq!(at, acked, "at once, not on the next tick");
        assert_eq!(batch.window.unwrap().start, 1);
    }
}
