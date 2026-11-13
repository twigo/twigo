//! The batcher (ARCHITECTURE 3.5): one task per list subscription that
//! flushes its query view on a 50 ms interval, or sooner when the window
//! moves, and keeps at most one batch unacknowledged. It sends nothing
//! before the webview's first window, which comes once the webview has the
//! subscription's id: a first batch over rows already listed would show a
//! list with none of them. While it waits, the
//! changes coalesce in the row stores' feeds, so a hidden window, which
//! acknowledges nothing since the webview acks on an animation frame, costs
//! no more memory than its rows and no wake-ups, and the next batch carries
//! everything.
//!
//! A list of pods or nodes whose context serves metrics also joins them
//! (ARCHITECTURE 3.6): it asks the poller for the namespaces of its window at
//! each flush, and for nothing before its first window, while its metric
//! columns are not read, or once a batch has gone unacknowledged for a poll's
//! interval, as a hidden window leaves it. One sorted by a metric holds the
//! first batch that shows its rows until its scopes have answered once, for
//! at most [`FIRST_ANSWER`], so that the first order is the true one.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, sleep_until};
use twigo_ipc::ListBatch;

use crate::hub::Subscription;
use crate::metrics::{FIRST_ANSWER, INTERVAL, Opening, Reader};
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
    window: Option<Window>,
    acked: Option<u32>,
}

#[derive(Clone, Copy)]
struct Window {
    start: u32,
    end: u32,
    metrics: bool,
}

impl Batcher {
    /// Sends each batch through `send` until it says the webview is gone.
    pub fn spawn(
        subscription: Subscription<Row>,
        spec: Spec,
        metrics: Option<Opening>,
        send: impl FnMut(ListBatch) -> bool + Send + 'static,
    ) -> Self {
        let control = Arc::new(Control::default());
        let task = tokio::spawn(run(subscription, spec, metrics, Arc::clone(&control), send));
        Self { control, task }
    }

    /// The rows from `start` up to `end`, exclusive, flushed without
    /// waiting for the interval once nothing is unacknowledged.
    pub fn set_window(&self, start: u32, end: u32, metrics: bool) {
        self.control.pending.lock().expect("batcher lock").window = Some(Window {
            start,
            end,
            metrics,
        });
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

/// A list sorted by a metric, whose window reads metrics, has the order of its rows wrong until
/// the answers come, so the first batch with rows waits for them.
#[derive(Default)]
struct FirstOrder {
    waiting_since: Option<Instant>,
    shown: bool,
}

impl FirstOrder {
    fn holds(&mut self, view: &QueryView, metrics: Option<&Reader>) -> bool {
        let Some(metrics) = metrics.filter(|_| !self.shown && view.sorts_by_metric()) else {
            return false;
        };
        if metrics.settled() {
            return false;
        }
        let since = *self.waiting_since.get_or_insert_with(Instant::now);
        since.elapsed() < FIRST_ANSWER
    }
}

async fn run(
    subscription: Subscription<Row>,
    spec: Spec,
    mut opening: Option<Opening>,
    control: Arc<Control>,
    mut send: impl FnMut(ListBatch) -> bool,
) {
    let mut metrics: Option<Reader> = None;
    let mut view = QueryView::new(spec);
    let mut interval = tokio::time::interval(FLUSH);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut unacked = None;
    let mut windowed = false;
    let mut moved = false;
    let mut reading = false;
    let mut unanswered: Option<Instant> = None;
    let mut first_order = FirstOrder::default();
    loop {
        let ticked = tokio::select! {
            _ = interval.tick(), if unacked.is_none() => true,
            () = control.wake.notified() => false,
            () = sleep_until(unanswered.unwrap_or_else(Instant::now)), if unanswered.is_some() => {
                if let Some(metrics) = &mut metrics {
                    metrics.want(HashSet::new());
                }
                unanswered = None;
                false
            }
        };
        let Pending { window, acked } =
            std::mem::take(&mut *control.pending.lock().expect("batcher lock"));
        if let Some(Window {
            start,
            end,
            metrics: read,
        }) = window
        {
            view.set_window(start, end);
            reading = read;
            windowed = true;
            moved = true;
        }
        if acked.is_some() && acked == unacked {
            unacked = None;
            unanswered = None;
        }
        if !windowed || unacked.is_some() || !(ticked || moved) {
            continue;
        }
        moved = false;
        if let Some(pending) = &mut opening
            && let Some(reader) = pending.now_or_never()
        {
            metrics = Some(reader);
            opening = None;
        }
        // The state first: a list that ends between the two then shows
        // its rows on the next tick, rather than ready with some of them.
        let state = subscription.state();
        view.apply(subscription.drain());
        if let Some(metrics) = &mut metrics {
            view.set_api(metrics.api());
            metrics.want(view.wants(reading));
            view.samples(metrics.drain());
            view.sample_entered(|namespace, name| metrics.sample(namespace, name));
        }
        if first_order.holds(&view, metrics.as_ref()) {
            continue;
        }
        if let Some(batch) = view.batch(state) {
            first_order.shown |= batch.total > 0;
            unacked = Some(batch.seq);
            unanswered = metrics
                .as_ref()
                .filter(|metrics| !metrics.wants().is_empty())
                .map(|_| Instant::now() + INTERVAL);
            if !send(batch) {
                return;
            }
            interval.reset();
        }
    }
}

#[cfg(test)]
mod metered;

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        rig.batcher.set_window(0, 100, false);
        rig
    }

