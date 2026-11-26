//! What M2's sessions add to the report (ARCHITECTURE 3.8): the app with a shell, a port-forward
//! and a terminal open, the terminal watching the cluster's pods through the policy proxy and
//! straight to the cluster, and the gate's share of the core's CPU. Every row is shown and none
//! is judged.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

use crate::process::{Process, Sample};
use crate::report::{Hidden, Row, Status, cpu_percent, read, read_optional};
use crate::stats::percentile;

const MB: f64 = 1_000_000.0;
const GPU_PROCESS: &str = "com.apple.WebKit.GPU";
/// How often the app polls the metrics API, which the API server does not count
/// (`twigo_cache::metrics::INTERVAL`).
const POLL_SECONDS: f64 = 15.0;

/// What the driver wrote once its three sessions were open (`sessions.json`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub shell: OpenedShell,
    pub forward: OpenedForward,
    pub terminal: OpenedTerminal,
}

#[derive(Deserialize)]
pub struct OpenedShell {
    pub pod: String,
    /// What the dialog the shell asked in said.
    pub question: String,
}

#[derive(Deserialize)]
pub struct OpenedForward {
    pub target: String,
    pub port: u16,
    pub local: u16,
}

#[derive(Deserialize)]
pub struct OpenedTerminal {
    /// How it reaches clusters: `proxy` or `kubeconfig`.
    pub kind: String,
    pub shell: String,
}

/// The harness's one read through the forward's local port (`forward-read.json`).
#[derive(Deserialize)]
pub struct ForwardRead {
    pub status: u16,
    pub bytes: u64,
}

/// How the terminal reaches the cluster: the policy proxy's kubeconfig, which it has, or the
/// cluster's own, named on the command line.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Proxy,
    Direct,
}

/// What the driver says when a watch window starts (`watch-N.json`) and ends (`watched-N.json`):
/// the bytes the terminal had received by then.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    via: Via,
    bytes: u64,
    at_ms: f64,
}

/// A window of the harness's CPU samples in which the terminal ran `kubectl get pods -A -w`.
pub struct Window {
    pub via: Via,
    pub start: Sample,
    pub end: Sample,
    /// What the terminal received over the driver's window.
    pub received: u64,
    pub seconds: f64,
}

/// What `gate_cost` measured (`twigo-policy`'s example).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateCost {
    pub classes: Vec<GateClass>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateClass {
    pub method: String,
    /// In a hot loop.
    pub gate_ns: f64,
    /// With the caches evicted before each call.
    pub cold_gate_ns: f64,
}

/// What the sessions' rows are built from, or why they cannot be: a step of the run that failed
/// leaves its files missing, and the judged rows are reported all the same.
pub struct Inputs {
    pub sessions: Result<Sessions, String>,
    pub gate: Result<GateInputs, String>,
}

pub struct Sessions {
    pub opened: Opened,
    pub forward_read: ForwardRead,
    pub memory: Vec<Sample>,
    pub visible: (Sample, Sample),
    pub windows: Vec<Window>,
    pub idle: (Sample, Sample),
    pub hidden: Option<Hidden>,
}

pub struct GateInputs {
    /// The core's CPU over the steady phase, and what the API server counted at its two ends.
    pub steady: (Sample, Sample),
    pub apiserver: (String, String),
    pub cost: GateCost,
}

/// Why the run stopped (`failure.json`), written by the driver or the harness.
#[derive(Deserialize)]
struct Failure {
    message: String,
}

/// `<prefix>1.json`, `<prefix>2.json` and on, as many as the harness took.
fn numbered<T: serde::de::DeserializeOwned>(dir: &Path, name: &str) -> Result<Vec<T>, String> {
    let mut all = Vec::new();
    while let Some(next) = read_optional(dir, &name.replace('N', &(all.len() + 1).to_string()))? {
        all.push(next);
    }
    Ok(all)
}

fn text(dir: &Path, name: &str) -> Result<String, String> {
    std::fs::read_to_string(dir.join(name)).map_err(|e| format!("{name}: {e}"))
}

