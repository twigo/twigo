//! The IPC bench of M0 step 4 (docs/spikes/tauri-isolation.md), shared by the `brownfield` and `isolation` apps.
//!
//! `TWIGO_BENCH_IPC` picks what the page runs: `cost` or `frames`.
//! The page ends with `report`, which prints one JSON line and exits non-zero on a failed check.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::http::{Response, StatusCode, header::CONTENT_TYPE};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::utils::config::PatternKind;
use tauri::{AppHandle, State};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

const PROBE_HTML: &[u8] = include_bytes!("../frame/probe.html");

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Cost,
    Frames,
}

impl Mode {
    fn from_env() -> Result<Self, String> {
        match std::env::var("TWIGO_BENCH_IPC").as_deref() {
            Ok("cost") => Ok(Self::Cost),
            Ok("frames") => Ok(Self::Frames),
            _ => Err("set TWIGO_BENCH_IPC to cost or frames".to_owned()),
        }
    }
}

#[derive(Default)]
struct Probes(Mutex<HashMap<String, u32>>);

#[derive(Default)]
struct Acks(Mutex<HashMap<u32, mpsc::UnboundedSender<u64>>>);

/// Paced streams tick on one grid counted from here, so that they all flush on the same tick.
struct Epoch(Instant);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamStats {
    batches: u64,
    bytes: usize,
    elapsed_ms: f64,
    send_to_ack_ms: Vec<f64>,
}

#[tauri::command]
fn mode(state: State<'_, Mode>) -> Mode {
    *state
}

#[tauri::command]
fn echo(data: String) -> String {
    data
}