    async fn subscribed() -> (Fake, (Hub, Arc<Clients>), Subscription<Row>, Spec) {
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
            field_selector: None,
            owners: None,
            text: None,
            columns: None,
            sort: None,
            count_by: None,
            group_by: None,
            values: None,
        };
        let spec = Spec::new("kind-test", &query).unwrap();
        (fake, (hub, clients), subscription, spec)
    }

    async fn unwindowed() -> Rig {
        let (fake, hub, subscription, spec) = subscribed().await;
        let (sender, batches) = mpsc::unbounded_channel();
        let batcher = Batcher::spawn(subscription, spec, None, move |batch| {
            sender.send((Instant::now(), batch)).is_ok()
        });
        Rig {
            fake,
            _hub: hub,
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
        rig.batcher.set_window(0, 100, false);
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
    async fn a_late_ack_flushes_at_once_and_the_next_tick_waits_its_interval() {
        let mut rig = rig().await;
        rig.until_total(1).await;
        rig.fake.add("pods", Some("a"), "p2");
        let (_, unacked) = rig.next().await;
        rig.fake.add("pods", Some("a"), "p3");
        sleep(FLUSH * 3 + Duration::from_millis(20)).await;
        let acked = Instant::now();
        rig.batcher.ack(unacked.seq);
        let (at, late) = rig.next().await;
        assert_eq!(at, acked);
        rig.fake.add("pods", Some("a"), "p4");
        rig.batcher.ack(late.seq);
        let (next, _) = rig.next().await;
        assert!(next - at >= FLUSH, "{:?} after the late one", next - at);
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_change_on_a_late_ack_leaves_no_tick_owed() {
        let mut rig = rig().await;
        rig.until_total(1).await;
        rig.fake.add("pods", Some("a"), "p2");
        let (_, unacked) = rig.next().await;
        rig.batcher.set_window(0, 50, false);
        sleep(FLUSH * 3 + Duration::from_millis(20)).await;
        rig.batcher.ack(unacked.seq);
        let (at, moved) = rig.next().await;
        rig.fake.add("pods", Some("a"), "p3");
        rig.batcher.ack(moved.seq);
        let (next, _) = rig.next().await;
        assert!(next - at >= FLUSH, "{:?} after the moved one", next - at);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unacknowledged_list_is_not_woken_before_the_ack() {
        let (_fake, _hub, subscription, spec) = subscribed().await;
        let control = Arc::new(Control::default());
        let (sender, mut batches) = mpsc::unbounded_channel();
        let mut task = Box::pin(run(
            subscription,
            spec,
            None,
            Arc::clone(&control),
            move |batch| sender.send(batch).is_ok(),
        ));
        let polls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&polls);
        let _running = tokio::spawn(std::future::poll_fn(move |cx| {
            counted.fetch_add(1, Ordering::Relaxed);
            task.as_mut().poll(cx)
        }));
        control.pending.lock().unwrap().window = Some(Window {
            start: 0,
            end: 100,
            metrics: false,
        });
        control.wake.notify_one();
        batches.recv().await.expect("the first batch");
        sleep(Duration::from_millis(1)).await;

        let before = polls.load(Ordering::Relaxed);
        sleep(FLUSH * 10).await;
        assert_eq!(polls.load(Ordering::Relaxed), before);
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_change_flushes_without_waiting_for_the_interval() {
        let mut rig = rig().await;
        for n in 2..=5 {
            rig.fake.add("pods", Some("a"), &format!("p{n}"));
        }
        let (ticked, _) = rig.until_total(5).await;
        sleep(Duration::from_millis(10)).await;
        rig.batcher.set_window(2, 4, false);
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
        rig.batcher.set_window(1, 2, false);
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