impl Inputs {
    pub fn read(dir: &Path) -> Self {
        let stopped = read_optional::<Failure>(dir, "failure.json")
            .map(|failure| failure.map(|failure| failure.message))
            .unwrap_or_else(Some);
        Inputs {
            sessions: Sessions::read(dir).map_err(|missing| {
                stopped.map_or(missing, |message| format!("the run stopped: {message}"))
            }),
            gate: GateInputs::read(dir),
        }
    }
}

impl Sessions {
    fn read(dir: &Path) -> Result<Self, String> {
        let memory = numbered(dir, "sessions-memory-N.json")?;
        if memory.is_empty() {
            return Err("no sessions-memory-1.json".to_owned());
        }
        let starts: Vec<Marker> = numbered(dir, "watch-N.json")?;
        let ends: Vec<Marker> = numbered(dir, "watched-N.json")?;
        let samples: Vec<(Sample, Sample)> = numbered::<Sample>(dir, "window-N-start.json")?
            .into_iter()
            .zip(numbered::<Sample>(dir, "window-N-end.json")?)
            .collect();
        if starts.is_empty() || starts.len() != ends.len() || starts.len() != samples.len() {
            return Err(format!(
                "{} watch markers, {} ends and {} sampled windows, which must be as many and not none",
                starts.len(),
                ends.len(),
                samples.len()
            ));
        }
        let windows = starts
            .into_iter()
            .zip(ends)
            .zip(samples)
            .map(|((start, end), (sample_start, sample_end))| Window {
                via: start.via,
                start: sample_start,
                end: sample_end,
                received: end.bytes.saturating_sub(start.bytes),
                seconds: (end.at_ms - start.at_ms) / 1000.0,
            })
            .collect();
        Ok(Sessions {
            opened: read(dir, "sessions.json")?,
            forward_read: read(dir, "forward-read.json")?,
            memory,
            visible: (
                read(dir, "sessions-visible-start.json")?,
                read(dir, "sessions-visible-end.json")?,
            ),
            windows,
            idle: (
                read(dir, "idle-sessions-start.json")?,
                read(dir, "idle-sessions-end.json")?,
            ),
            hidden: read_optional(dir, "hidden-sessions.json")?,
        })
    }
}

impl GateInputs {
    fn read(dir: &Path) -> Result<Self, String> {
        Ok(GateInputs {
            steady: (
                read(dir, "steady-start.json")?,
                read(dir, "steady-end.json")?,
            ),
            apiserver: (
                text(dir, "apiserver-start.txt")?,
                text(dir, "apiserver-end.txt")?,
            ),
            cost: read(dir, "gate-cost.json")?,
        })
    }
}

/// Of the row above, which the sessions' rows are set against.
pub struct Baseline {
    pub core_mb: f64,
    pub webview_mb: f64,
}

