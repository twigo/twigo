//! A release near Kubernetes' limit of 1 MiB for a Secret's data, and a gzip
//! bomb, both built here: what decoding them costs in time and heap.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::Compression;
use flate2::write::GzEncoder;
use twigo_helm::{BOUND, Stored, page, summary};
use twigo_ipc::ErrorCode;

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

/// One measurement at a time, as the counters are the process's.
static MEASURING: Mutex<()> = Mutex::new(());

fn peak<T>(run: impl FnOnce() -> T) -> (T, usize) {
    let before = IN_USE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let out = run();
    (out, PEAK.load(Ordering::Relaxed) - before)
}

fn gzipped(write: impl FnOnce(&mut GzEncoder<Vec<u8>>)) -> Vec<u8> {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::best());
    write(&mut gzip);
    gzip.finish().unwrap()
}

fn labels(name: &str) -> BTreeMap<String, String> {
    [
        ("owner", "helm"),
        ("name", name),
        ("status", "deployed"),
        ("version", "1"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .collect()
}

fn stored<'a>(
    name: &'a str,
    labels: &'a BTreeMap<String, String>,
    release: &'a [u8],
) -> Stored<'a> {
    Stored {
        name,
        namespace: "big",
        kind: "helm.sh/release.v1",
        labels,
        release: Some(release),
    }
}

fn near_the_limit() -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let blob: Vec<u8> = (0..760_000)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect();
    let mut manifest = String::from(
        "---\n# Source: big/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: big\nstringData:\n  password: big-password\n",
    );
    for index in 0..300 {
        manifest.push_str(&format!(
            "---\n# Source: big/templates/config.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: big-{index}\ndata:\n  index: \"{index}\"\n"
        ));
    }
    let release = serde_json::json!({
        "name": "big",
        "info": {
            "first_deployed": "2026-11-22T20:00:00Z",
            "last_deployed": "2026-11-22T20:00:00Z",
            "status": "deployed",
            "description": "Install complete",
            "notes": "Log in with big-password.",
        },
        "chart": {
            "metadata": { "name": "big", "version": "0.1.0", "appVersion": "1.0.0" },
            "values": { "password": "chart-default" },
            "files": [{ "name": "files/blob.bin", "data": STANDARD.encode(&blob) }],
        },
        "config": { "password": "big-password" },
        "manifest": manifest,
        "version": 1,
        "namespace": "big",
    });
    let json = serde_json::to_vec(&release).unwrap();
    STANDARD
        .encode(gzipped(|gzip| gzip.write_all(&json).unwrap()))
        .into_bytes()
}

#[test]
fn a_release_near_the_limit_decodes_and_prints_its_cost() {
    let _one = MEASURING.lock().unwrap_or_else(PoisonError::into_inner);
    let release = near_the_limit();
    assert!(
        (1_000_000..=1_048_576).contains(&release.len()),
        "{} bytes",
        release.len()
    );
    let labels = labels("big");
    let stored = stored("sh.helm.release.v1.big.v1", &labels, &release);
    let started = Instant::now();
    let (decoded, heap) = peak(|| summary(&stored));
    let row = started.elapsed();
    assert_eq!(decoded.unwrap().chart().as_deref(), Some("big-0.1.0"));
    let started = Instant::now();
    let (opened, page_heap) = peak(|| page(&stored).ok().unwrap());
    let took = started.elapsed();
    assert_eq!(opened.manifest().secrets.len(), 1);
    assert!(opened.notes().hidden);
    println!(
        "a release of {} bytes stored: its summary in {row:?} at a peak of {heap} bytes, its page in {took:?} at a peak of {page_heap} bytes",
        release.len()
    );
}

#[test]
fn a_gzip_bomb_is_refused_at_the_bound_and_never_inflated_past_it() {
    let _one = MEASURING.lock().unwrap_or_else(PoisonError::into_inner);
    let release = STANDARD
        .encode(gzipped(|gzip| {
            gzip.write_all(br#"{"name":"bomb","#).unwrap();
            let spaces = vec![b' '; 1 << 20];
            for _ in 0..48 {
                gzip.write_all(&spaces).unwrap();
            }
            gzip.write_all(br#""version":1}"#).unwrap();
        }))
        .into_bytes();
    let labels = labels("bomb");
    let stored = stored("sh.helm.release.v1.bomb.v1", &labels, &release);
    let (refused, heap) = peak(|| summary(&stored).unwrap_err());
    assert_eq!(refused.code, ErrorCode::HelmTooLarge);
    assert!(
        heap < BOUND + (1 << 20),
        "{heap} bytes at the peak for a bound of {BOUND}"
    );
}
