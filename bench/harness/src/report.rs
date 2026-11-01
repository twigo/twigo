//! The report of ARCHITECTURE 3.8's six metrics at 5k pods, from what the app's bench mode, the
//! process sampler and the churn generator wrote into one directory.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::churn::Summary as Churn;
use crate::process::Sample;
use crate::stats::{Spread, percentile};

const FIRST_PAINT_MS: f64 = 1000.0;
const CHANGE_P95_MS: f64 = 150.0;
const FPS: f64 = 60.0;
/// requestAnimationFrame jitters, so a scroll passes at 95 % of the target's frames.
const FPS_PASS: f64 = 57.0;
const SORT_P95_MS: f64 = 50.0;
const CORE_RSS_MB: f64 = 150.0;
const WEBVIEW_MB: f64 = 300.0;
const IDLE_CPU_PERCENT: f64 = 1.0;
const MB: f64 = 1_000_000.0;

/// What the app's webview driver measured (`apps/desktop/bench`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Webview {
    pub backend: String,
    pub rows: u32,
    pub changes_per_second: f64,
    pub refresh_ms: f64,
    pub first_paint: FirstPaint,
    pub scroll: Scroll,
    pub sort: Vec<SortSample>,
    pub changes: Changes,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstPaint {
    pub batch_to_paint_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scroll {
    pub seconds: f64,
    pub px_per_second: f64,
    pub frame_ms: Vec<f64>,
    pub blank_frames: u32,
}

#[derive(Deserialize)]
pub struct SortSample {
    pub column: String,
    pub descending: bool,
    pub ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub seconds: f64,
    pub ms: Vec<f64>,
    pub offscreen: u32,
    pub superseded: u32,
    pub timed_out: u32,
}

/// What the webview reported once the window was hidden.
#[derive(Deserialize)]
pub struct Hidden {
    pub visibility: String,
}

/// The run, from `bench/harness.sh`.
#[derive(Deserialize, Serialize)]
pub struct Run {
    pub date: String,
    pub machine: String,
    pub os: String,
    pub commit: String,
    pub build: String,
}

pub struct Inputs {
    pub run: Run,
    pub webview: Webview,
    pub memory: Vec<Sample>,
    pub idle: (Sample, Sample),
    pub hidden: Option<Hidden>,
    pub churn: Option<Churn>,
}

fn read<T: DeserializeOwned>(dir: &Path, name: &str) -> Result<T, String> {
    let path = dir.join(name);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_optional<T: DeserializeOwned>(dir: &Path, name: &str) -> Result<Option<T>, String> {
    if dir.join(name).exists() {
        read(dir, name).map(Some)
    } else {
        Ok(None)
    }
}

/// `memory-1.json`, `memory-2.json` and on, as many as the harness took.
fn read_memory(dir: &Path) -> Result<Vec<Sample>, String> {
    let mut samples = Vec::new();
    while let Some(sample) = read_optional(dir, &format!("memory-{}.json", samples.len() + 1))? {
        samples.push(sample);
    }
    if samples.is_empty() {
        return Err(format!("{}: no memory-1.json", dir.display()));
    }
    Ok(samples)
}

impl Inputs {
    pub fn read(dir: &Path) -> Result<Self, String> {
        Ok(Inputs {
            run: read(dir, "run.json")?,
            webview: read(dir, "webview.json")?,
            memory: read_memory(dir)?,
            idle: (read(dir, "idle-start.json")?, read(dir, "idle-end.json")?),
            hidden: read_optional(dir, "hidden.json")?,
            churn: read_optional(dir, "churn.json")?,
        })
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Pass,
    Fail,
    /// The real path does not exist before M1.
    NotMeasurableBeforeM1,
    /// Half of a metric, on the mock: shown, never judged against the target.
    MockHalf,
    /// The whole metric, measured on the mock, whose work is not Rust's: shown, never judged.
    OnMock,
}

impl Status {
    fn label(&self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Fail => "FAIL",
            Status::NotMeasurableBeforeM1 => "not measurable before M1",
            Status::MockHalf => "mock half, not judged",
            Status::OnMock => "on the mock, not judged before M1",
        }
    }
}

/// Judges a measurement against its target, unless the webview ran on the mock.
struct Judge {
    on_mock: bool,
}

impl Judge {
    fn status(&self, pass: bool) -> Status {
        match (self.on_mock, pass) {
            (true, _) => Status::OnMock,
            (false, true) => Status::Pass,
            (false, false) => Status::Fail,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Row {
    pub metric: String,
    pub value: Option<String>,
    pub target: String,
    pub status: Status,
    pub measured: String,
}

#[derive(Serialize)]
pub struct Report {
    pub run: Run,
    pub rows: Vec<Row>,
    pub churn: Option<Churn>,
}

impl Report {
    pub fn failed(&self) -> Vec<&str> {
        self.rows
            .iter()
            .filter(|row| row.status == Status::Fail)
            .map(|row| row.metric.as_str())
            .collect()
    }
}

/// CPU time of the app and its WebKit processes between two samples, as a share of one core.
/// A process that started in between counts whole; one that ended in between is lost.
pub fn cpu_percent(start: &Sample, end: &Sample) -> f64 {
    let before: HashMap<i32, u64> = std::iter::once(&start.app)
        .chain(&start.webkit)
        .map(|p| (p.pid, p.cpu_ns))
        .collect();
    let used: u64 = std::iter::once(&end.app)
        .chain(&end.webkit)
        .map(|p| {
            p.cpu_ns
                .saturating_sub(before.get(&p.pid).copied().unwrap_or(0))
        })
        .sum();
    used as f64 / ((end.at_ms - start.at_ms) * 1e6) * 100.0
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / MB
}

fn median_mb(samples: &[Sample], bytes: impl Fn(&Sample) -> u64) -> f64 {
    let values: Vec<f64> = samples.iter().map(|s| mb(bytes(s))).collect();
    percentile(&values, 50.0).unwrap_or(0.0)
}

pub fn fps(frame_ms: &[f64]) -> f64 {
    1000.0 * frame_ms.len() as f64 / frame_ms.iter().sum::<f64>()
}

fn spread_text(spread: &Spread) -> String {
    format!(
        "p50 {:.1} ms, max {:.1} ms, n = {}",
        spread.p50, spread.max, spread.n
    )
}

pub fn build(inputs: Inputs) -> Report {
    let Inputs {
        run,
        webview,
        memory,
        idle,
        hidden,
        churn,
    } = inputs;
    let on_mock = format!(
        "{} rows from the {} backend, in the webview",
        webview.rows, webview.backend
    );
    let judge = Judge {
        on_mock: webview.backend == "mock",
    };
    let mut rows = Vec::new();

    rows.push(Row {
        metric: "First paint after the space connects".into(),
        value: None,
        target: format!("< {:.0} s", FIRST_PAINT_MS / 1000.0),
        status: Status::NotMeasurableBeforeM1,
        measured: "needs the Rust list path: watch hub, row store, query view and batcher (M1)"
            .into(),
    });
    rows.push(Row {
        metric: "  webview half".into(),
        value: Some(format!("{:.1} ms", webview.first_paint.batch_to_paint_ms)),
        target: "-".into(),
        status: Status::MockHalf,
        measured: format!("first batch with rows received → rows painted; {on_mock}"),
    });

    let changes = Spread::of(&webview.changes.ms);
    rows.push(Row {
        metric: "Change → painted cell, p95".into(),
        value: None,
        target: format!("< {CHANGE_P95_MS:.0} ms"),
        status: Status::NotMeasurableBeforeM1,
        measured: "needs the cluster's changes to reach the webview through Rust (M1)".into(),
    });
    rows.push(Row {
        metric: "  webview half".into(),
        value: changes.as_ref().map(|s| format!("{:.1} ms", s.p95)),
        target: "-".into(),
        status: Status::MockHalf,
        measured: format!(
            "batch received → changed cell painted, on screen; {}; {} offscreen, {} superseded, {} timed out; {:.0} changes/s for {:.0} s; {on_mock}",
            changes.as_ref().map_or("no samples".into(), spread_text),
            webview.changes.offscreen,
            webview.changes.superseded,
            webview.changes.timed_out,
            webview.changes_per_second,
            webview.changes.seconds,
        ),
    });

    let scroll_fps = fps(&webview.scroll.frame_ms);
    let frame_p95 = percentile(&webview.scroll.frame_ms, 95.0).unwrap_or(f64::NAN);
    rows.push(Row {
        metric: "Scroll and sort: scroll".into(),
        value: Some(format!("{scroll_fps:.1} fps")),
        target: format!("{FPS:.0} fps"),
        status: judge.status(scroll_fps >= FPS_PASS),
        measured: format!(
            "requestAnimationFrame over {:.0} s of programmatic scroll at {:.0} px/s; frame p95 {frame_p95:.1} ms, display frame {:.1} ms; rows awaiting data in {} of {} frames; {on_mock}, which serves each window from JS and reruns the query over every pod on each churn tick, on the webview's main thread",
            webview.scroll.seconds,
            webview.scroll.px_per_second,
            webview.refresh_ms,
            webview.scroll.blank_frames,
            webview.scroll.frame_ms.len(),
        ),
    });

    let sorts: Vec<f64> = webview.sort.iter().map(|s| s.ms).collect();
    let sort = Spread::of(&sorts);
    let columns: Vec<String> = webview
        .sort
        .iter()
        .map(|s| format!("{}{}", s.column, if s.descending { "↓" } else { "↑" }))
        .collect();
    rows.push(Row {
        metric: "Scroll and sort: sort".into(),
        value: sort.as_ref().map(|s| format!("p95 {:.1} ms", s.p95)),
        target: format!("< {SORT_P95_MS:.0} ms"),
        status: judge.status(sort.as_ref().is_some_and(|s| s.p95 < SORT_P95_MS)),
        measured: format!(
            "header click → resorted rows painted, {}; {}; {on_mock}, which sorts every pod in JS on the webview's main thread, unlike Rust's incremental index",
            columns.join(" "),
            sort.as_ref().map_or("no samples".into(), spread_text),
        ),
    });

    let first = &memory[0];
    let core = median_mb(&memory, |s| s.app.rss);
    rows.push(Row {
        metric: "Core RSS with the pod list open".into(),
        value: Some(format!("{core:.0} MB")),
        target: format!("< {CORE_RSS_MB:.0} MB"),
        status: judge.status(core < CORE_RSS_MB),
        measured: format!(
            "resident size of {} (pid {}) under churn, the median of {} samples; M0's core holds no watch cache yet, and the list lives in the webview's mock",
            first.app.name,
            first.app.pid,
            memory.len()
        ),
    });

    let webkit = median_mb(&memory, |s| s.webkit.iter().map(|p| p.footprint).sum());
    let webkit_rss = median_mb(&memory, |s| s.webkit.iter().map(|p| p.rss).sum());
    let names: Vec<String> = first
        .webkit
        .iter()
        .map(|p| {
            let footprint = median_mb(&memory, |s| {
                s.webkit
                    .iter()
                    .filter(|q| q.name == p.name)
                    .map(|q| q.footprint)
                    .sum()
            });
            format!(
                "{} {footprint:.0} MB",
                p.name.trim_start_matches(crate::process::WEBKIT_PREFIX),
            )
        })
        .collect();
    rows.push(Row {
        metric: "Webview memory with the pod list open".into(),
        value: Some(format!("{webkit:.0} MB")),
        target: format!("< {WEBVIEW_MB:.0} MB"),
        status: judge.status(webkit < WEBVIEW_MB),
        measured: format!(
            "physical footprint of the WebKit processes the app is responsible for ({}), under churn, the median of {} samples; their RSS adds up to {webkit_rss:.0} MB; {} other WebKit processes left out; the webview holds the mock's {} pods, which Rust holds from M1",
            names.join(", "),
            memory.len(),
            first.other_webkit.len(),
            webview.rows,
        ),
    });

    let (start, end) = &idle;
    let cpu = cpu_percent(start, end);
    rows.push(Row {
        metric: "Idle CPU, 100 changes/s, window hidden".into(),
        value: Some(format!("{cpu:.2} %")),
        target: format!("< {IDLE_CPU_PERCENT:.0} %"),
        status: judge.status(cpu < IDLE_CPU_PERCENT),
        measured: format!(
            "CPU time of the app and its {} WebKit processes over {:.0} s, as a share of one core; document {}; hidden, the webview stops acknowledging batches, so this counts the mock's {:.0} changes/s timer in the webview, and the cluster's churn reaches nothing before M1",
            end.webkit.len(),
            (end.at_ms - start.at_ms) / 1000.0,
            hidden.map_or("visibility not reported".into(), |h| h.visibility),
            webview.changes_per_second,
        ),
    });

    Report { run, rows, churn }
}

pub fn table(report: &Report) -> String {
    let mut out = String::new();
    let run = &report.run;
    let _ = writeln!(
        out,
        "{}, {}, {}, {} build, {}",
        run.date, run.machine, run.os, run.build, run.commit
    );
    if let Some(churn) = &report.churn {
        let _ = writeln!(
            out,
            "Churn on kwok: {:.1} changes/s over {} pods for {:.0} s, {} errors{}",
            churn.changes_per_second,
            churn.pods,
            churn.seconds,
            churn.errors,
            churn
                .latency_ms
                .as_ref()
                .map_or(String::new(), |s| format!(", patch p95 {:.1} ms", s.p95)),
        );
    }
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "| Metric | Value | Target | Status | What it measured |"
    );
    let _ = writeln!(out, "| --- | --- | --- | --- | --- |");
    for row in &report.rows {
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} |",
            row.metric,
            row.value.as_deref().unwrap_or("-"),
            row.target,
            row.status.label(),
            row.measured
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::Process;

    fn process(pid: i32, name: &str, rss: u64, footprint: u64, cpu_ns: u64) -> Process {
        Process {
            pid,
            responsible: 700,
            name: name.to_owned(),
            rss,
            footprint,
            cpu_ns,
        }
    }

    fn sample(at_ms: f64, app_cpu: u64, webkit: Vec<Process>) -> Sample {
        Sample {
            at_ms,
            app: process(700, "twigo", 90 * 1_000_000, 80 * 1_000_000, app_cpu),
            webkit,
            other_webkit: vec![process(501, "com.apple.WebKit.Networking", 1, 1, 1)],
        }
    }

    fn inputs(backend: &str, sort_ms: f64, frame_ms: f64, idle_ns: u64) -> Inputs {
        let webkit = |cpu| {
            vec![
                process(
                    701,
                    "com.apple.WebKit.WebContent",
                    200_000_000,
                    150_000_000,
                    cpu,
                ),
                process(
                    702,
                    "com.apple.WebKit.Networking",
                    20_000_000,
                    10_000_000,
                    cpu,
                ),
            ]
        };
        Inputs {
            run: Run {
                date: "2026-11-01".into(),
                machine: "Apple M4 Max".into(),
                os: "macOS 27.0".into(),
                commit: "abc".into(),
                build: "release".into(),
            },
            webview: Webview {
                backend: backend.into(),
                rows: 5000,
                changes_per_second: 100.0,
                refresh_ms: 16.7,
                first_paint: FirstPaint {
                    batch_to_paint_ms: 20.0,
                },
                scroll: Scroll {
                    seconds: 5.0,
                    px_per_second: 4000.0,
                    frame_ms: vec![frame_ms; 300],
                    blank_frames: 0,
                },
                sort: vec![SortSample {
                    column: "Name".into(),
                    descending: false,
                    ms: sort_ms,
                }],
                changes: Changes {
                    seconds: 60.0,
                    ms: vec![10.0, 20.0],
                    offscreen: 0,
                    superseded: 0,
                    timed_out: 0,
                },
            },
            memory: vec![sample(0.0, 0, webkit(0))],
            idle: (
                sample(0.0, 1_000, webkit(1_000)),
                sample(10_000.0, 1_000 + idle_ns, webkit(1_000)),
            ),
            hidden: Some(Hidden {
                visibility: "hidden".into(),
            }),
            churn: None,
        }
    }

    fn statuses(report: &Report) -> Vec<(&str, &Status)> {
        report
            .rows
            .iter()
            .map(|row| (row.metric.as_str(), &row.status))
            .collect()
    }

    #[test]
    fn every_metric_has_a_row_and_none_measured_on_the_mock_is_judged() {
        let report = build(inputs("mock", 80.0, 20.0, 200_000_000));
        assert_eq!(
            statuses(&report),
            [
                (
                    "First paint after the space connects",
                    &Status::NotMeasurableBeforeM1
                ),
                ("  webview half", &Status::MockHalf),
                ("Change → painted cell, p95", &Status::NotMeasurableBeforeM1),
                ("  webview half", &Status::MockHalf),
                ("Scroll and sort: scroll", &Status::OnMock),
                ("Scroll and sort: sort", &Status::OnMock),
                ("Core RSS with the pod list open", &Status::OnMock),
                ("Webview memory with the pod list open", &Status::OnMock),
                ("Idle CPU, 100 changes/s, window hidden", &Status::OnMock),
            ]
        );
        assert!(report.rows[0].value.is_none());
        assert!(report.rows[2].value.is_none());
        assert_eq!(report.rows[7].value.as_deref(), Some("160 MB"));
        assert_eq!(report.rows[8].value.as_deref(), Some("2.00 %"));
        assert!(report.failed().is_empty());
    }

    #[test]
    fn off_the_mock_slow_sorts_dropped_frames_and_a_busy_idle_fail() {
        let report = build(inputs("tauri", 80.0, 20.0, 200_000_000));
        assert_eq!(
            report.failed(),
            [
                "Scroll and sort: scroll",
                "Scroll and sort: sort",
                "Idle CPU, 100 changes/s, window hidden"
            ]
        );
    }

    #[test]
    fn memory_is_the_median_of_its_samples() {
        let mut all = inputs("mock", 20.0, 16.7, 1_000_000);
        all.memory = [(100, 300), (500, 100), (200, 200)]
            .into_iter()
            .map(|(content, core)| {
                let mut s = sample(
                    0.0,
                    0,
                    vec![
                        process(
                            701,
                            "com.apple.WebKit.WebContent",
                            1,
                            content * 1_000_000,
                            0,
                        ),
                        process(702, "com.apple.WebKit.GPU", 1, 10 * 1_000_000, 0),
                    ],
                );
                s.app.rss = core * 1_000_000;
                s
            })
            .collect();
        let report = build(all);
        assert_eq!(report.rows[6].value.as_deref(), Some("200 MB"));
        assert_eq!(report.rows[7].value.as_deref(), Some("210 MB"));
        assert!(
            report.rows[7]
                .measured
                .contains("WebContent 200 MB, GPU 10 MB"),
            "{}",
            report.rows[7].measured
        );
    }

    #[test]
    fn cpu_counts_a_process_that_started_in_between_whole() {
        let start = sample(0.0, 0, vec![]);
        let end = sample(
            1_000.0,
            5_000_000,
            vec![process(701, "com.apple.WebKit.WebContent", 1, 1, 5_000_000)],
        );
        assert!((cpu_percent(&start, &end) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn the_table_lists_every_row() {
        let report = build(inputs("mock", 30.0, 16.7, 0));
        let table = table(&report);
        assert_eq!(table.lines().filter(|l| l.starts_with("| ")).count(), 11);
        assert!(table.contains(
            "| First paint after the space connects | - | < 1 s | not measurable before M1 |"
        ));
    }
}
