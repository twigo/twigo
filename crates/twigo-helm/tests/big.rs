//! A gzip bomb, built here: what decoding it costs in heap.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::Compression;
use flate2::write::GzEncoder;
use twigo_helm::{BOUND, Stored, summary};
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

#[test]
fn a_gzip_bomb_is_refused_at_the_bound_and_never_inflated_past_it() {
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
