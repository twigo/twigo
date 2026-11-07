//! The report of ARCHITECTURE 3.8's seven metrics at 5k pods, from what the app's bench mode, the
//! process sampler and the churn generator wrote into one directory.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::churn::Summary as Churn;
use crate::process::{Process, Sample};
use crate::stats::{Spread, percentile};

const FIRST_PAINT_MS: f64 = 1000.0;
const CHANGE_P95_MS: f64 = 150.0;
const FPS: f64 = 60.0;
/// requestAnimationFrame jitters, so a scroll passes at 95 % of the target's frames.
const FPS_PASS: f64 = 57.0;
const SORT_P95_MS: f64 = 50.0;
const CORE_RSS_MB: f64 = 150.0;
const WEBVIEW_MB: f64 = 300.0;
const IDLE_CPU_PERCENT: f64 = 2.0;
const VISIBLE_CPU_PERCENT: f64 = 20.0;
const MB: f64 = 1_000_000.0;
const GPU_PROCESS: &str = "com.apple.WebKit.GPU";

/// What the app's webview driver measured (`apps/desktop/bench`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Webview {
    pub rows: u32,
    pub refresh_ms: f64,
    pub first_paint_ms: f64,
    pub scroll: Scroll,
    pub sort: Vec<SortSample>,
    pub changes: Changes,
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
    pub painted: Vec<Paint>,
    pub offscreen: u32,
    pub superseded: u32,
    pub timed_out: u32,
}

/// A restart count painted, in Unix milliseconds.
#[derive(Deserialize)]
pub struct Paint {
    pub pod: String,
    pub restarts: i32,
    pub at: f64,
}

/// A line of the churn's log: a count it set, and when it sent the patch,
/// in Unix milliseconds.
#[derive(Deserialize)]
pub struct Logged {
    pub pod: String,
    pub restarts: i32,
    pub sent: f64,
    #[serde(default)]
    pub error: Option<String>,
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
    pub visible: (Sample, Sample),
    pub idle: (Sample, Sample),
    pub hidden: Option<Hidden>,
    pub churn: Option<Churn>,
    pub log: Vec<Logged>,
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

/// `churn.jsonl`, one change a line.
fn read_log(dir: &Path) -> Result<Vec<Logged>, String> {
    let path = dir.join("churn.jsonl");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    text.lines()
        .map(|line| serde_json::from_str(line).map_err(|e| format!("{}: {e}", path.display())))
        .collect()
}

impl Inputs {
    pub fn read(dir: &Path) -> Result<Self, String> {
        Ok(Inputs {
            run: read(dir, "run.json")?,
            webview: read(dir, "webview.json")?,
            memory: read_memory(dir)?,
            visible: (
                read(dir, "visible-start.json")?,
                read(dir, "visible-end.json")?,
            ),
            idle: (read(dir, "idle-start.json")?, read(dir, "idle-end.json")?),
            hidden: read_optional(dir, "hidden.json")?,
            churn: read_optional(dir, "churn.json")?,
            log: read_log(dir)?,
        })
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Pass,
    Fail,
    /// Shown beside a metric, never judged.
    Shown,
}

impl Status {
    fn judged(pass: bool) -> Self {
        if pass { Status::Pass } else { Status::Fail }
    }