/// Sends `batches` batches of about `bytes` bytes of Table-like rows, each after the previous one was acknowledged, as 3.5's flow control does.
/// With `interval_ms`, a batch also waits for the next tick.
#[tauri::command]
async fn stream(
    id: u32,
    bytes: usize,
    batches: u64,
    interval_ms: u64,
    channel: Channel<InvokeResponseBody>,
    acks: State<'_, Acks>,
    epoch: State<'_, Epoch>,
) -> Result<StreamStats, String> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    acks.0.lock().expect("acks lock").insert(id, tx);

    let rows = rows(bytes);
    let mut ticker = (interval_ms > 0).then(|| {
        let period = Duration::from_millis(interval_ms);
        let ticks = epoch.0.elapsed().as_nanos() / period.as_nanos() + 1;
        let first = epoch.0 + period * u32::try_from(ticks).expect("fewer than 2^32 ticks");
        let mut ticker = tokio::time::interval_at(first.into(), period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        ticker
    });
    let mut send_to_ack_ms = Vec::new();
    let mut sent_bytes = 0;
    let start = Instant::now();
    for seq in 0..batches {
        if let Some(ticker) = &mut ticker {
            ticker.tick().await;
        }
        let batch = format!(r#"{{"seq":{seq},"rows":{rows}}}"#);
        sent_bytes += batch.len();
        let sent = Instant::now();
        channel
            .send(InvokeResponseBody::Json(batch))
            .map_err(|error| error.to_string())?;
        match rx.recv().await {
            Some(acked) if acked == seq => {}
            other => {
                return Err(format!(
                    "stream {id} waited for ack {seq} and got {other:?}"
                ));
            }
        }
        send_to_ack_ms.push(sent.elapsed().as_secs_f64() * 1000.0);
    }
    let elapsed = start.elapsed();
    acks.0.lock().expect("acks lock").remove(&id);

    Ok(StreamStats {
        batches,
        bytes: sent_bytes,
        elapsed_ms: elapsed.as_secs_f64() * 1000.0,
        send_to_ack_ms,
    })
}

/// A JSON array of rows shaped like Table rows, at least `bytes` long.
fn rows(bytes: usize) -> String {
    let mut rows = String::from("[");
    let mut i = 0;
    while rows.len() < bytes {
        if i > 0 {
            rows.push(',');
        }
        rows.push_str(&format!(
            r#"{{"uid":"{i:08x}-0000-4000-8000-000000000000","cells":["bench-{i:05}","1/1","Running","0","5m"]}}"#
        ));
        i += 1;
    }
    rows.push(']');
    rows
}

#[tauri::command]
fn ack(stream: u32, seq: u64, acks: State<'_, Acks>) -> Result<(), String> {
    let acks = acks.0.lock().expect("acks lock");
    let tx = acks
        .get(&stream)
        .ok_or_else(|| format!("ack {seq} for stream {stream}, which is not running"))?;
    tx.send(seq).map_err(|error| error.to_string())
}

#[tauri::command]
fn probe(source: String, probes: State<'_, Probes>) {
    count(&probes, source);
}

/// What the probe frame's requests without a body call: they carry no source, so the command stands for one.
#[tauri::command]
fn probe_without_body(probes: State<'_, Probes>) {
    count(&probes, "frame:no-body".to_owned());
}

/// The bench's isolation hook refuses this command, so a call that runs under isolation went past the hook.
#[tauri::command]
fn bypass(probes: State<'_, Probes>) {
    count(&probes, "bypass".to_owned());
}

fn count(probes: &Probes, source: String) {
    *probes
        .0
        .lock()
        .expect("probes lock")
        .entry(source)
        .or_default() += 1;
}

#[tauri::command]
fn report(
    results: serde_json::Value,
    mode: State<'_, Mode>,
    probes: State<'_, Probes>,
    app: AppHandle,
) {
    let probes = probes.0.lock().expect("probes lock").clone();
    let mut failures = Vec::new();

    if *mode == Mode::Frames {
        for (source, count) in probes
            .iter()
            .filter(|(source, _)| source.starts_with("frame:"))
        {
            failures.push(format!("a probe command ran {count} times as {source}"));
        }
        if probes.get("control") != Some(&1) {
            failures.push("the same-origin control frame did not run `probe` once".to_owned());
        }
        if probes.get("main") != Some(&1) {
            failures.push("the window did not run `probe` once".to_owned());
        }

        // Under isolation the hook refuses `bypass`, so only the payload-less call runs it.
        let (via_invoke, runs) = match app.config().app.security.pattern {
            PatternKind::Brownfield => ("answered", 2),
            PatternKind::Isolation { .. } => ("no answer", 1),
        };
        let bypass = &results["hookBypass"];
        if bypass["viaInvoke"] != via_invoke
            || bypass["viaPostMessage"] != "answered"
            || probes.get("bypass") != Some(&runs)
        {
            failures.push(format!(
                "the hook check expected invoke {via_invoke:?}, postMessage \"answered\" and {runs} runs of `bypass`, and got {bypass} with {:?} runs",
                probes.get("bypass")
            ));
        }
    }

    println!(
        "{}",
        json!({ "results": results, "probes": probes, "failures": failures })
    );
    for failure in &failures {
        eprintln!("FAILED: {failure}");
    }
    app.exit(i32::from(!failures.is_empty()));
}

#[tauri::command]
fn fail(message: String, app: AppHandle) {
    eprintln!("FAILED: the bench page threw: {message}");
    app.exit(1);
}

fn ext_protocol(path: &str) -> Response<Vec<u8>> {
    match path {
        "/probe.html" => Response::builder()
            .header(CONTENT_TYPE, "text/html")
            .body(PROBE_HTML.to_vec()),
        _ => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new()),
    }
    .expect("a static response is valid")
}

/// Never returns: the process exits with the code `report` or `fail` passes to `AppHandle::exit`.
pub fn run(context: tauri::Context) {
    let bench_mode = Mode::from_env().unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    tauri::Builder::default()
        .manage(bench_mode)
        .manage(Probes::default())
        .manage(Acks::default())
        .manage(Epoch(Instant::now()))
        .register_uri_scheme_protocol("twigo-ext", |_ctx, request| {
            ext_protocol(request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            mode,
            echo,
            stream,
            ack,
            probe,
            probe_without_body,
            bypass,
            report,
            fail
        ])
        .run(context)
        .expect("error while running the IPC bench");
}
