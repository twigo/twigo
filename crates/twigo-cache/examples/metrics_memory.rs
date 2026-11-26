//! What the poller's polls of the cluster-wide scope cost in heap at 5,000 pods
//! (`bench/pods.sh`, kwok's usage, `bench/cluster.sh`), with one reader of the
//! scope, next to the hub's `hub_memory`: the first poll, and each of the next
//! four that tells the reader a changed key, from one landing to the next, in
//! bytes and blocks allocated and in the most the heap held above where it stood
//! when the poll before landed.
//!
//! A counting allocator wraps the system's, so a realloc counts as an
//! allocation of its new size.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-cache --example metrics_memory
#![expect(clippy::print_stdout, reason = "an example's output is its result")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashSet;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use kube::Config;
use kube::config::{KubeConfigOptions, Kubeconfig};
use tokio::sync::watch;
use twigo_cache::discovery::Followers;
use twigo_cache::hub::{Connect, Hub};
use twigo_cache::metrics::{INTERVAL, Kind, Poller, Scope};
use twigo_kube::client::{Clients, Gate, Options};
use twigo_kube::discovery::Cache;

struct Counting;

static IN_USE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static BLOCKS: AtomicUsize = AtomicUsize::new(0);

fn took(size: usize) {
    let now = IN_USE.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(now, Ordering::Relaxed);
    ALLOCATED.fetch_add(size, Ordering::Relaxed);
    BLOCKS.fetch_add(1, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let at = unsafe { System.alloc(layout) };
        if !at.is_null() {
            took(layout.size());
        }
        at
    }

    unsafe fn dealloc(&self, at: *mut u8, layout: Layout) {
        unsafe { System.dealloc(at, layout) };
        IN_USE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, at: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(at, layout, size) };
        if !moved.is_null() {
            IN_USE.fetch_sub(layout.size(), Ordering::Relaxed);
            took(size);
        }
        moved
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

#[derive(Clone, Copy)]
struct Mark {
    in_use: usize,
    allocated: usize,
    blocks: usize,
}

impl Mark {
    /// Opens a window: the peak is counted from the heap as it stands.
    fn open() -> Self {
        let in_use = IN_USE.load(Ordering::Relaxed);
        PEAK.store(in_use, Ordering::Relaxed);
        Self {
            in_use,
            allocated: ALLOCATED.load(Ordering::Relaxed),
            blocks: BLOCKS.load(Ordering::Relaxed),
        }
    }

    fn allocated(self) -> usize {
        ALLOCATED.load(Ordering::Relaxed) - self.allocated
    }

    fn blocks(self) -> usize {
        BLOCKS.load(Ordering::Relaxed) - self.blocks
    }

    fn peak(self) -> usize {
        PEAK.load(Ordering::Relaxed).saturating_sub(self.in_use)
    }

    fn held(self) -> usize {
        IN_USE.load(Ordering::Relaxed).saturating_sub(self.in_use)
    }
}

fn mib(bytes: usize) -> String {
    format!("{:.2} MiB", bytes as f64 / (1024.0 * 1024.0))
}

/// The process's resident set, as `ps` prints it.
fn resident() -> String {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .expect("ps runs");
    let kib: usize = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("ps prints a number");
    mib(kib * 1024)
}

/// What malloc's zones hold and have reserved, where the system says.
#[cfg(target_os = "macos")]
fn zones() -> Option<(usize, usize)> {
    #[repr(C)]
    #[derive(Default)]
    struct Statistics {
        blocks_in_use: u32,
        size_in_use: usize,
        max_size_in_use: usize,
        size_allocated: usize,
    }
    unsafe extern "C" {
        fn malloc_zone_statistics(zone: *mut std::ffi::c_void, statistics: *mut Statistics);
    }
    let mut statistics = Statistics::default();
    unsafe { malloc_zone_statistics(std::ptr::null_mut(), &mut statistics) };
    Some((statistics.size_in_use, statistics.size_allocated))
}

#[cfg(not(target_os = "macos"))]
fn zones() -> Option<(usize, usize)> {
    None
}

fn zoned() -> String {
    zones().map_or_else(String::new, |(in_use, reserved)| {
        format!("{} of {}", mib(in_use), mib(reserved))
    })
}

/// Polls after the first that are measured.
const POLLS: usize = 4;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: only kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let clients =
        Arc::new(Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap());
    clients.api.apiserver_version().await.unwrap();
    let connect: Connect = {
        let clients = Arc::clone(&clients);
        Arc::new(move |_context| {
            let clients = Arc::clone(&clients);
            Box::pin(async move { Ok(clients) })
        })
    };
    let directory =
        std::env::temp_dir().join(format!("twigo-metrics-memory-{}", std::process::id()));
    let hub = Hub::new(connect);
    let followers = Followers::new(hub.clone(), Arc::new(Cache::new(&directory)));
    let followed = followers
        .get(&context, async { watch::channel(None).1 })
        .await;
    let served = Poller::new(hub).context(&context, &followed);
    while !served.api().columns(Kind::Pods) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let mut reader = served.reader(Kind::Pods);
    let resident_before = resident();
    let zones_before = zoned();
    let first = Mark::open();
    reader.want(HashSet::from([Scope::Cluster]));
    let samples = loop {
        let update = reader.drain();
        if let Some(reset) = update.resets.into_iter().next() {
            break reset.samples;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let count = samples.len();
    drop(samples);
    let (first_in_all, first_blocks, first_peak) =
        (first.allocated(), first.blocks(), first.peak());
    let held = first.held();
    let resident_first = resident();
    let zones_first = zoned();

    let window = Mark::open();
    let mut cycle = window;
    let mut polls = Vec::new();
    let give_up = tokio::time::Instant::now() + INTERVAL * (POLLS as u32 + 2);
    while polls.len() < POLLS && tokio::time::Instant::now() < give_up {
        let changed = reader.drain().changes.len();
        if changed > 0 {
            polls.push((cycle.allocated(), cycle.blocks(), cycle.peak(), changed));
            cycle = Mark::open();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let resident_after = resident();
    let zones_after = zoned();

    println!("{count} pods with samples");
    println!();
    println!("| Representation | {count} pods | Per pod |");
    println!("| --- | --- | --- |");
    println!(
        "| The poller with one cluster-wide scope (`twigo_cache::metrics`) | {} | {} B |",
        mib(held),
        held / count.max(1)
    );
    println!();
    println!(
        "The first poll, connection included, allocated {} in {} blocks and held at most {} above the heap before it.",
        mib(first_in_all),
        first_blocks,
        mib(first_peak)
    );
    println!("| The next polls | Allocated | Blocks | Peak above the heap | Keys told |");
    println!("| --- | --- | --- | --- | --- |");
    for (n, (allocated, blocks, peak, changed)) in polls.iter().enumerate() {
        println!(
            "| {} | {} | {blocks} | {} | {changed} |",
            n + 2,
            mib(*allocated),
            mib(*peak)
        );
    }
    println!();
    println!("The heap grew by {} over those polls.", mib(window.held()));
    println!(
        "The process's resident set: {resident_before} before the poll, {resident_first} after the first, {resident_after} after the others."
    );
    if zones().is_some() {
        println!(
            "Malloc's zones held (of what they reserved): {zones_before} before the poll, {zones_first} after the first, {zones_after} after the others."
        );
    }
    std::fs::remove_dir_all(directory).ok();
}
