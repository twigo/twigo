//! Heap a logs session's buffer holds at its bound (ARCHITECTURE 4.6):
//! 50,000 lines of ten streams, read as the kubelet sends them, through
//! the stream's parser and the session's buffer, in flushes of 500 lines;
//! `pad` lengthens each line, so the bound of their bytes holds them.
//!
//! cargo run --release -p twigo-sessions --example logs_memory [pad]

use std::sync::Arc;

use twigo_ipc::{LevelFilter, LogView, LogWindow};
use twigo_sessions::logs::buffer::{Buffer, Kind, LIMITS, Origin};
use twigo_sessions::logs::view::{self, Spec};
use twigo_sessions::logs::{level, line};

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

const LINES: usize = 50_000;
const STREAMS: usize = 10;
const FLUSH: usize = 500;

fn mib(bytes: usize) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

/// One line as a container of each kind writes it: an access log, a JSON
/// logger, logfmt, klog, and a coloured console logger.
fn text(n: usize, rng: &mut fastrand::Rng) -> String {
    let id = rng.u32(10_000..99_999);
    let took = rng.u32(1..900);
    match rng.u8(0..10) {
        0..=3 => format!(
            r#"10.244.0.{} - - [03/Nov/2026:10:{:02}:{:02} +0000] "GET /api/v1/orders/{id}?expand=items HTTP/1.1" 200 {} "-" "Go-http-client/2.0""#,
            rng.u8(2..250),
            (n / 60) % 60,
            n % 60,
            rng.u32(200..9_000),
        ),
        4..=6 => format!(
            r#"{{"level":"{}","ts":"2026-11-03T10:00:00.{:03}Z","logger":"orders.handler","caller":"orders/handler.go:{}","msg":"order created","order_id":"{id}","user":"u-{}","items":{},"took_ms":{took}.{}}}"#,
            ["info", "info", "debug", "warn"][rng.usize(0..4)],
            rng.u32(0..1000),
            rng.u32(20..400),
            rng.u32(1000..9999),
            rng.u8(1..9),
            rng.u8(0..9),
        ),
        7 => format!(
            r#"time=2026-11-03T10:00:00Z level=info msg="reconciled" controller=payments namespace=shop name=checkout-{id} duration={took}ms"#
        ),
        8 => format!(
            "I1103 10:00:00.{:06}       1 reflector.go:{}] \"Watch close\" reflector=\"k8s.io/client-go/informers/factory.go:160\" type=\"*v1.Pod\" totalItems={took}",
            rng.u32(0..999_999),
            rng.u32(200..900),
        ),
        _ => format!(
            "\x1b[2m10:00:00.{:03}\x1b[0m \x1b[32mINFO\x1b[0m \x1b[1mworker\x1b[22m: job {id} done in \x1b[33m{took}ms\x1b[39m",
            rng.u32(0..1000),
        ),
    }
}

fn main() {
    let _profiler = dhat::Profiler::builder().testing().build();
    let pad: usize = std::env::args()
        .nth(1)
        .map_or(0, |pad| pad.parse().expect("a number of bytes"));
    let mut rng = fastrand::Rng::with_seed(24);
    let origins: Vec<Arc<Origin>> = (0..STREAMS)
        .map(|i| {
            Arc::new(Origin {
                pod: format!("checkout-7f9c8d6b5-{i:05}").into(),
                container: "checkout".into(),
            })
        })
        .collect();
    let spec = Spec::new(&LogView {
        level: LevelFilter::All,
        filter: None,
        search: None,
        range: None,
    })
    .unwrap();
    let start = 1_793_700_000_000_000_000i64;
    let raw: Vec<String> = (0..LINES)
        .map(|n| {
            let at =
                jiff::Timestamp::from_nanosecond(i128::from(start + n as i64 * 1_000_000)).unwrap();
            format!("{at:.9} {}{}", text(n, &mut rng), " ".repeat(pad))
        })
        .collect();

    let before = dhat::HeapStats::get();
    let mut buffer = Buffer::new(LIMITS);
    for (flush, lines) in raw.chunks(FLUSH).enumerate() {
        let entries = lines
            .iter()
            .enumerate()
            .map(|(i, raw)| {
                let parsed = line::parse(raw.as_bytes());
                let kind = Kind::Line {
                    origin: Arc::clone(&origins[(flush * FLUSH + i) % STREAMS]),
                    level: level::level(&parsed.text),
                    text: parsed.text.into(),
                    styles: parsed.styles.into(),
                };
                (parsed.at.expect("stamped"), kind)
            })
            .collect();
        buffer.insert(entries, |kind| spec.judge(kind));
    }
    let after = dhat::HeapStats::get();
    let held = after.curr_bytes - before.curr_bytes;
    let count = buffer.entries().len();
    let tail = view::window(&buffer, &spec, LogWindow::Tail { count: 200 });

    println!(
        "{count} lines of {STREAMS} streams in the buffer, {} of text",
        mib(buffer.bytes())
    );
    println!();
    println!("| Held by | {count} lines | Per line |");
    println!("| --- | --- | --- |");
    println!(
        "| The buffer (`twigo_sessions::logs::buffer`) | {} | {} B |",
        mib(held),
        held / count.max(1)
    );
    println!(
        "| Of which text | {} | {} B |",
        mib(buffer.bytes()),
        buffer.bytes() / count.max(1)
    );
    println!();
    println!(
        "A window of the last {} lines, as a batch carries it, took {} more while built.",
        tail.entries.len(),
        mib(dhat::HeapStats::get().curr_bytes - after.curr_bytes)
    );
}
