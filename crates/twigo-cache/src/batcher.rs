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
//! The rows come from a [`Source`]: a hub subscription, or rows made from
//! one, such as a release list's.
//!
//! The view part of the query, the text, the sort, the counts, the groups and
//! the values, changes in place ([`Batcher::set_view`]): the view reorders,
//! counts and groups the rows it holds, and asks its source for every row
//! again only when the text changes, since it holds just the rows that the
//! text keeps. The batch that reflects a change carries its number.
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
use twigo_ipc::{IpcError, ListBatch, ViewState};
use twigo_panic::contain;

use crate::hub::{Shown, Subscription};
use crate::metrics::{FIRST_ANSWER, INTERVAL, Opening, Reader};
use crate::table::Row;
use crate::view::{QueryView, Shape, Spec};

pub const FLUSH: Duration = Duration::from_millis(50);

/// What a list reads of the rows it shows.
pub trait Source: Send + 'static {
    /// What changed in the rows that show since the last call, and the state
    /// and the parts that say which these are ([`Subscription::drain_shown`]);
    /// with `all`, every row that shows as a [`crate::hub::Delta::Reset`] does.
    fn drain_shown(&mut self, all: bool) -> Shown<Row>;

    /// The rows are those of the namespaces the person may list, which all
    /// namespaces came to ([`Subscription::resolved`]).
    fn resolved(&self) -> bool;
}

impl Source for Subscription<Row> {
    fn drain_shown(&mut self, all: bool) -> Shown<Row> {
        if all {
            self.drain_all_shown()
        } else {
            Subscription::drain_shown(self)
        }
    }

    fn resolved(&self) -> bool {
        Subscription::resolved(self)
    }
}

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
    view: Option<(u32, Shape)>,
    /// The number of the newest view change kept, whether it waits or the task took it.
    newest_view: u32,
}

#[derive(Clone, Copy)]
struct Window {
    start: u32,
    end: u32,
    metrics: bool,
}