    fn label(&self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Fail => "FAIL",
            Status::Shown => "shown, not judged",
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

fn is_gpu(process: &Process) -> bool {
    process.name == GPU_PROCESS
}

fn median_mb(samples: &[Sample], bytes: impl Fn(&Sample) -> u64) -> f64 {
    let values: Vec<f64> = samples.iter().map(|s| mb(bytes(s))).collect();
    percentile(&values, 50.0).unwrap_or(0.0)
}

pub fn fps(frame_ms: &[f64]) -> f64 {
    1000.0 * frame_ms.len() as f64 / frame_ms.iter().sum::<f64>()
}

/// Each painted count's latency from the patch that set it, joined by pod
/// and count, and how many paints the log lacks.
pub fn change_latencies(painted: &[Paint], log: &[Logged]) -> (Vec<f64>, usize) {
    let sent: HashMap<(&str, i32), f64> = log
        .iter()
        .filter(|line| line.error.is_none())
        .map(|line| ((line.pod.as_str(), line.restarts), line.sent))
        .collect();
    let mut latencies = Vec::new();
    let mut unjoined = 0;
    for paint in painted {
        match sent.get(&(paint.pod.as_str(), paint.restarts)) {
            Some(sent) => latencies.push(paint.at - sent),
            None => unjoined += 1,
        }
    }
    (latencies, unjoined)
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
        visible,
        idle,
        hidden,
        churn,
        log,
    } = inputs;
    let mut rows = Vec::new();

    rows.push(Row {
        metric: "First paint after the space connects".into(),
        value: Some(format!("{:.0} ms", webview.first_paint_ms)),
        target: format!("< {:.0} s", FIRST_PAINT_MS / 1000.0),
        status: Status::judged(webview.first_paint_ms < FIRST_PAINT_MS),
        measured: format!(
            "the pod list opened in the bench's space → its first rows painted: what remains of the space's discovery, which starts as the space opens, and the list of {} pods",
            webview.rows
        ),
    });

    let (latencies, unjoined) = change_latencies(&webview.changes.painted, &log);
    let changes = Spread::of(&latencies);
    rows.push(Row {
        metric: "Change → painted cell, p95".into(),
        value: changes.as_ref().map(|s| format!("{:.1} ms", s.p95)),
        target: format!("< {CHANGE_P95_MS:.0} ms"),
        status: Status::judged(changes.as_ref().is_some_and(|s| s.p95 < CHANGE_P95_MS)),
        measured: format!(
            "the churn's patch sent → the new Restarts count painted, for rows on screen over {:.0} s, joined by pod and count through Unix ms; {}; {unjoined} paints not in the churn's log; {} offscreen, {} superseded, {} timed out",
            webview.changes.seconds,
            changes.as_ref().map_or("no samples".into(), spread_text),
            webview.changes.offscreen,
            webview.changes.superseded,
            webview.changes.timed_out,
        ),
    });

    let scroll_fps = fps(&webview.scroll.frame_ms);
    let frame_p95 = percentile(&webview.scroll.frame_ms, 95.0).unwrap_or(f64::NAN);
    rows.push(Row {
        metric: "Scroll and sort: scroll".into(),
        value: Some(format!("{scroll_fps:.1} fps")),
        target: format!("{FPS:.0} fps"),
        status: Status::judged(scroll_fps >= FPS_PASS),
        measured: format!(
            "requestAnimationFrame over {:.0} s of programmatic scroll at {:.0} px/s; frame p95 {frame_p95:.1} ms, display frame {:.1} ms; rows awaiting data in {} of {} frames",
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
        status: Status::judged(sort.as_ref().is_some_and(|s| s.p95 < SORT_P95_MS)),
        measured: format!(
            "header click → resorted rows painted, {}; {}",
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
        status: Status::judged(core < CORE_RSS_MB),
        measured: format!(
            "resident size of {} (pid {}) under churn with the list open, its row store, query view and batcher included, the median of {} samples",
            first.app.name,
            first.app.pid,
            memory.len()
        ),
    });

    let budgeted = |s: &Sample, bytes: fn(&Process) -> u64| -> u64 {
        s.webkit.iter().filter(|p| !is_gpu(p)).map(bytes).sum()
    };
    let webkit_rss = median_mb(&memory, |s| budgeted(s, |p| p.rss));
    let webkit_footprint = median_mb(&memory, |s| budgeted(s, |p| p.footprint));
    let per_process = |bytes: fn(&Process) -> u64| -> Vec<String> {
        first
            .webkit
            .iter()
            .filter(|p| !is_gpu(p))
            .map(|p| {
                let value = median_mb(&memory, |s| {
                    s.webkit
                        .iter()
                        .filter(|q| q.name == p.name)
                        .map(bytes)
                        .sum()
                });
                format!(
                    "{} {value:.0} MB",
                    p.name.trim_start_matches(crate::process::WEBKIT_PREFIX),
                )
            })
            .collect()
    };
    rows.push(Row {
        metric: "Webview memory with the pod list open".into(),
        value: Some(format!("{webkit_rss:.0} MB")),
        target: format!("< {WEBVIEW_MB:.0} MB"),
        status: Status::judged(webkit_rss < WEBVIEW_MB),
        measured: format!(
            "resident size of the WebKit processes the app is responsible for but the GPU process ({}), under churn, the median of {} samples; {} other WebKit processes left out",
            per_process(|p| p.rss).join(", "),
            memory.len(),
            first.other_webkit.len(),
        ),
    });
    rows.push(Row {
        metric: "  Physical footprint".into(),
        value: Some(format!("{webkit_footprint:.0} MB")),
        target: "-".into(),
        status: Status::Shown,
        measured: format!(
            "the same processes' physical footprint ({}), the median of {} samples; it leaves out pages WebKit reused and counts graphics that resident size does not, so it swings between runs (docs/bench.md)",
            per_process(|p| p.footprint).join(", "),
            memory.len(),
        ),
    });

    let gpu = median_mb(&memory, |s| {
        s.webkit
            .iter()
            .filter(|p| is_gpu(p))
            .map(|p| p.footprint)
            .sum()
    });
    rows.push(Row {
        metric: "  GPU process".into(),
        value: Some(format!("{gpu:.0} MB")),
        target: "-".into(),
        status: Status::Shown,
        measured: format!(
            "physical footprint of the app's WebKit GPU process, the median of {} samples; any page that repaints holds about 260 MB there, WebKit's pool of IOSurfaces, so it stays out of the budget (docs/bench.md)",
            memory.len()
        ),
    });

    let (start, end) = &visible;
    let cpu = cpu_percent(start, end);
    rows.push(Row {
        metric: "Visible CPU, 100 changes/s, window on screen".into(),
        value: Some(format!("{cpu:.2} %")),
        target: format!("< {VISIBLE_CPU_PERCENT:.0} %"),
        status: Status::judged(cpu < VISIBLE_CPU_PERCENT),
        measured: format!(
            "CPU time of the app and its {} WebKit processes over {:.0} s, as a share of one core; sorted by Restarts descending, the rows the churn changes on screen, while the driver sleeps",
            end.webkit.len(),
            (end.at_ms - start.at_ms) / 1000.0,
        ),
    });

    let (start, end) = &idle;
    let cpu = cpu_percent(start, end);
    rows.push(Row {
        metric: "Idle CPU, 100 changes/s, window hidden".into(),
        value: Some(format!("{cpu:.2} %")),
        target: format!("< {IDLE_CPU_PERCENT:.0} %"),
        status: Status::judged(cpu < IDLE_CPU_PERCENT),
        measured: format!(
            "CPU time of the app and its {} WebKit processes over {:.0} s, as a share of one core; document {}; hidden, the webview acknowledges no batch, so Rust coalesces the churn and sends nothing",
            end.webkit.len(),
            (end.at_ms - start.at_ms) / 1000.0,
            hidden.map_or("visibility not reported".into(), |h| h.visibility),
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

    fn inputs(sort_ms: f64, frame_ms: f64, idle_ns: u64) -> Inputs {
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
                process(703, "com.apple.WebKit.GPU", 30_000_000, 500_000_000, cpu),
            ]
        };
        let logged = |pod: &str, restarts, sent| Logged {
            pod: pod.into(),
            restarts,
            sent,
            error: None,
        };
        let paint = |pod: &str, restarts, at| Paint {
            pod: pod.into(),
            restarts,
            at,
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
                rows: 5000,
                refresh_ms: 16.7,
                first_paint_ms: 400.0,
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
                    painted: vec![
                        paint("bench-a", 1, 1_000.0),
                        paint("bench-a", 2, 1_100.0),
                        paint("bench-b", 1, 2_000.0),
                        paint("bench-c", 1, 3_000.0),
                    ],
                    offscreen: 0,
                    superseded: 0,
                    timed_out: 0,
                },
            },
            memory: vec![sample(0.0, 0, webkit(0))],
            visible: (sample(0.0, 0, webkit(0)), sample(10_000.0, 0, webkit(0))),
            idle: (
                sample(0.0, 1_000, webkit(1_000)),
                sample(10_000.0, 1_000 + idle_ns, webkit(1_000)),
            ),
            hidden: Some(Hidden {
                visibility: "hidden".into(),
            }),
            churn: None,
            log: vec![
                logged("bench-a", 1, 980.0),
                logged("bench-a", 2, 1_040.0),
                logged("bench-b", 1, 1_990.0),
                Logged {
                    error: Some("timed out".into()),
                    ..logged("bench-c", 1, 0.0)
                },
            ],
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
    fn every_metric_has_a_row_and_is_judged() {
        let report = build(inputs(20.0, 16.7, 1_000_000));
        assert_eq!(
            statuses(&report),
            [
                ("First paint after the space connects", &Status::Pass),
                ("Change → painted cell, p95", &Status::Pass),
                ("Scroll and sort: scroll", &Status::Pass),
                ("Scroll and sort: sort", &Status::Pass),
                ("Core RSS with the pod list open", &Status::Pass),
                ("Webview memory with the pod list open", &Status::Pass),
                ("  Physical footprint", &Status::Shown),
                ("  GPU process", &Status::Shown),
                (
                    "Visible CPU, 100 changes/s, window on screen",
                    &Status::Pass
                ),
                ("Idle CPU, 100 changes/s, window hidden", &Status::Pass),
            ]
        );
        assert_eq!(report.rows[0].value.as_deref(), Some("400 ms"));
        assert_eq!(report.rows[5].value.as_deref(), Some("220 MB"));
        assert_eq!(report.rows[6].value.as_deref(), Some("160 MB"));
        assert_eq!(report.rows[7].value.as_deref(), Some("500 MB"));
        assert_eq!(report.rows[9].value.as_deref(), Some("0.01 %"));
    }

    #[test]
    fn paints_join_the_churn_log_by_pod_and_count() {
        let inputs = inputs(20.0, 16.7, 0);
        let (latencies, unjoined) = change_latencies(&inputs.webview.changes.painted, &inputs.log);
        assert_eq!(latencies, [20.0, 60.0, 10.0]);
        assert_eq!(unjoined, 1, "a patch that failed sets no count");
        let report = build(inputs);
        assert!(
            report.rows[1]
                .measured
                .contains("1 paints not in the churn's log"),
            "{}",
            report.rows[1].measured
        );
    }

    #[test]
    fn slow_paints_sorts_dropped_frames_and_a_busy_idle_fail() {
        let mut slow = inputs(80.0, 20.0, 300_000_000);
        slow.webview.first_paint_ms = 1_500.0;
        slow.log[0].sent = 0.0;
        slow.log[1].sent = 0.0;
        slow.log[2].sent = 0.0;
        assert_eq!(
            build(slow).failed(),
            [
                "First paint after the space connects",
                "Change → painted cell, p95",
                "Scroll and sort: scroll",
                "Scroll and sort: sort",
                "Idle CPU, 100 changes/s, window hidden"
            ]
        );
    }

    #[test]
    fn no_paint_to_join_fails_the_change_row() {
        let mut none = inputs(20.0, 16.7, 0);
        none.log.clear();
        let report = build(none);
        assert_eq!(report.rows[1].status, Status::Fail);
        assert!(report.rows[1].measured.contains("no samples"));
    }

    #[test]
    fn memory_is_the_median_of_its_samples() {
        let mut all = inputs(20.0, 16.7, 1_000_000);
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
                            content * 1_000_000,
                            content * 2_000_000,
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
        assert_eq!(report.rows[4].value.as_deref(), Some("200 MB"));
        assert_eq!(report.rows[5].value.as_deref(), Some("200 MB"));
        assert_eq!(report.rows[6].value.as_deref(), Some("400 MB"));
        assert_eq!(report.rows[7].value.as_deref(), Some("10 MB"));
        assert!(
            report.rows[5].measured.contains("(WebContent 200 MB)"),
            "{}",
            report.rows[5].measured
        );
        assert!(
            report.rows[6].measured.contains("(WebContent 400 MB)"),
            "{}",
            report.rows[6].measured
        );
    }

    fn with_webcontent(rss: u64, footprint: u64) -> Inputs {
        let mut all = inputs(20.0, 16.7, 1_000_000);
        all.memory = vec![sample(
            0.0,
            0,
            vec![process(
                701,
                "com.apple.WebKit.WebContent",
                rss * 1_000_000,
                footprint * 1_000_000,
                0,
            )],
        )];
        all
    }

    #[test]
    fn webview_memory_is_judged_by_resident_size_and_not_by_footprint() {
        assert!(build(with_webcontent(250, 900)).failed().is_empty());
        assert_eq!(
            build(with_webcontent(350, 100)).failed(),
            ["Webview memory with the pod list open"]
        );
    }

    #[test]
    fn idle_cpu_is_judged_at_two_percent() {
        assert!(build(inputs(20.0, 16.7, 150_000_000)).failed().is_empty());
        assert_eq!(
            build(inputs(20.0, 16.7, 250_000_000)).failed(),
            ["Idle CPU, 100 changes/s, window hidden"]
        );
    }

    #[test]
    fn visible_cpu_is_judged_at_twenty_percent() {
        let busy = |ns: u64| {
            let mut all = inputs(20.0, 16.7, 0);
            all.visible = (sample(0.0, 0, vec![]), sample(10_000.0, ns, vec![]));
            all
        };
        assert!(build(busy(1_900_000_000)).failed().is_empty());
        assert_eq!(
            build(busy(2_100_000_000)).failed(),
            ["Visible CPU, 100 changes/s, window on screen"]
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
        let report = build(inputs(30.0, 16.7, 0));
        let table = table(&report);
        assert_eq!(table.lines().filter(|l| l.starts_with("| ")).count(), 12);
        assert!(table.contains("| First paint after the space connects | 400 ms | < 1 s | pass |"));
    }
}
