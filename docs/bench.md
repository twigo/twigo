# The bench harness

M0 step 7, 2026-11-01.
The harness measures the six budgets of [ARCHITECTURE 3.8](ARCHITECTURE.md#38-performance-budgets-and-the-benchmark) at 5k pods in the real Tauri app.
Before M1 there is no Rust list path, so it reports what M0 can measure and says what it cannot; M1 swaps the webview's backend and keeps the harness.

- Run: `export TWIGO_BENCH_DIR=$(mktemp -d)`, then `bench/harness.sh` on macOS, with the screen unlocked and the app's window left on screen until it hides itself, about three minutes after launch.
  Without an argument it creates a kind 1.37 cluster with kwok and 5,000 pods (`bench/cluster.sh up bench`, `bench/pods.sh`) and deletes it at the end; given a kubeconfig, it uses that cluster, which must hold the `bench/bench` Deployment at 5,000 pods.
- Output: the report table on stdout; `report.json` and every file it is built from in `$TWIGO_BENCH_DIR/harness`.
- Code: `bench/harness.sh`; `bench/harness`, the `twigo-bench` tool with `churn`, `launch`, `sample` and `report`; `apps/desktop/bench`, the webview's entry and driver; `apps/desktop/src-tauri/src/bench.rs`, the app's bench commands.

## A run

1. `cargo build --release -p twigo-bench`, then `pnpm tauri build --no-bundle --features bench --config src-tauri/tauri.bench.conf.json`: a release build, since a debug core's CPU and memory say nothing about the budgets.
2. `twigo-bench churn` starts against the cluster at 100 changes/s and runs until the app is done.
   The harness waits for its first logged change, and stops with the churn's error whenever it exits early.
3. `twigo-bench launch target/release/twigo` starts the app with `TWIGO_BENCH=$TWIGO_BENCH_DIR/harness`.
4. The webview's driver opens `k8s-list://prod-eu/v1/pods`, waits for the first rows, scrolls for 5 s, sorts ten times and then watches changed cells for 60 s.
   When it starts watching it writes `steady.json`; 10 s later the harness samples memory five times, 2 s apart, and the report takes the median of each value.
5. The driver writes `webview.json` and calls `idle`: the app hides its window, writes `idle.json` and quits 45 s later.
   The harness waits 5 s, then samples CPU time at the start and the end of 30 s.
6. The harness stops the churn and runs `twigo-bench report`.

When the driver fails, the webview writes `failure.json` and then calls `idle` all the same, so the harness checks for `failure.json` after every wait and before the report, prints it and stops.

## The bench mode

Nothing of it ships.

- **Rust.**
  The `bench` feature of `apps/desktop/src-tauri` adds an inlined plugin, `twigo-bench`, with two commands: `write` stores one JSON file in `$TWIGO_BENCH`, and `idle` hides the window and quits after 45 s.
  tauri-build writes an inlined plugin's permissions into `OUT_DIR`, not into the source tree, and the plugin adds its capability at runtime, so a build without the feature has neither the commands nor their grants: on 2026-11-01 `strings` found no `twigo-bench` in the default debug binary and 3 in the bench release binary.
  A bench build refuses to start without `TWIGO_BENCH`.
- **The webview.**
  `vite build --mode bench` builds `apps/desktop/bench`, an entry of its own, into `apps/desktop/dist-bench`; the shipping build never sees it.
  It boots the workbench as `src/main.tsx` does, on the mock backend with 100 changes/s (`createMockBackend("live", "us", 100)`), through a probe that stamps every list batch with `performance.now()` on arrival, before the view applies it.
  M1 replaces the mock with `tauriBackend`; the probe, the driver and the harness stay.
- **The configuration.**
  `src-tauri/tauri.bench.conf.json` points the build at that entry and gives the app the identifier `io.twigo.ide.bench`, so a run neither hands over to the user's Twigo through the single-instance lock nor reads or writes its window state; the harness deletes the bench app's window state before each run.
- **The commands stay out of `twigo-ipc`.**
  The IPC types and the mock backend are the app's protocol; the bench's two commands are not part of it, so the bench entry calls them through `invoke` directly.

## How each metric is measured

"Painted" means the end of the frame in which the DOM first shows the value: the driver checks the DOM in a `requestAnimationFrame` callback and, once it holds, posts a `MessageChannel` message, whose handler runs after that frame is rendered.

| Metric                               | How                                                                                                                                                                                          | Before M1                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First paint after the space connects | M1: from opening the list to its first rows painted                                                                                                                                          | Not measurable: no Rust list path. The webview half, from the first batch with rows to those rows painted, is reported apart and not judged.                                                              |
| Change → painted cell, p95           | M1: join the churn log (pod, restart count, Unix ms) with the paints                                                                                                                         | Not measurable: the cluster's changes reach nothing. The webview half, from a batch to its changed cell painted, for cells on screen during 60 s of the mock's churn, is reported apart and not judged.   |
| Scroll                               | Mean fps from `requestAnimationFrame` over 5 s of scrolling at 4,000 px/s; passes at 57 fps, 95 % of 60, since frames jitter                                                                 | Shown, not judged: measured in the real WebKit webview, on the mock, which serves each window from JS and reruns the query over all 5,000 pods on each churn tick, on the webview's main thread.          |
| Sort                                 | Header click → the new order's first 10 rows painted, ten clicks over Status, Age, Restarts, Namespace and Name, each ascending then descending, so that every click changes those rows; p95 | Shown, not judged: measured in the real webview, on the mock, which sorts 5,000 rows in JS on the webview's main thread, unlike Rust's incremental index.                                                 |
| Core RSS                             | Resident size of the app process under churn, with the list open                                                                                                                             | Shown, not judged: M0's core holds no watch cache, and the mock keeps the pods in the webview.                                                                                                            |
| Webview memory                       | Physical footprint summed over the `com.apple.WebKit.*` processes the app is responsible for but the GPU process, which a row of its own shows and never judges                              | Shown, not judged: the webview's JS heap holds the mock's 5,000 pods, which Rust holds from M1.                                                                                                           |
| Idle CPU                             | CPU time of the app and its WebKit processes over 30 s with the window hidden, as a share of one core                                                                                        | Shown, not judged: with the window hidden, `requestAnimationFrame` stops, so the list stops acknowledging batches, and the sample counts the mock's churn timer in the webview, nothing of the Rust path. |

The report judges a metric against its target only when the webview ran on a backend other than the mock, the `backend` of `webview.json`; a row measured on the mock shows its value as "on the mock, not judged before M1".
`twigo-bench report`, and so the harness, exits 1 when a judged row misses its target, so before M1 a run fails only when it breaks.

## Which WebKit processes are the app's

WKWebView runs pages, networking and GPU work in the XPC services `com.apple.WebKit.WebContent`, `.Networking` and `.GPU`.
launchd starts them, so their parent is pid 1, and other apps run their own: during this step a `com.apple.WebKit.Networking` belonged to Spotify.
Summing every WebKit process would count them; summing the app's children would count none.

- macOS records each process's responsible process, the one that asked for it.
  `twigo-bench sample` reads it through libsystem's `responsibility_get_pid_responsible_for_pid`, found with `dlsym`, and counts the WebKit processes whose responsible process is the app.
- A process started from a terminal inherits the terminal as its responsible process.
  Started from Terminal, the bench app and its three WebKit processes all named Terminal (pid 2623) on 2026-11-01, so they could not be told apart from anything else started there.
- `twigo-bench launch` therefore replaces itself with the app through `posix_spawn` with `POSIX_SPAWN_SETEXEC` and `responsibility_spawnattrs_setdisclaim`: the pid stays, and the app is responsible for itself, as when launchd starts it.
  Started so, the app's WebContent, GPU and Networking processes named the app, and Spotify's Networking process was left out.
- `sample` refuses an app that is not responsible for itself, rather than report an empty sum.

Limits:

- Both functions are undocumented.
  They are found at run time, and a macOS without them makes `sample` and `launch` fail with the missing name; checked on macOS 27.0 only.
- Memory is the physical footprint (`ri_phys_footprint` of `proc_pid_rusage`); the report adds their RSS, which counts the pages they share more than once.
- A WebKit process that ends between the two CPU samples loses its CPU time; one that starts in between counts whole.
- CPU times of `proc_pid_rusage` are mach absolute time units, converted with `mach_timebase_info`; on 2026-11-01 they matched `ps` to 0.01 s (Spotify 163:15.00, its Networking process 0:06.97).
- On Linux, WebKitGTK's processes are the app's children, so the sampler needs a branch of its own there; not written.

## The churn generator

`twigo-bench churn [--kubeconfig PATH] [--rate 100] [--seconds S] --log FILE` bumps the restart count of random pods of `bench/bench` through the status subresource: a JSON patch that tests that the first container is `app` and replaces its `restartCount`.
It paces patches on a fixed interval and skips the ticks it misses, so after a stall it resumes at its rate instead of sending the backlog at once, with at most 64 in flight and never two for one pod, until `--seconds` pass or SIGINT.
At that bound, or once every pod has a patch in flight, it waits for an answer, still watching for the deadline and SIGINT; the API client has no read timeout, so a patch unanswered after 10 s is logged as an error.
On stop it logs the answers of the patches still in flight.
Each change is a JSON line with the pod, the new count, and when it was sent and answered, in Unix milliseconds, for M1 to join with the webview's paints; the summary goes to stdout.
The client comes from `twigo_kube::client::Clients`, the kubeconfig from `--kubeconfig` or `TWIGO_TEST_KUBECONFIG`, and contexts other than `kind-*` and `kwok-*` are refused.

Measured on 2026-11-01 on an Apple M4 Max (16 cores, 48 GB), macOS 27.0, Docker 29.1.3 with 16 CPUs, kind 1.37 with kwok v0.8.0 and 10 nodes (`bench/cluster.sh up churn`, `bench/pods.sh <kubeconfig> 5000`), release build:

| Run                       | Changes | Errors | Changes/s | Patch p50 | p95    | Max   |
| ------------------------- | ------- | ------ | --------- | --------- | ------ | ----- |
| `--rate 100 --seconds 60` | 6,000   | 0      | 99.996    | 2.5 ms    | 3.6 ms | 25 ms |
| `--rate 500 --seconds 10` | 5,000   | 0      | 499.96    | 2.0 ms    | 3.6 ms | 26 ms |

- kwok keeps the field: 30 s after the 60 s run, each of the 3,746 changed pods held the last count logged for it, no other pod had a non-zero one, and `kubectl get pods` showed the counts under RESTARTS.
- SIGINT after 3 s stopped with 278 changes logged and the summary printed, exit 0.
- A copy of the kubeconfig with its context renamed `prod-eu` was refused, exit 1.

## Results at 5k pods

`bench/harness.sh` without a kubeconfig, with the screen unlocked, on 2026-11-01 at 12:25 UTC:

2026-11-01T12:25Z, Apple M4 Max, 48 GB, macOS 27.0, release build, 47623ef, with uncommitted changes
Churn on kwok: 100.0 changes/s over 5000 pods for 118 s, 0 errors, patch p95 3.6 ms

| Metric                                 | Value       | Target   | Status                            | What it measured                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ----------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First paint after the space connects   | -           | < 1 s    | not measurable before M1          | needs the Rust list path: watch hub, row store, query view and batcher (M1)                                                                                                                                                                                                                                                 |
| ↳ webview half                         | 19.0 ms     | -        | mock half, not judged             | first batch with rows received → rows painted; 5000 rows from the mock backend, in the webview                                                                                                                                                                                                                              |
| Change → painted cell, p95             | -           | < 150 ms | not measurable before M1          | needs the cluster's changes to reach the webview through Rust (M1)                                                                                                                                                                                                                                                          |
| ↳ webview half                         | 12.0 ms     | -        | mock half, not judged             | batch received → changed cell painted, on screen; p50 7.0 ms, max 13.0 ms, n = 41; 64 offscreen, 0 superseded, 0 timed out; 100 changes/s for 60 s; 5000 rows from the mock backend, in the webview                                                                                                                         |
| Scroll and sort: scroll                | 59.9 fps    | 60 fps   | on the mock, not judged before M1 | requestAnimationFrame over 5 s of programmatic scroll at 4000 px/s; frame p95 18.0 ms, display frame 17.0 ms; rows awaiting data in 0 of 300 frames; 5000 rows from the mock backend, in the webview, which serves each window from JS and reruns the query over every pod on each churn tick, on the webview's main thread |
| Scroll and sort: sort                  | p95 21.0 ms | < 50 ms  | on the mock, not judged before M1 | header click → resorted rows painted, Status↑ Status↓ Age↑ Age↓ Restarts↑ Restarts↓ Namespace↑ Namespace↓ Name↑ Name↓; p50 17.0 ms, max 21.0 ms, n = 10; 5000 rows from the mock backend, in the webview, which sorts every pod in JS on the webview's main thread, unlike Rust's incremental index                         |
| Core RSS with the pod list open        | 117 MB      | < 150 MB | on the mock, not judged before M1 | resident size of twigo (pid 8456) under churn, the median of 5 samples; M0's core holds no watch cache yet, and the list lives in the webview's mock                                                                                                                                                                        |
| Webview memory with the pod list open  | 687 MB      | < 300 MB | on the mock, not judged before M1 | physical footprint of the WebKit processes the app is responsible for (Networking 6 MB, WebContent 418 MB, GPU 262 MB), under churn, the median of 5 samples; their RSS adds up to 526 MB; 1 other WebKit processes left out; the webview holds the mock's 5000 pods, which Rust holds from M1                              |
| Idle CPU, 100 changes/s, window hidden | 0.86 %      | < 1 %    | on the mock, not judged before M1 | CPU time of the app and its 3 WebKit processes over 30 s, as a share of one core; document hidden; hidden, the webview stops acknowledging batches, so this counts the mock's 100 changes/s timer in the webview, and the cluster's churn reaches nothing before M1                                                         |

The five memory samples of the webview ran from 676 to 696 MB.
The first run, at 11:35 UTC, took one sample: 640 MB, WebContent 368 MB and GPU 265 MB.

"With uncommitted changes" was the five memory samples of the commit that adds this run, and a local edit to `apps/desktop/src/main.tsx`, the app's own entry, which the bench build does not load.
Nothing in the table is judged: every value comes from the mock in the webview, so it bounds only the webview's share of each target.
Webview memory is over the whole budget of 3.8 with the mock's 5000 pods in it; [where it goes](#where-the-webviews-memory-goes) is measured below.

A run before the first one failed 55 s into the measurements: Terminal came to the front and covered the bench window, whose document then turned `hidden`.
The bench window now stays above other windows, and the failure names a covered window as well as a locked screen.

Earlier the same day the screen was locked while this step ran, so nothing painted.
What ran then: `bench/harness.sh <kubeconfig>` against the churn cluster, and `bench/harness.sh` without a kubeconfig under macOS's bash 3.2, up to the visibility failure and through the clean-up; and the driver end to end in headless Chrome with a stand-in for Tauri's IPC, whose Chromium timings are not results.

## Where the webview's memory goes

The first run's 640 MB was over the 300 MB budget, so on 2026-11-01 the webview was measured in nine states, on the machine above with WebKit 22625.1.29.
Each state was a temporary edit of `apps/desktop/bench/main.tsx`, not committed, in the release bench build.
The window stayed visible and on top, and 10 s after the page settled `twigo-bench sample` read the footprint five times, 2 s apart.
The values are medians in MB; Networking was 6–7 MB in every state.

| State                                                      | WebContent | GPU |
| ---------------------------------------------------------- | ---------- | --- |
| Blank page                                                 | 41         | 11  |
| Blank page with one number updated 10 times a second       | 59         | 256 |
| Workbench without an editor                                | 55         | 15  |
| Pod list, 5000 pods, no churn                              | 101        | 16  |
| Pod list, 10 changes/s                                     | 235        | 260 |
| Pod list, 100 changes/s                                    | 325        | 325 |
| Pod list, 100 changes/s, after 5 s of scroll               | 359        | 262 |
| Pod list, 100 changes/s, grid `display: none`              | 93         | 261 |
| Pod list, 100 changes/s, the whole `#root` `display: none` | 104        | 15  |

- **GPU.**
  Any page that repaints, even one number on a blank page, takes about 260 MB, and a page that does not repaint stays at 11–16 MB.
  Hiding the grid, the tab strip, the editor content or the status bar left it at 260–320 MB.
  So it is not the list's layers: it matches WebKit's pool of IOSurfaces, whose cap on the Mac is 256 MB (`defaultMaximumBytesCached` in `Source/WebCore/platform/graphics/cg/IOSurfacePool.h` on WebKit's main branch, read the same day, not the shipped release's source).
  That header says pooled surfaces are marked volatile, but `footprint` counted 227–286 MB of the GPU process as dirty graphics memory; whether macOS reclaims it under memory pressure was not checked.
- **WebContent.**
  The list of 5000 mock pods adds 46 MB over the workbench at rest.
  The mock's churn adds 130–220 MB more, much of it WebKit Malloc that `footprint` shows as reclaimable: the mock reruns the query over every pod on each change in JS, and the garbage waits for the collector.
  From M1 Rust holds the pods and runs the queries, and the webview gets only patches.
- **Not a cache.**
  `vmmap -summary` of the GPU process, with the pod list under churn, showed its 227 MB of owned graphics memory dirty, with 0 K volatile: the kernel cannot drop it, so it is the system's real cost, not a cache.
  `memory_pressure -S`, which would have simulated the system's pressure notification, needs root and changed nothing.
- **The budget.**
  3.8's 300 MB counted every WebKit process, so the GPU pool alone took most of it on any live page.
  From 2026-11-01 the budget counts the WebKit processes but the GPU process, and the report shows the GPU process on a row of its own, never judged: re-reported with that split, the 12:25 run's webview memory is 425 MB, and its GPU process 262 MB.

## What M1 and CI must add

- **M1.**
  Replace `createMockBackend` with `tauriBackend` in `apps/desktop/bench/main.tsx`, and give the app the harness's kubeconfig.
  The report then judges first paint (open → first rows painted) and change → painted cell (the churn log joined with paints by pod and restart count, through Unix ms on both sides), and drops the webview halves; scroll, sort, memory and idle CPU are judged once the bench entry reports a backend other than `mock`.
  The sort sequence was picked on the mock's pods; `bench/pods.sh` puts every pod in `bench`, available, so Namespace and Status sorts may leave the first rows as they were there, and the driver stops when a click does: M1 checks the sequence on kwok.
  Core RSS and idle CPU then include the watch cache and the batcher, and the 20k and 50k columns of 3.8 need `bench/pods.sh` at those counts.
- **CI.**
  The harness needs a logged-in, unlocked GUI session; whether GitHub's macOS runners give one is not verified.
  Linux needs the sampler's WebKitGTK branch and a display, as `bench/ipc/linux.sh` gets from Xvfb in Docker, whose numbers say nothing about a Linux desktop.
  A workflow would build once, run the harness per pod count, fail when it fails, and keep `report.json` as an artifact.
