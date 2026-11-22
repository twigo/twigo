//! What decoding a release near Kubernetes' 1 MiB limit for a Secret costs
//! in heap, with no cluster: a release generated as a chart of dashboards
//! stores it, each file twice, in its files and in the ConfigMaps its
//! manifest renders them into, with a Secret among them, encoded as Helm
//! encodes it. For a list row's summary and for an editor's page: the peak
//! over the heap before, and what the decoded value keeps.
//!
//! cargo run --release -p twigo-helm --example helm_memory
#![expect(clippy::print_stdout, reason = "an example's output is its result")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::Compression;
use flate2::write::GzEncoder;
use twigo_helm::{Stored, page, summary};

struct Counting;

static IN_USE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let at = unsafe { System.alloc(layout) };
        if !at.is_null() {
            let now = IN_USE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        at
    }

    unsafe fn dealloc(&self, at: *mut u8, layout: Layout) {
        unsafe { System.dealloc(at, layout) };
        IN_USE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// What `run` keeps once it returns, and the most it held while it ran,
/// both over the heap before it, with how long it took.
fn measured<T>(run: impl FnOnce() -> T) -> (T, usize, usize, std::time::Duration) {
    let before = IN_USE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let started = Instant::now();
    let out = run();
    let took = started.elapsed();
    let kept = IN_USE.load(Ordering::Relaxed) - before;
    (out, kept, PEAK.load(Ordering::Relaxed) - before, took)
}

const WORDS: [&str; 32] = [
    "cpu",
    "memory",
    "rate",
    "sum",
    "pod",
    "node",
    "latency",
    "seconds",
    "bucket",
    "total",
    "request",
    "error",
    "namespace",
    "container",
    "usage",
    "bytes",
    "network",
    "receive",
    "transmit",
    "disk",
    "read",
    "write",
    "quantile",
    "avg",
    "max",
    "min",
    "job",
    "instance",
    "panel",
    "graph",
    "legend",
    "threshold",
];
const FILES: usize = 13;
const PANELS: usize = 1500;

/// Helm's base64 of the gzip of a generated release's JSON, and the JSON's
/// size.
fn near_the_limit() -> (Vec<u8>, usize) {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut word = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        WORDS[(state % WORDS.len() as u64) as usize]
    };
    let mut files = Vec::new();
    let mut manifest = String::from(
        "---\n# Source: dashboards/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: dashboards\nstringData:\n  password: a-password-of-the-release\n",
    );
    for file in 0..FILES {
        let mut text = String::from("{\"panels\": [\n");
        for panel in 0..PANELS {
            text.push_str(&format!(
                "  {{\"id\": {panel}, \"title\": \"{} {} {}\", \"expr\": \"{}({}_{}_{}{{job=\\\"{}\\\"}}[5m])\"}},\n",
                word(),
                word(),
                word(),
                word(),
                word(),
                word(),
                word(),
                word()
            ));
        }
        text.push_str("  {}\n]}\n");
        manifest.push_str(&format!(
            "---\n# Source: dashboards/templates/dashboards.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: dashboards-{file:02}\ndata:\n  dashboard.json: |-\n"
        ));
        for line in text.lines() {
            manifest.push_str("    ");
            manifest.push_str(line);
            manifest.push('\n');
        }
        files.push(serde_json::json!({
            "name": format!("files/dashboard-{file:02}.json"),
            "data": STANDARD.encode(&text),
        }));
    }
    let release = serde_json::json!({
        "name": "dashboards",
        "namespace": "big",
        "version": 1,
        "info": {
            "first_deployed": "2026-11-22T20:00:00Z",
            "last_deployed": "2026-11-22T20:00:00Z",
            "status": "deployed",
            "description": "Install complete",
            "notes": "Dashboards are in the ConfigMaps dashboards-*.",
        },
        "chart": {
            "metadata": { "name": "dashboards", "version": "0.1.0", "appVersion": "1.0.0" },
            "values": { "password": "a-default-password" },
            "files": files,
        },
        "config": { "password": "a-password-of-the-release" },
        "manifest": manifest,
    });
    let json = serde_json::to_vec(&release).unwrap();
    let mut gzip = GzEncoder::new(Vec::new(), Compression::best());
    gzip.write_all(&json).unwrap();
    (
        STANDARD.encode(gzip.finish().unwrap()).into_bytes(),
        json.len(),
    )
}

fn main() {
    let (release, json) = near_the_limit();
    assert!(
        release.len() <= 1_048_576,
        "{} bytes stored, past Kubernetes' limit",
        release.len()
    );
    let labels: BTreeMap<String, String> = [
        ("owner", "helm"),
        ("name", "dashboards"),
        ("status", "deployed"),
        ("version", "1"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .collect();
    let stored = Stored {
        name: "sh.helm.release.v1.dashboards.v1",
        namespace: "big",
        kind: "helm.sh/release.v1",
        labels: &labels,
        release: Some(&release),
    };
    println!(
        "A release of {} bytes stored, {json} bytes of JSON.",
        release.len()
    );
    println!();
    println!("| Decoded as | Peak over the heap before | Kept | Time |");
    println!("| --- | --- | --- | --- |");
    let (row, kept, peak, took) = measured(|| summary(&stored).unwrap());
    println!("| a list row's summary | {peak} B | {kept} B | {took:.1?} |");
    drop(row);
    let (opened, kept, peak, took) = measured(|| page(&stored).ok().unwrap());
    println!("| an editor's page | {peak} B | {kept} B | {took:.1?} |");
    drop(opened);
}