/// CPU time of the app alone between two samples, as a share of one core.
fn core_percent(start: &Sample, end: &Sample) -> f64 {
    end.app.cpu_ns.saturating_sub(start.app.cpu_ns) as f64 / ((end.at_ms - start.at_ms) * 1e6)
        * 100.0
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn percents(values: &[f64]) -> String {
    values
        .iter()
        .map(|v| format!("{v:.2}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn median_mb(samples: &[Sample], bytes: impl Fn(&Sample) -> u64) -> f64 {
    let values: Vec<f64> = samples.iter().map(|s| bytes(s) as f64 / MB).collect();
    percentile(&values, 50.0).unwrap_or(0.0)
}

fn budgeted(sample: &Sample) -> u64 {
    sample
        .webkit
        .iter()
        .filter(|p: &&Process| p.name != GPU_PROCESS)
        .map(|p| p.rss)
        .sum()
}

fn shown(metric: &str, value: Option<String>, measured: String) -> Row {
    Row {
        metric: metric.into(),
        value,
        target: "-".into(),
        status: Status::Shown,
        measured,
    }
}

/// The value of `labels` in a line of Prometheus text, which quotes each one.
fn labels(line: &str) -> Option<HashMap<&str, &str>> {
    let inside = line.split_once('{')?.1.split_once('}')?.0;
    let mut found = HashMap::new();
    let mut rest = inside;
    while let Some((key, after)) = rest.split_once("=\"") {
        let (value, after) = after.split_once('"')?;
        found.insert(key, value);
        rest = after.strip_prefix(',').unwrap_or(after);
    }
    Some(found)
}

/// How many requests the API server's `/metrics` counted in `apiserver_request_total` whose
/// labels `count` takes.
pub fn counted(metrics: &str, count: impl Fn(&HashMap<&str, &str>) -> bool) -> u64 {
    metrics
        .lines()
        .filter(|line| line.starts_with("apiserver_request_total{"))
        .filter(|line| labels(line).is_some_and(|labels| count(&labels)))
        .filter_map(|line| line.rsplit_once(' ')?.1.parse::<f64>().ok())
        .map(|n| n as u64)
        .sum()
}

/// What the gate takes of the core's CPU in the steady phase, as far as the count and the cost of
/// a request tell.
#[derive(Debug, PartialEq)]
pub struct GateShare {
    /// The requests the API server counted that are not patches, whoever sent them: the churn's
    /// patches are the only ones in the phase, and the app sends none.
    pub counted: u64,
    /// The polls of the metrics API the app may have sent, which the API server does not count.
    pub polls: u64,
    pub seconds: f64,
    pub core_ms: f64,
    /// What the dearest request but a patch costs the gate in `gate_cost`, the higher of its cold
    /// and its hot figure.
    pub cost_ns: f64,
    /// The same request's figure in a hot loop.
    pub hot_ns: f64,
    /// Percent of the core's CPU time.
    pub estimate: f64,
}

fn gate_share(
    steady: &(Sample, Sample),
    apiserver: &(String, String),
    gate: &GateCost,
) -> Result<GateShare, String> {
    let priced = || gate.classes.iter().filter(|class| class.method != "PATCH");
    let cost_ns = priced()
        .map(|class| class.gate_ns.max(class.cold_gate_ns))
        .reduce(f64::max)
        .ok_or("gate-cost.json has no class but a patch")?;
    let hot_ns = priced()
        .map(|class| class.gate_ns)
        .reduce(f64::max)
        .ok_or("gate-cost.json has no class but a patch")?;
    let counted = counted(&apiserver.1, |l| l.get("verb") != Some(&"PATCH"))
        .saturating_sub(counted(&apiserver.0, |l| l.get("verb") != Some(&"PATCH")));
    let seconds = (steady.1.at_ms - steady.0.at_ms) / 1000.0;
    let polls = (seconds / POLL_SECONDS).ceil() as u64;
    let core_ns = steady.1.app.cpu_ns.saturating_sub(steady.0.app.cpu_ns) as f64;
    Ok(GateShare {
        counted,
        polls,
        seconds,
        core_ms: core_ns / 1e6,
        cost_ns,
        hot_ns,
        estimate: (counted + polls) as f64 * cost_ns / core_ns * 100.0,
    })
}

/// A share that may be a hundred-thousandth of a percent.
fn percent(value: f64) -> String {
    if value < 0.01 {
        format!("{value:.1e} %")
    } else {
        format!("{value:.2} %")
    }
}

const CORE: &str = "Core RSS, sessions open";
const WEBVIEW: &str = "  Webview memory, sessions open";
const VISIBLE: &str = "Visible CPU, sessions open, window on screen";
const IDLE: &str = "Idle CPU, sessions open, window hidden";
const PROXY: &str = "Terminal watch through the policy proxy: core CPU";
const DIRECT: &str = "  The same watch straight to the cluster";
const SHARE: &str = "  The policy proxy's share";
const GATE: &str = "Gate, share of the core's CPU, steady phase";
const SESSION_ROWS: [&str; 7] = [CORE, WEBVIEW, VISIBLE, IDLE, PROXY, DIRECT, SHARE];

pub fn rows(inputs: &Inputs, baseline: &Baseline) -> Vec<Row> {
    let mut rows = match &inputs.sessions {
        Ok(sessions) => session_rows(sessions, baseline),
        Err(why) => SESSION_ROWS
            .into_iter()
            .map(|metric| shown(metric, None, format!("not measured: {why}")))
            .collect(),
    };
    rows.push(
        match inputs
            .gate
            .as_ref()
            .map_err(String::clone)
            .and_then(|gate| gate_share(&gate.steady, &gate.apiserver, &gate.cost))
        {
            Ok(share) => gate_row(&share),
            Err(why) => shown(GATE, None, format!("not measured: {why}")),
        },
    );
    rows
}

fn session_rows(sessions: &Sessions, baseline: &Baseline) -> Vec<Row> {
    let Sessions {
        opened,
        forward_read,
        memory,
        visible,
        windows,
        idle,
        hidden,
    } = sessions;
    let open = format!(
        "a shell in pod {} (asked in a dialog: {:?}), a port-forward of {}:{} on localhost:{} (read once: HTTP {}, {} bytes), and a {} terminal ({}); taken after the window was hidden and shown again and after the four watch windows, once the terminal's watch was stopped with Ctrl-C and its shell was at the prompt",
        opened.shell.pod,
        opened.shell.question,
        opened.forward.target,
        opened.forward.port,
        opened.forward.local,
        forward_read.status,
        forward_read.bytes,
        opened.terminal.shell,
        opened.terminal.kind,
    );
    let mut rows = Vec::new();

    let core = median_mb(memory, |s| s.app.rss);
    rows.push(shown(
        CORE,
        Some(format!("{core:.0} MB")),
        format!(
            "resident size of {} under churn with the pod list and {open}; the median of {} samples; {:+.0} MB against the row with the list alone",
            memory[0].app.name,
            memory.len(),
            core - baseline.core_mb,
        ),
    ));
    let webview = median_mb(memory, budgeted);
    rows.push(shown(
        WEBVIEW,
        Some(format!("{webview:.0} MB")),
        format!(
            "resident size of the WebKit processes but the GPU process, the same samples; {:+.0} MB against the row with the list alone",
            webview - baseline.webview_mb,
        ),
    ));

    let cores = |via: Via| -> Vec<f64> {
        windows
            .iter()
            .filter(|w| w.via == via)
            .map(|w| core_percent(&w.start, &w.end))
            .collect()
    };
    let rate = |via: Via| -> String {
        let per_second: Vec<f64> = windows
            .iter()
            .filter(|w| w.via == via)
            .map(|w| w.received as f64 / w.seconds / 1000.0)
            .collect();
        percents(&per_second)
    };
    let (start, end) = visible;
    rows.push(shown(
        VISIBLE,
        Some(format!("{:.2} %", cpu_percent(start, end))),
        format!(
            "CPU time of the app and its {} WebKit processes over {:.0} s, as a share of one core, with the window on screen, the terminal's watch stopped and its shell at the prompt, 100 changes/s; it swings between runs, so nothing judges it (docs/bench.md)",
            end.webkit.len(),
            (end.at_ms - start.at_ms) / 1000.0,
        ),
    ));
    let (start, end) = idle;
    rows.push(shown(
        IDLE,
        Some(format!("{:.2} %", cpu_percent(start, end))),
        format!(
            "CPU time of the app and its {} WebKit processes over {:.0} s, as a share of one core, of which the app process {:.2} %; document {}; the terminal's watch stopped and its shell at the prompt",
            end.webkit.len(),
            (end.at_ms - start.at_ms) / 1000.0,
            core_percent(start, end),
            hidden.as_ref().map_or("visibility not reported", |h| &h.visibility),
        ),
    ));

    let proxy = cores(Via::Proxy);
    let direct = cores(Via::Direct);
    let order = windows
        .iter()
        .map(|w| {
            if w.via == Via::Proxy {
                "proxy"
            } else {
                "direct"
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    rows.push(shown(
        PROXY,
        mean(&proxy).map(|v| format!("{v:.2} %")),
        format!(
            "CPU time of the app process over 20 s, as a share of one core, while the terminal runs `kubectl get pods -A -w` through the policy proxy, window on screen; {} windows: {} %; the terminal received {} KB/s",
            proxy.len(),
            percents(&proxy),
            rate(Via::Proxy),
        ),
    ));
    rows.push(shown(
        DIRECT,
        mean(&direct).map(|v| format!("{v:.2} %")),
        format!(
            "the same, with the cluster's own kubeconfig named on the command line, in the same terminal; {} windows: {} %; the terminal received {} KB/s",
            direct.len(),
            percents(&direct),
            rate(Via::Direct),
        ),
    ));
    rows.push(shown(
        SHARE,
        mean(&proxy)
            .zip(mean(&direct))
            .map(|(proxy, direct)| format!("{:+.2} %", proxy - direct)),
        format!(
            "the two rows above subtracted: what the proxy adds to the core, the terminal's output being the same; windows in the order {order}, so that a drift of the cluster or the page cancels; run to run it swings, so nothing judges it (docs/bench.md)"
        ),
    ));

    rows
}

fn gate_row(share: &GateShare) -> Row {
    shown(
        GATE,
        Some(format!("about {}", percent(share.estimate))),
        format!(
            "an estimate, not a bound: the {} requests that were not patches which the API server counted in {:.0} s, whoever sent them, and the {} polls of the metrics API that it does not count, each at {:.0} ns, the dearest class's cost in gate_cost with the caches evicted before the call ({:.0} ns in a hot loop; both layers, a guarded context, the UI), over the core's {:.0} ms of CPU; the churn's patches are the only ones, and the app sends none (docs/bench.md)",
            share.counted, share.seconds, share.polls, share.cost_ns, share.hot_ns, share.core_ms,
        ),
    )
}

#[cfg(test)]
pub(crate) mod fixture {
    use super::*;

    pub(crate) fn process(pid: i32, name: &str, rss: u64, cpu_ns: u64) -> Process {
        Process {
            pid,
            responsible: 700,
            name: name.to_owned(),
            rss,
            footprint: 0,
            cpu_ns,
        }
    }

    pub(crate) fn sample(at_ms: f64, app_cpu: u64, webkit_cpu: u64) -> Sample {
        Sample {
            at_ms,
            app: process(700, "twigo", 150 * 1_000_000, app_cpu),
            webkit: vec![
                process(
                    701,
                    "com.apple.WebKit.WebContent",
                    250 * 1_000_000,
                    webkit_cpu,
                ),
                process(703, "com.apple.WebKit.GPU", 30 * 1_000_000, 0),
            ],
            other_webkit: vec![],
        }
    }

    pub(crate) fn window(via: Via, app_ms: u64) -> Window {
        Window {
            via,
            start: sample(0.0, 0, 0),
            end: sample(20_000.0, app_ms * 1_000_000, 2_000_000_000),
            received: 2_000_000,
            seconds: 20.0,
        }
    }

    pub(crate) const METRICS: &str = r#"# TYPE apiserver_request_total counter
apiserver_request_total{code="200",component="apiserver",dry_run="",group="metrics.k8s.io",resource="pods",scope="cluster",subresource="",verb="LIST",version="v1beta1"} 10
apiserver_request_total{code="200",component="apiserver",dry_run="",group="",resource="pods",scope="resource",subresource="status",verb="PATCH",version="v1"} 5000
apiserver_request_total{code="200",component="apiserver",dry_run="",group="coordination.k8s.io",resource="leases",scope="resource",subresource="",verb="GET",version="v1"} 40
apiserver_request_duration_seconds_count{verb="GET"} 99999
"#;

    pub(crate) fn class(method: &str, gate_ns: f64, cold_gate_ns: f64) -> GateClass {
        GateClass {
            method: method.into(),
            gate_ns,
            cold_gate_ns,
        }
    }

    pub(crate) fn gate() -> GateInputs {
        GateInputs {
            steady: (sample(0.0, 0, 0), sample(60_000.0, 600_000_000, 0)),
            apiserver: (
                METRICS.to_owned(),
                METRICS
                    .replace("} 10\n", "} 14\n")
                    .replace("} 5000\n", "} 11000\n")
                    .replace("} 40\n", "} 70\n"),
            ),
            cost: GateCost {
                classes: vec![
                    class("GET", 300.0, 1200.0),
                    class("GET", 450.0, 1500.0),
                    class("PATCH", 400.0, 3000.0),
                ],
            },
        }
    }

    pub(crate) fn sessions(
        core_ms_in_a_proxy_window: u64,
        core_ms_in_a_direct_one: u64,
    ) -> Sessions {
        let opened = Opened {
            shell: OpenedShell {
                pod: "shell".into(),
                question: "Open a shell in shell?".into(),
            },
            forward: OpenedForward {
                target: "coredns-1".into(),
                port: 8080,
                local: 8080,
            },
            terminal: OpenedTerminal {
                kind: "proxy".into(),
                shell: "zsh".into(),
            },
        };
        Sessions {
            opened,
            forward_read: ForwardRead {
                status: 200,
                bytes: 2,
            },
            memory: vec![sample(0.0, 0, 0)],
            visible: (sample(0.0, 0, 0), sample(20_000.0, 0, 5_000_000_000)),
            windows: vec![
                window(Via::Proxy, core_ms_in_a_proxy_window),
                window(Via::Direct, core_ms_in_a_direct_one),
                window(Via::Direct, core_ms_in_a_direct_one),
                window(Via::Proxy, core_ms_in_a_proxy_window),
            ],
            idle: (sample(0.0, 0, 0), sample(30_000.0, 300_000_000, 0)),
            hidden: Some(Hidden {
                visibility: "hidden".into(),
            }),
        }
    }

    pub(crate) fn inputs(core_ms_in_a_proxy_window: u64, core_ms_in_a_direct_one: u64) -> Inputs {
        Inputs {
            sessions: Ok(sessions(core_ms_in_a_proxy_window, core_ms_in_a_direct_one)),
            gate: Ok(gate()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{METRICS, class, gate, inputs, sample};
    use super::*;

    fn baseline() -> Baseline {
        Baseline {
            core_mb: 140.0,
            webview_mb: 240.0,
        }
    }

    fn value<'a>(rows: &'a [Row], metric: &str) -> &'a str {
        rows.iter()
            .find(|row| row.metric.trim() == metric)
            .and_then(|row| row.value.as_deref())
            .unwrap_or_else(|| panic!("no row {metric:?}"))
    }

    #[test]
    fn the_rows_are_shown_and_never_judged() {
        let rows = rows(&inputs(300, 200), &baseline());
        assert_eq!(rows.len(), 8);
        assert!(rows.iter().all(|row| row.status == Status::Shown));
        assert_eq!(value(&rows, "Core RSS, sessions open"), "150 MB");
        assert_eq!(value(&rows, "Webview memory, sessions open"), "250 MB");
    }

    #[test]
    fn the_proxy_is_what_the_core_spends_more_through_it_than_straight_to_the_cluster() {
        let rows = rows(&inputs(300, 200), &baseline());
        assert_eq!(
            value(&rows, "Terminal watch through the policy proxy: core CPU"),
            "1.50 %"
        );
        assert_eq!(
            value(&rows, "The same watch straight to the cluster"),
            "1.00 %"
        );
        assert_eq!(value(&rows, "The policy proxy's share"), "+0.50 %");
        let slower_straight = rows_of(150, 200);
        assert_eq!(
            value(&slower_straight, "The policy proxy's share"),
            "-0.25 %"
        );
    }

    fn rows_of(proxy_ms: u64, direct_ms: u64) -> Vec<Row> {
        rows(&inputs(proxy_ms, direct_ms), &baseline())
    }

    #[test]
    fn visible_cpu_is_the_sample_after_the_watch_stopped_and_not_a_watch_window() {
        let rows = rows_of(300, 900);
        assert_eq!(
            value(&rows, "Visible CPU, sessions open, window on screen"),
            "25.00 %"
        );
    }

    #[test]
    fn idle_cpu_is_the_hidden_window_with_the_sessions_open() {
        let rows = rows_of(300, 200);
        assert_eq!(
            value(&rows, "Idle CPU, sessions open, window hidden"),
            "1.00 %"
        );
        let measured = &rows
            .iter()
            .find(|row| row.metric.starts_with("Idle CPU"))
            .unwrap()
            .measured;
        assert!(measured.contains("document hidden"), "{measured}");
    }

    #[test]
    fn prometheus_text_is_read_by_its_labels() {
        assert_eq!(counted(METRICS, |_| true), 5050);
        assert_eq!(counted(METRICS, |l| l.get("verb") == Some(&"PATCH")), 5000);
        assert_eq!(
            counted(METRICS, |l| l.get("group") == Some(&"metrics.k8s.io")),
            10
        );
        assert_eq!(counted("apiserver_request_total 3\n", |_| true), 0);
    }

    #[test]
    fn the_gate_is_the_requests_that_were_not_patches_times_the_dearest_cold_cost() {
        let gate = gate();
        let share = gate_share(&gate.steady, &gate.apiserver, &gate.cost).unwrap();
        assert_eq!((share.counted, share.polls), (34, 4));
        assert_eq!(share.seconds, 60.0);
        assert_eq!(share.core_ms, 600.0);
        assert_eq!((share.cost_ns, share.hot_ns), (1500.0, 450.0));
        assert!((share.estimate - 38.0 * 1500.0 / 600e6 * 100.0).abs() < 1e-12);
        assert_eq!(percent(share.estimate), "9.5e-3 %");
        assert_eq!(percent(1.5), "1.50 %");
    }

    #[test]
    fn a_hot_figure_above_the_cold_one_is_the_cost() {
        let mut gate = gate();
        gate.cost.classes = vec![class("GET", 500.0, 400.0)];
        let share = gate_share(&gate.steady, &gate.apiserver, &gate.cost).unwrap();
        assert_eq!(share.cost_ns, 500.0);
    }

    #[test]
    fn the_gate_row_is_an_estimate_with_its_method() {
        let rows = rows_of(300, 200);
        let row = rows
            .iter()
            .find(|row| row.metric.starts_with("Gate"))
            .unwrap();
        assert_eq!(row.value.as_deref(), Some("about 9.5e-3 %"));
        assert!(
            row.measured.contains("an estimate, not a bound"),
            "{}",
            row.measured
        );
        assert!(row.measured.contains("1500 ns"), "{}", row.measured);
        assert!(row.measured.contains("caches evicted"), "{}", row.measured);
    }

    #[test]
    fn the_polls_are_the_pollers_interval() {
        assert_eq!(POLL_SECONDS, twigo_cache::metrics::INTERVAL.as_secs_f64());
    }

    #[test]
    fn a_gate_cost_without_a_class_but_a_patch_is_an_error() {
        let mut gate = gate();
        gate.cost.classes = vec![class("PATCH", 400.0, 3000.0)];
        let error = gate_share(&gate.steady, &gate.apiserver, &gate.cost).unwrap_err();
        assert!(error.contains("no class but a patch"), "{error}");
    }

    fn run_dir(windows: usize, ends: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let put = |name: &str, value: serde_json::Value| {
            std::fs::write(dir.path().join(name), value.to_string()).unwrap();
        };
        let at = |ms: f64| serde_json::to_value(sample(ms, 0, 0)).unwrap();
        put(
            "sessions.json",
            serde_json::json!({
                "shell": { "pod": "shell", "question": "Open?" },
                "forward": { "target": "coredns", "port": 8080, "local": 8080 },
                "terminal": { "kind": "proxy", "shell": "zsh" },
            }),
        );
        put(
            "forward-read.json",
            serde_json::json!({ "status": 200, "bytes": 2 }),
        );
        for n in 1..=2 {
            put(&format!("sessions-memory-{n}.json"), at(0.0));
        }
        put("sessions-visible-start.json", at(0.0));
        put("sessions-visible-end.json", at(20_000.0));
        for n in 1..=windows {
            let via = if n % 2 == 1 { "proxy" } else { "direct" };
            put(
                &format!("watch-{n}.json"),
                serde_json::json!({ "via": via, "bytes": 100, "atMs": 1000.0 }),
            );
            put(&format!("window-{n}-start.json"), at(0.0));
            put(&format!("window-{n}-end.json"), at(20_000.0));
        }
        for n in 1..=ends {
            let via = if n % 2 == 1 { "proxy" } else { "direct" };
            put(
                &format!("watched-{n}.json"),
                serde_json::json!({ "via": via, "bytes": 2100, "atMs": 21_000.0 }),
            );
        }
        put("idle-sessions-start.json", at(0.0));
        put("idle-sessions-end.json", at(30_000.0));
        put("steady-start.json", at(0.0));
        put("steady-end.json", at(60_000.0));
        std::fs::write(dir.path().join("apiserver-start.txt"), METRICS).unwrap();
        std::fs::write(dir.path().join("apiserver-end.txt"), METRICS).unwrap();
        put(
            "gate-cost.json",
            serde_json::json!({
                "classes": [{ "name": "pods list", "method": "GET", "gateNs": 300.0, "coldGateNs": 1200.0 }]
            }),
        );
        dir
    }

    #[test]
    fn a_directory_of_a_run_is_read_into_its_windows() {
        let dir = run_dir(3, 3);
        let inputs = Inputs::read(dir.path());
        assert!(inputs.gate.is_ok());
        let inputs = inputs.sessions.unwrap();
        assert_eq!(inputs.memory.len(), 2);
        assert_eq!(
            inputs.windows.iter().map(|w| w.via).collect::<Vec<_>>(),
            [Via::Proxy, Via::Direct, Via::Proxy]
        );
        assert_eq!(inputs.windows[0].received, 2000);
        assert_eq!(inputs.windows[0].seconds, 20.0);
        assert!(inputs.hidden.is_none());
    }

    #[test]
    fn a_window_that_was_sampled_and_never_ended_is_an_error() {
        let dir = run_dir(3, 2);
        let error = Inputs::read(dir.path()).sessions.err().unwrap();
        assert!(
            error.contains("3 watch markers, 2 ends and 3 sampled windows"),
            "{error}"
        );
        assert!(Inputs::read(run_dir(0, 0).path()).sessions.is_err());
    }

    fn unmeasured(dir: &tempfile::TempDir) -> Vec<Row> {
        rows(&Inputs::read(dir.path()), &baseline())
    }

    #[test]
    fn a_step_that_failed_leaves_every_sessions_row_saying_so() {
        let dir = run_dir(2, 1);
        std::fs::write(
            dir.path().join("failure.json"),
            r#"{"message":"local port 8080 must be free"}"#,
        )
        .unwrap();
        let rows = unmeasured(&dir);
        assert_eq!(rows.len(), 8);
        for row in rows.iter().take(7) {
            assert_eq!(row.value, None, "{}", row.metric);
            assert_eq!(row.status, Status::Shown);
            assert!(
                row.measured
                    .contains("not measured: the run stopped: local port 8080 must be free"),
                "{}: {}",
                row.metric,
                row.measured
            );
        }
        assert!(rows[7].value.is_some(), "the gate's files are all there");
    }

    #[test]
    fn a_run_that_never_reached_the_sessions_says_which_file_is_missing() {
        let dir = run_dir(2, 2);
        std::fs::remove_file(dir.path().join("sessions.json")).unwrap();
        let rows = unmeasured(&dir);
        assert!(
            rows[0].measured.contains("sessions.json"),
            "{}",
            rows[0].measured
        );
        assert!(!rows[0].measured.contains("the run stopped"));
    }

    #[test]
    fn a_run_without_the_gate_files_leaves_its_row_alone_unmeasured() {
        let dir = run_dir(4, 4);
        std::fs::remove_file(dir.path().join("steady-start.json")).unwrap();
        let rows = unmeasured(&dir);
        assert_eq!(rows[7].value, None);
        assert!(
            rows[7].measured.contains("steady-start.json"),
            "{}",
            rows[7].measured
        );
        assert_eq!(value(&rows, "Core RSS, sessions open"), "150 MB");
    }
}