impl Batcher {
    /// Sends each batch through `send` until it says the webview is gone.
    /// `item` names the list for a panic's end and for `TWIGO_PANIC`.
    pub fn spawn(
        item: &'static str,
        source: impl Source,
        spec: Spec,
        metrics: Option<Opening>,
        send: impl FnMut(ListBatch) -> bool + Send + 'static,
    ) -> Self {
        let control = Arc::new(Control::default());
        let task = tokio::spawn(serve(
            item,
            source,
            spec,
            metrics,
            Arc::clone(&control),
            send,
        ));
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

    /// Changes the view part of the query to `shape`, which batches reflect from the next one
    /// on, each saying `view`. Changes that come while a batch waits for its ack go out
    /// together with the last of them. A change numbered no higher than one already kept came
    /// late, since commands reach the core in no set order, and is dropped.
    pub fn set_view(&self, view: u32, shape: Shape) {
        let mut pending = self.control.pending.lock().expect("batcher lock");
        if view <= pending.newest_view {
            return;
        }
        pending.newest_view = view;
        pending.view = Some((view, shape));
        drop(pending);
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
    fn holds(&mut self, view: &QueryView, settled: bool) -> bool {
        if self.shown || settled || !view.sorts_by_metric() {
            return false;
        }
        let since = *self.waiting_since.get_or_insert_with(Instant::now);
        since.elapsed() < FIRST_ANSWER
    }
}

/// Runs the list; if it panics, its last batch changes nothing but the
/// state, which says why, and nothing starts it again.
async fn serve(
    item: &'static str,
    source: impl Source,
    spec: Spec,
    opening: Option<Opening>,
    control: Arc<Control>,
    mut send: impl FnMut(ListBatch) -> bool,
) {
    let (mut seq, mut view, mut total) = (0, 0, 0);
    let mut tell = |batch: ListBatch| {
        (seq, view, total) = (batch.seq, batch.view, batch.total);
        send(batch)
    };
    if contain(item, run(source, spec, opening, control, &mut tell))
        .await
        .is_ok()
    {
        return;
    }
    send(ListBatch {
        seq: seq + 1,
        view,
        total,
        columns: None,
        window: None,
        upserts: Vec::new(),
        status: ViewState::Error {
            error: IpcError::panicked("this list"),
        },
        parts: None,
        counts: None,
        groups: None,
        metrics: None,
    });
}

async fn run(
    mut source: impl Source,
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
    let mut range: Option<(u32, u32)> = None;
    let mut moved = false;
    let mut asked: Option<(u32, Shape)> = None;
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
        let (window, acked, reshaped) = {
            let mut pending = control.pending.lock().expect("batcher lock");
            (
                pending.window.take(),
                pending.acked.take(),
                pending.view.take(),
            )
        };
        if reshaped.is_some() {
            asked = reshaped;
            moved = true;
        }
        if let Some(Window {
            start,
            end,
            metrics: read,
        }) = window
        {
            view.set_window(start, end);
            reading = read;
            windowed = true;
            moved |= range != Some((start, end));
            range = Some((start, end));
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
        if let Some(metrics) = &metrics {
            view.set_api(metrics.api());
        }
        let reshaped = asked.is_some();
        let all = match asked.take() {
            Some((number, shape)) => {
                first_order = FirstOrder::default();
                view.reshape(number, shape)
            }
            None => false,
        };
        let Shown {
            delta,
            status,
            parts,
        } = source.drain_shown(all);
        view.apply(delta);
        let mut settled = true;
        if let Some(metrics) = &mut metrics {
            if source.resolved() {
                view.resolved();
            }
            metrics.want(view.wants(reading));
            if reshaped {
                metrics.ask_again();
            }
            let (answered, update) = metrics.read();
            settled = answered;
            view.samples(update);
            view.sample_entered(|namespace, name| metrics.sample(namespace, name));
        }
        if first_order.holds(&view, settled) {
            continue;
        }
        if let Some(batch) = view.batch(status, parts) {
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
    use twigo_ipc::{ErrorCode, Gvr, ListQuery, Part, PartState, Parts, Sort, ViewState};
    use twigo_kube::client::{Budgets, Clients};

    use super::*;
    use crate::fake::Fake;
    use crate::hub::{Hub, Query, Resource, RowFormat};
    use crate::request::Selectors;

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
        subscribed_to(fake, &["a"]).await
    }

    async fn subscribed_to(
        fake: Fake,
        namespaces: &[&str],
    ) -> (Fake, (Hub, Arc<Clients>), Subscription<Row>, Spec) {
        subscribed_as(fake, namespaces, RowFormat::Metadata).await
    }

    async fn subscribed_as(
        fake: Fake,
        namespaces: &[&str],
        format: RowFormat,
    ) -> (Fake, (Hub, Arc<Clients>), Subscription<Row>, Spec) {
        let namespaces: Vec<String> = namespaces.iter().map(|&name| name.to_owned()).collect();
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
                format,
                namespaces: namespaces.clone(),
                selectors: Selectors::default(),
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
            namespaces,
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
        unwindowed_over(subscribed().await)
    }

    fn unwindowed_over(
        (fake, hub, subscription, spec): (Fake, (Hub, Arc<Clients>), Subscription<Row>, Spec),
    ) -> Rig {
        let (sender, batches) = mpsc::unbounded_channel();
        let batcher = Batcher::spawn("list", subscription, spec, None, move |batch| {
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
    async fn a_list_that_panics_ends_with_a_batch_that_says_so() {
        twigo_panic::inject::arm("list", 1);
        let mut rig = rig().await;
        let (_, last) = rig.next().await;
        assert_eq!(last.seq, 1);
        let ViewState::Error { error } = &last.status else {
            panic!("the list failed: {:?}", last.status);
        };
        assert_eq!(error.code, ErrorCode::InternalPanic);
        assert!(last.window.is_none() && last.upserts.is_empty());
        rig.fake.add("pods", Some("a"), "p2");
        sleep(FLUSH * 10).await;
        assert!(rig.batches.try_recv().is_err(), "it is not started again");
    }

    #[tokio::test(start_paused = true)]
    async fn the_last_batch_of_a_list_that_panics_later_follows_those_it_sent() {
        let (fake, hub, subscription, spec) = subscribed().await;
        let (sender, mut batches) = mpsc::unbounded_channel();
        let opening: Opening = Box::pin(async {
            sleep(Duration::from_secs(5)).await;
            panic!("a metrics bug")
        });
        let batcher = Batcher::spawn("list", subscription, spec, Some(opening), move |batch| {
            sender.send(batch).is_ok()
        });
        batcher.set_window(0, 100, false);
        let mut sent = Vec::new();
        let last = loop {
            let batch = batches.recv().await.unwrap();
            if matches!(batch.status, ViewState::Error { .. }) {
                break batch;
            }
            batcher.ack(batch.seq);
            sent.push((batch.seq, batch.total));
        };
        let &(seq, total) = sent.last().expect("it sent batches before it panicked");
        assert_eq!(total, 1, "listed");
        assert_eq!((last.seq, last.total), (seq + 1, total));
        drop((fake, hub));
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
    async fn a_change_of_the_metrics_alone_waits_for_the_interval() {
        let mut rig = rig().await;
        let (ticked, _) = rig.until_total(1).await;
        rig.fake.add("pods", Some("a"), "p2");
        sleep(Duration::from_millis(10)).await;
        rig.batcher.set_window(0, 100, true);
        let (at, batch) = rig.next().await;
        assert!(at - ticked >= FLUSH, "{:?}", at - ticked);
        assert_eq!(batch.total, 2);
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

    fn names(batch: &ListBatch) -> Vec<&str> {
        batch
            .window
            .as_ref()
            .expect("a window")
            .ids
            .iter()
            .map(|id| id.0.rsplit('/').next().unwrap())
            .collect()
    }

    fn by_name(descending: bool) -> Shape {
        Shape::of(|view| {
            view.sort = Some(Sort {
                column: "Name".to_owned(),
                descending,
            });
        })
    }

    async fn tabled(pods: &[(&str, &str)]) -> Rig {
        let fake = Fake::default();
        let mut namespaces: Vec<&str> = Vec::new();
        for &(namespace, pod) in pods {
            fake.add("pods", Some(namespace), pod);
            if !namespaces.contains(&namespace) {
                namespaces.push(namespace);
            }
        }
        unwindowed_over(subscribed_as(fake, &namespaces, RowFormat::Table).await)
    }

    async fn of_four() -> (Rig, ListBatch) {
        let mut rig = tabled(&[("a", "p1"), ("a", "p2"), ("a", "p3"), ("a", "p4")]).await;
        rig.batcher.set_window(0, 100, false);
        let (_, mut last) = rig.until_total(4).await;
        loop {
            sleep(FLUSH * 4).await;
            let Ok((_, batch)) = rig.batches.try_recv() else {
                return (rig, last);
            };
            rig.batcher.ack(batch.seq);
            last = batch;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_sort_in_place_reorders_the_window_and_sends_one_batch_naming_its_view() {
        let (mut rig, first) = of_four().await;
        assert_eq!(first.view, 0);

        let asked = Instant::now();
        rig.batcher.set_view(1, by_name(true));
        let (at, sorted) = rig.next().await;
        assert_eq!(at, asked, "at once, not on the next tick");
        assert_eq!(sorted.seq, first.seq + 1);
        assert_eq!(sorted.view, 1);
        assert_eq!(names(&sorted), ["p4", "p3", "p2", "p1"]);
        assert!(sorted.upserts.is_empty(), "the webview holds these rows");
        assert!(sorted.columns.is_none());
        rig.batcher.ack(sorted.seq);
        sleep(FLUSH * 5).await;
        assert!(rig.batches.try_recv().is_err(), "one batch answers it");
    }

    #[tokio::test(start_paused = true)]
    async fn a_view_that_changes_nothing_still_answers_with_its_number() {
        let (mut rig, first) = of_four().await;
        let asked = Instant::now();
        rig.batcher.set_view(1, by_name(false));
        let (at, same) = rig.next().await;
        assert_eq!(at, asked, "at once, though nothing it holds changed");
        assert_eq!((same.view, same.seq), (1, first.seq + 1));
        assert!(same.window.is_none() && same.upserts.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_text_that_changes_in_place_finds_the_rows_the_old_one_dropped() {
        let (mut rig, _) = of_four().await;
        rig.batcher
            .set_view(1, Shape::of(|view| view.text = Some("p1".to_owned())));
        let (_, filtered) = rig.next().await;
        assert_eq!((filtered.view, filtered.total), (1, 1));
        assert_eq!(names(&filtered), ["p1"]);
        rig.batcher.ack(filtered.seq);

        rig.fake.add("pods", Some("a"), "p5");
        rig.fake.delete("pods", Some("a"), "p3");
        rig.until_total(1).await;
        rig.batcher
            .set_view(2, Shape::of(|view| view.text = Some("p".to_owned())));
        let (_, widened) = rig.next().await;
        assert_eq!((widened.view, widened.total), (2, 4));
        assert_eq!(names(&widened), ["p1", "p2", "p4", "p5"]);
        assert_eq!(
            widened.upserts.len(),
            3,
            "the rows the webview lacks, not p1 again"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_column_choice_in_place_changes_what_the_text_reads() {
        let fake = Fake::default();
        fake.add("pods", Some("a"), "p1");
        fake.add("pods", Some("b"), "p2");
        let mut rig = unwindowed_over(subscribed_as(fake, &["a", "b"], RowFormat::Table).await);
        rig.batcher.set_window(0, 100, false);
        rig.until_total(2).await;
        let text = Some("b".to_owned());
        rig.batcher
            .set_view(1, Shape::of(|view| view.text.clone_from(&text)));
        let (_, read) = rig.next().await;
        rig.batcher.ack(read.seq);
        assert_eq!(
            names(&read),
            ["p2"],
            "Namespace is shown, so the filter reads it"
        );

        rig.batcher.set_view(
            2,
            Shape::of(|view| {
                view.text.clone_from(&text);
                view.columns = Some([("Namespace".to_owned(), false)].into());
            }),
        );
        let (_, hidden) = rig.next().await;
        assert_eq!((hidden.view, hidden.total), (2, 0), "Namespace is hidden");
    }

    #[tokio::test(start_paused = true)]
    async fn view_changes_while_a_batch_is_unacknowledged_go_out_together_with_the_ack() {
        let (mut rig, _) = of_four().await;
        rig.fake.add("pods", Some("a"), "p5");
        let (_, unacked) = rig.next().await;
        rig.batcher
            .set_view(1, Shape::of(|view| view.text = Some("p5".to_owned())));
        rig.batcher.set_view(2, by_name(true));
        sleep(FLUSH * 3).await;
        assert!(rig.batches.try_recv().is_err(), "it waits for the ack");
        let acked = Instant::now();
        rig.batcher.ack(unacked.seq);
        let (at, answer) = rig.next().await;
        assert_eq!(at, acked, "at once, not on the next tick");
        assert_eq!((answer.seq, answer.view), (unacked.seq + 1, 2));
        assert_eq!(names(&answer), ["p5", "p4", "p3", "p2", "p1"]);
        rig.batcher.ack(answer.seq);
        sleep(FLUSH * 5).await;
        assert!(
            rig.batches.try_recv().is_err(),
            "the first change never went out"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_view_change_older_than_the_pending_one_is_dropped() {
        let (mut rig, first) = of_four().await;
        rig.batcher.set_view(2, by_name(true));
        rig.batcher
            .set_view(1, Shape::of(|view| view.text = Some("p1".to_owned())));
        let (_, answer) = rig.next().await;
        assert_eq!((answer.seq, answer.view), (first.seq + 1, 2));
        assert_eq!(names(&answer), ["p4", "p3", "p2", "p1"]);
        rig.batcher.ack(answer.seq);

        rig.fake.add("pods", Some("a"), "p5");
        let (_, later) = rig.next().await;
        assert_eq!(later.view, 2);
        assert_eq!(later.total, 5);
    }

    #[tokio::test(start_paused = true)]
    async fn a_view_change_older_than_the_one_taken_is_dropped() {
        let (mut rig, _) = of_four().await;
        for (view, shape) in [
            (1, Shape::of(|view| view.text = Some("p1".to_owned()))),
            (2, by_name(true)),
        ] {
            rig.batcher.set_view(view, shape);
            let (_, answer) = rig.next().await;
            assert_eq!(answer.view, view);
            rig.batcher.ack(answer.seq);
        }

        rig.batcher
            .set_view(1, Shape::of(|view| view.text = Some("p1".to_owned())));
        sleep(FLUSH * 5).await;
        assert!(rig.batches.try_recv().is_err(), "it answers nothing");

        rig.fake.add("pods", Some("a"), "p5");
        let (_, later) = rig.next().await;
        assert_eq!((later.view, later.total), (2, 5));
        assert_eq!(names(&later), ["p5", "p4", "p3", "p2", "p1"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_view_change_and_a_window_change_in_one_round_are_one_batch() {
        let (mut rig, first) = of_four().await;
        rig.batcher.set_window(1, 3, false);
        rig.batcher.set_view(1, by_name(true));
        let (_, answer) = rig.next().await;
        assert_eq!((answer.seq, answer.view), (first.seq + 1, 1));
        let window = answer.window.as_ref().expect("a window");
        assert_eq!(window.start, 1);
        assert_eq!(names(&answer), ["p3", "p2"], "the middle of the new order");
        rig.batcher.ack(answer.seq);
        sleep(FLUSH * 5).await;
        assert!(rig.batches.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_view_change_before_the_first_window_answers_the_first_batch() {
        let mut rig = tabled(&[("a", "p1")]).await;
        rig.fake.add("pods", Some("a"), "p2");
        rig.batcher.set_view(1, by_name(true));
        sleep(FLUSH * 3).await;
        assert!(rig.batches.try_recv().is_err(), "nothing before a window");
        rig.batcher.set_window(0, 100, false);
        let (_, first) = rig.next().await;
        assert_eq!((first.seq, first.view), (1, 1));
        assert_eq!(names(&first), ["p2", "p1"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_list_over_a_forbidden_namespace_shows_the_others_and_says_which_it_lacks() {
        let fake = Fake::default();
        for namespace in ["a", "b", "c"] {
            fake.add("pods", Some(namespace), &format!("p-{namespace}"));
        }
        fake.state()
            .forbidden
            .insert("/api/v1/namespaces/c/pods".to_owned());
        let mut rig = unwindowed_over(subscribed_to(fake, &["a", "b", "c"]).await);
        rig.batcher.set_window(0, 100, false);

        let (_, first) = rig.until_total(2).await;
        assert_eq!(first.status, ViewState::Ready, "the rows shown are ready");
        assert_eq!(
            first.parts,
            Some(Parts {
                count: 3,
                omitted: 0,
                unready: vec![PartState {
                    part: Part::Namespace { name: "c".into() },
                    state: ViewState::Forbidden {
                        verb: "watch".into(),
                        resource: "pods".into(),
                    },
                    shown: false,
                }],
            })
        );

        rig.fake.add("pods", Some("a"), "p-a2");
        let (_, next) = rig.next().await;
        assert_eq!(next.total, 3);
        assert_eq!(next.parts, None, "the parts are sent when they change");
    }
}
