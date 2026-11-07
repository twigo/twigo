# The bench harness

M0 step 7, 2026-11-01; on the Rust list path since M1 step 7, 2026-11-02.
The harness measures the six budgets of [ARCHITECTURE 3.8](ARCHITECTURE.md#38-performance-budgets-and-the-benchmark) at 5k pods in the real Tauri app, the cluster's pods coming through the watch hub, the query view and the batcher.

- Run: `export TWIGO_BENCH_DIR=$(mktemp -d)`, then `bench/harness.sh` on macOS, with the screen unlocked.
  The app takes no focus and its window stays behind others, so the desktop stays in use ([the window](#the-window)).
  Without an argument it creates a kind 1.37 cluster with kwok and 5,000 pods (`bench/cluster.sh up bench`, `bench/pods.sh`) and deletes it at the end; given a kubeconfig, it uses that cluster, which must hold the `bench/bench` Deployment at 5,000 pods.
- Output: the report table on stdout; `report.json` and every file it is built from in `$TWIGO_BENCH_DIR/harness`.
- Code: `bench/harness.sh`; `bench/harness`, the `twigo-bench` tool with `churn`, `launch`, `sample` and `report`; `apps/desktop/bench`, the webview's entry and driver; `apps/desktop/src-tauri/src/bench.rs`, the app's bench commands.

## A run

1. `cargo build --release -p twigo-bench`, then `pnpm tauri build --no-bundle --features bench --config src-tauri/tauri.bench.conf.json`: a release build, since a debug core's CPU and memory say nothing about the budgets.
2. `twigo-bench churn` starts against the cluster at 100 changes/s and runs until the app is done.
   The harness waits for its first logged change, and stops with the churn's error whenever it exits early.
3. `twigo-bench launch target/release/twigo` starts the app with `TWIGO_BENCH=$TWIGO_BENCH_DIR/harness` and the cluster's kubeconfig as `TWIGO_KUBECONFIG`, so the catalog lists that one context.
4. The webview's driver opens the context's space and its pod list across every namespace, waits for the first rows, scrolls for 5 s, sorts eight times and then watches the Restarts cells on screen change for 60 s.
   When it starts watching it writes `steady.json`; 10 s later the harness samples memory five times, 2 s apart, and the report takes the median of each value.
5. The driver writes `visible.json` and sleeps for 30 s, the list still sorted by Restarts descending.
   The harness waits 5 s, then samples CPU time at the start and the end of 20 s.
6. The driver writes `webview.json` and calls `idle`: the app hides its window, writes `idle.json` and quits 45 s later.
   The harness waits 5 s, then samples CPU time at the start and the end of 30 s.
7. The harness stops the churn and runs `twigo-bench report`.

When the driver fails, the webview writes `failure.json` and then calls `idle` all the same, so the harness checks for `failure.json` after every wait and before the report, prints it and stops.

## The bench mode

Nothing of it ships.

- **Rust.**
  The `bench` feature of `apps/desktop/src-tauri` adds an inlined plugin, `twigo-bench`, with two commands: `write` stores one JSON file in `$TWIGO_BENCH`, and `idle` hides the window and quits after 45 s.
  tauri-build writes an inlined plugin's permissions into `OUT_DIR`, not into the source tree, and the plugin adds its capability at runtime, so a build without the feature has neither the commands nor their grants: on 2026-11-01 `strings` found no `twigo-bench` in the default debug binary and 3 in the bench release binary.
  A bench build refuses to start without `TWIGO_BENCH`.
- **The webview.**
  `vite build --mode bench` builds `apps/desktop/bench`, an entry of its own, into `apps/desktop/dist-bench`; the shipping build never sees it.
  It boots the workbench as `src/main.tsx` does, on `tauriBackend`, through a probe that stamps every list batch with `performance.now()` on arrival, before the view applies it.
  Until M1 step 7 it ran on the mock backend, whose numbers the [first results](#results-at-5k-pods-on-the-mock) keep.
- **The configuration.**
  `src-tauri/tauri.bench.conf.json` points the build at that entry and gives the app the identifier `io.twigo.ide.bench`, so a run neither hands over to the user's Twigo through the single-instance lock nor reads or writes its window state; the harness deletes the bench app's window state before each run.
  It also places [the window](#the-window).
- **The commands stay out of `twigo-ipc`.**
  The IPC types are the app's protocol; the bench's two commands are not part of it, so the bench entry calls them through `invoke` directly.

## The window

A run leaves the desktop alone, and its numbers do not depend on what the desktop does.

- The window has 40 pt on screen, at the screen's left edge, behind other windows: `x` and `focus` in `src-tauri/tauri.bench.conf.json`.
- The app takes no focus: `activate_ignoring_other_apps(false)` and the `Accessory` activation policy, so it has no Dock icon either.
- WebKit pauses a page in a window it counts as covered, so the bench turns that off with `_setWindowOcclusionDetectionEnabled:` ([WKWebViewPrivate.h](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h#L876)).
  That setter only stores its flag ([WebViewImpl.h](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/WebKit/UIProcess/mac/WebViewImpl.h#L438)), and the page stayed `hidden` until the view was hidden and shown once, as the page starts.
- A process activity keeps App Nap away while the window is covered.

Limits:

- The setter is private; checked on macOS 27.2 only, and a macOS without it stops the app with an unrecognized selector.
- A display to the left of the main one shows the window whole, as `x` then lies on it; not tried.
- One run with the window fully off the screen read 14.8 % by Name, as at the edge, which is where the numbers below were taken.
- WebKit still paints nothing behind a locked screen.

## How each metric is measured

"Painted" means the end of the frame in which the DOM first shows the value: the driver checks the DOM in a `requestAnimationFrame` callback and, once it holds, posts a `MessageChannel` message, whose handler runs after that frame is rendered.

| Metric                               | How                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First paint after the space connects | From opening the pod list in the space the driver opened to its first rows painted: the list waits for the space's discovery, which starts as the space opens, before the list, then Rust lists every pod                                                                                                     |
| Change → painted cell, p95           | The churn's log (pod, restart count, patch sent in Unix ms) joined by pod and count with the driver's paints of the Restarts cells on screen (pod, count, painted in Unix ms, `performance.timeOrigin` plus the frame's end); a count painted that the log lacks, as one a failed patch set, is counted apart |
| Scroll                               | Mean fps from `requestAnimationFrame` over 5 s of scrolling at 4,000 px/s; passes at 57 fps, 95 % of 60, since frames jitter                                                                                                                                                                                  |
| Sort                                 | Header click → the new order's first 10 rows painted, eight clicks over Age, Namespace, Name and Restarts, each ascending then descending, so that every click changes those rows on kwok's pods, and the last leaves pods the churn changes on screen; p95                                                   |
| Core RSS                             | Resident size of the app process under churn, with the list open                                                                                                                                                                                                                                              |
| Webview memory                       | Resident size summed over the `com.apple.WebKit.*` processes the app is responsible for but the GPU process; their physical footprint and the GPU process's each have a row of their own, never judged                                                                                                        |
| Visible CPU                          | CPU time of the app and its WebKit processes over 20 s with the window on screen, sorted by Restarts descending, while the driver sleeps; shown, never judged ([why](#the-visible-window))                                                                                                                    |
| Idle CPU                             | CPU time of the app and its WebKit processes over 30 s with the window hidden, as a share of one core; hidden, the list acknowledges no batch, so Rust coalesces the churn and sends nothing                                                                                                                  |

`twigo-bench report`, and so the harness, exits 1 when a judged row misses its target.
The pods of `bench/pods.sh` all run, so a Status sort would leave the first rows in the order of their ids either way, and the driver stops when a click leaves them as they were: the sort sequence is Status-free.

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
- Memory is the resident size (`ri_resident_size` of `proc_pid_rusage`), which counts the pages the processes share more than once; the footprint row is `ri_phys_footprint`.
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

`bench/harness.sh` without an argument, four times on 2026-11-07, at 18:08, 18:12, 18:16 and 18:20 UTC, on commit 48bffdd with nothing uncommitted, each on a kind 1.37 cluster with kwok that it created and deleted, with the screen unlocked.
The first three exited 0; the fourth exited 1, with core RSS at 153 MB ([run to run](#run-to-run)).
The first run's report:

2026-11-07T18:08Z, Apple M4 Max, 48 GB, macOS 27.2, release build, 48bffdd
Churn on kwok: 100.0 changes/s over 5000 pods for 148 s, 0 errors, patch p95 3.6 ms

| Metric                                       | Value       | Target   | Status            | What it measured                                                                                                                                                                                                                             |
| -------------------------------------------- | ----------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First paint after the space connects         | 292 ms      | < 1 s    | pass              | the pod list opened in the bench's space → its first rows painted: what remains of the space's discovery, which starts as the space opens, and the list of 5030 pods                                                                         |
| Change → painted cell, p95                   | 66.4 ms     | < 150 ms | pass              | the churn's patch sent → the new Restarts count painted, for rows on screen over 60 s, joined by pod and count through Unix ms; p50 41.6 ms, max 74.1 ms, n = 146; 0 paints not in the churn's log; 66 offscreen, 0 superseded, 0 timed out  |
| Scroll and sort: scroll                      | 60.0 fps    | 60 fps   | pass              | requestAnimationFrame over 5 s of programmatic scroll at 4000 px/s; frame p95 17.0 ms, display frame 17.0 ms; rows awaiting data in 0 of 300 frames                                                                                          |
| Scroll and sort: sort                        | p95 34.0 ms | < 50 ms  | pass              | header click → resorted rows painted, Age↑ Age↓ Namespace↑ Namespace↓ Name↑ Name↓ Restarts↑ Restarts↓; p50 31.0 ms, max 34.0 ms, n = 8                                                                                                       |
| Core RSS with the pod list open              | 146 MB      | < 150 MB | pass              | resident size of twigo (pid 11818) under churn with the list open, its row store, query view and batcher included, the median of 5 samples                                                                                                   |
| Webview memory with the pod list open        | 245 MB      | < 300 MB | pass              | resident size of the WebKit processes the app is responsible for but the GPU process (Networking 12 MB, WebContent 234 MB), under churn, the median of 5 samples; 1 other WebKit processes left out                                          |
| Physical footprint                           | 262 MB      | -        | shown, not judged | the same processes' physical footprint (Networking 6 MB, WebContent 256 MB), the median of 5 samples; it leaves out pages WebKit reused and counts graphics that resident size does not, so it swings between runs (docs/bench.md)           |
| GPU process                                  | 263 MB      | -        | shown, not judged | physical footprint of the app's WebKit GPU process, the median of 5 samples; any page that repaints holds about 260 MB there, WebKit's pool of IOSurfaces, so it stays out of the budget (docs/bench.md)                                     |
| Visible CPU, 100 changes/s, window on screen | 10.86 %     | -        | shown, not judged | CPU time of the app and its 3 WebKit processes over 20 s, as a share of one core; sorted by Restarts descending, the rows the churn changes on screen, while the driver sleeps; it swings between runs, so nothing judges it (docs/bench.md) |
| Idle CPU, 100 changes/s, window hidden       | 1.01 %      | < 2 %    | pass              | CPU time of the app and its 3 WebKit processes over 30 s, as a share of one core; document hidden; hidden, the webview acknowledges no batch, so Rust coalesces the churn and sends nothing                                                  |

The other three: first paint 293, 242 and 295 ms, change → painted cell p95 65.3, 63.7 and 65.5 ms, scroll 60.0 fps, sort p95 38, 32 and 33 ms, core RSS 147, 144 and 153 MB, webview memory 249, 244 and 246 MB, footprint 251, 194 and 196 MB, GPU process 263, 264 and 264 MB, visible CPU 12.11, 12.39 and 12.07 %, idle CPU 1.37, 1.45 and 1.45 %.

On b5aa3f8, with kube 4.2 and the window on top of the desktop, three runs at 13:32, 13:35 and 13:39 UTC exited 0: first paint 292, 244 and 242 ms, change → painted cell p95 63.9, 62.4 and 62.1 ms, scroll 60.0, 60.1 and 60.0 fps, sort p95 33, 33 and 34 ms, core RSS 141, 144 and 142 MB, webview memory 246, 273 and 253 MB, footprint 220, 250 and 180 MB, GPU process 262, 263 and 262 MB, idle CPU 1.30, 1.69 and 1.31 %.

### Run to run

Ten runs on b5aa3f8's day before the visible window's work: those three, and seven on the code before the batcher's and the decoder's last fixes, at e795d43, four of those with a driver patch that does nothing unless a build variable asks.

- **Idle CPU:** 0.97 to 1.71 %.
  In the six runs whose split was kept, the app took 0.96 to 1.36 %, WebContent 0.10 to 0.42 % and the GPU process 0.05 to 0.16 %.
- **Sort p95:** 32 to 35 ms.
- **Webview memory:** nine runs between 246 and about 287 MB, one about 375 MB, with WebContent at 343 MiB and its footprint down to 167 MiB by the last sample; resident size is a high-water mark, so that is a higher peak, whose cause was not measured.
  The seven earlier runs kept WebContent's resident size only, so their sums add the 15 MB of the Networking process.
- **Footprint:** 180 to 404 MB, the 404 MB with 235 MiB resident; that state did not come back in the runs that recorded `footprint -p`, so what it held is not known.
- **Core RSS:** on kube 5, in the fifteen harness runs on fresh clusters of [the visible window's work](#the-visible-window), 140 to 147 MB and once 153 MB, against 141 to 144 MB in those three on kube 4.2; whether kube 5 moved it was not measured.
- The driver stopped one run in about forty with `no rows sorted by Restarts descending`, in a build whose clock of ages was switched off for a measurement; not investigated.

### What moved them

Each from runs of that day, before and after on the same machine.

| Change                                               | Row                                | Before       | After        |
| ---------------------------------------------------- | ---------------------------------- | ------------ | ------------ |
| The clock of ages stops while hidden                 | Idle CPU                           | 4.41, 4.44 % | 1.33, 1.32 % |
| The same                                             | WebContent, idle                   | 2.00, 2.14 % | 0.12, 0.13 % |
| `natural` compares without allocating                | The first apply of a sort, in Rust | 12.5–17.2 ms | 7.4–11.0 ms  |
| A row mounts its actions only when they can be used  | Sort p95                           | 45–54 ms     | 32–35 ms     |
| The same                                             | WebContent's resident size         | 376–707 MiB  | 221–343 MiB  |
| The same, on the mock in Chromium, over the scroll   | JS allocated                       | 2,616 MB     | 368 MB       |
| A table's watch event reads in one pass, on a P-core | A line's decoding                  | 9.3 µs       | 2.75 µs      |

The batcher and the kubeconfig debouncer stopped waking without work: 6 and 7 active samples each in 79 and 86 before, 0 and 1 in 75 after, in 6 s of `sample` at 1 ms; the idle row is too noisy to show it.

### Why the targets moved

Serhii decided on 2026-11-07, once the waste above was gone:

- **Idle CPU, 1 % to 2 %.**
  Ten runs of one code spread from 0.97 to 1.71 %, so 1 % judged noise.
  In 70 s of `sample` at 1 ms on three runs, 2,920 active samples of the hidden app before the decoder's fix: the HTTP/2 task 33 %, with `recvfrom` 13 %; the upstream task 42 %, with decoding 26 %; tokio parking 18 %; no function stands out.
  Each change is one watch event of 2,373 bytes at the median, 1,680 of them `managedFields`, and a Table comes as JSON or YAML only ([rest.go at v1.37.0](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/rest.go#L144-L150)).
  Going lower takes closing watches while hidden, a product decision, or reading the socket in bursts, which no HTTP/2 client we found ships.
- **Webview memory, from footprint to resident size**, for the reasons [below](#on-the-rust-path).

The app's share is not a regression of M1's later steps: 50d1f8f, before them, took 1.25 % in two runs that day, against 0.68 to 0.75 % on 2026-11-02 on macOS 27.0, on PR #21's code.
macOS 27.2 and the state of the machine were not told apart.

### The visible window

Measured on 2026-11-07 on an Apple M4 Max with macOS 27.2, as a share of one core, the app and its WebKit processes together, on a kind 1.37 cluster with kwok and 5,000 pods.

First with a driver patch, not committed, that opened the pod list and slept, on one cluster, the page a few seconds old, at 100 changes/s or with the churn stopped by SIGSTOP, in 20 s windows:

| Build                                  | By Name, 100 changes/s | No changes | Runs |
| -------------------------------------- | ---------------------- | ---------- | ---- |
| 673d868                                | 12.5–14.5 %            | 1.4–2.5 %  | 3    |
| 673d868 without the flash              | 5.6–6.2 %              | 1.5–2.2 %  | 2    |
| 067d5f4, the flash on the compositor   | 5.4–7.0 %              | 1.7–2.4 %  | 4    |
| 067d5f4 without the clock of ages      | 5.4–7.6 %              | 0.5–0.7 %  | 2    |
| 3237f23, also only an age on the clock | 6.6–7.3 %              | 0.7–1.4 %  | 4    |

Then with the harness, which samples this for 20 s after its driver has run for over two minutes, on a fresh cluster each, between 17:10 and 18:20 UTC, on this branch's commits up to 48bffdd; the old flash at 17:22, 17:39 and 17:59, reverted on top of them:

| Flash                                 | By Restarts, 100 changes/s                               | By Name, 100 changes/s |
| ------------------------------------- | -------------------------------------------------------- | ---------------------- |
| On the compositor                     | 5.8, 8.4, 9.2, 9.4, 10.9, 12.1, 12.1, 12.2, 12.4, 13.7 % | 4.6, 4.8 %             |
| 673d868's, on the same code otherwise | 18.4, 26.1 %                                             | 7.2 %                  |

- **The flash.**
  A `background-color` keyframe repaints the page on every frame of the second after a change, so one change a second kept the whole pipeline at the display's rate.
  By Name, in one run, by thread through `proc_pidinfo`: WebContent's main thread 6.6 %, the GPU process's 1.6 % and the app's 1.5 %.
  With `opacity` on a layer behind the text, which runs on the compositor, in one run of 3237f23: 2.1, 0.3 and 0.5 %.
  It looks the same: the tint within 1 of 255 per channel at six times of the animation, in Chromium and Playwright's WebKit, in both themes, with the pill's bottom edge one device pixel apart in WebKit; a capture of the bench window shows it in a real WKWebView.
- **The clock.**
  With no changes, the clock of ages was what woke the page: every list rendered its whole window each second for its Age column.
  Only an age holds the clock now, on one timer for the page.
- **By Restarts the numbers depend on the cluster.**
  Three runs of 673d868 on one cluster read 26.4, 23.9 and 20.4 % over ten minutes, falling as it aged, which fits fewer rows changing places once the top counts are high; not proven.
  So the first table leaves that order out: its builds ran on a cluster of different ages.
- **Why nothing judges the row.**
  No limit tells the two rows of the second table apart with room for their noise, by Restarts or by Name, so the report shows the number.
  A test holds each cause instead, in CI, where the bench does not run: `theme.test.ts` that the flash animates only opacity, `seconds passing render the ages and not the grid` that the list leaves the clock alone.
- **What is left.**
  By Name, in that run of 3237f23: the app's tokio workers 1.6 %, as hidden, WebContent's main thread 2.1 % and its JIT 0.7 %.
  `sample` counted JavaScript in 36 of that thread's 66 active samples by Name and 50 of 116 by Restarts, so a row memo in `DataGrid` could take at most about half of it; not tried.
- **`sample` undercounts.**
  It found WebContent's main thread active in 2.1 % of its samples where `proc_pidinfo` read 6.6 %, so its counts only split a thread's work.
- **The first measurement.**
  On e795d43, one run each, the window on top of a desktop in use, it read 21.7 and 3.9 %, and 8.0 and 9.9 % with no changes as the flash and the clock were switched off.
  The table's runs do not repeat that rise; the desktop in use is the likely cause, not proven.

### The first runs on the Rust path

On 2026-11-02, on macOS 27.0, on PR #21's code, the same harness gave first paint 231 and 331 ms, change → painted cell p95 62.6 and 59.1 ms, sort p95 34 ms, core RSS 136 and 137 MB, webview footprint 175 and 388 MB, and idle CPU 1.47 and 1.38 %.

Earlier runs that day, before the review's fixes, at 17:49 and 17:57 UTC on 967df1f with uncommitted changes, also missed sort (p95 71 and 59 ms) and webview footprint (400 and 435 MB); whether the batcher's holding its first batch for the first window is why sort passed since was not measured.
The 17:49 run sorted by Name descending last, which put the cluster's own pods on screen, so no change the churn made was there to be painted and the change row had no samples.
A run between them hung: the bench app had kept the first run's pod list open in its state, so the list subscribed before the driver opened it and the driver waited for a subscription that never came; the harness now deletes the bench app's state before each run, and the driver's waits time out with what they waited for.

## Results at 5k pods on the mock

The webview on the mock backend, before M1 step 7: `bench/harness.sh` without a kubeconfig, with the screen unlocked, on 2026-11-01 at 12:25 UTC.
The report then judged nothing measured on the mock, and showed the webview halves of first paint and change → painted cell apart:

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
The bench window then stayed above other windows; since 2026-11-07 [a covered window paints](#the-window).

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
  The mock's churn adds 130–220 MB more, much of it WebKit Malloc that `footprint` shows as reclaimable.
  The mock reran the query over every pod on each change in JS, which looked like the cause, but on the Rust path, where the webview gets only patches, it was the [scroll](#on-the-rust-path).
- **Not a cache.**
  `vmmap -summary` of the GPU process, with the pod list under churn, showed its 227 MB of owned graphics memory dirty, with 0 K volatile: the kernel cannot drop it, so it is the system's real cost, not a cache.
  `memory_pressure -S`, which would have simulated the system's pressure notification, needs root and changed nothing.
- **The budget.**
  3.8's 300 MB counted every WebKit process, so the GPU pool alone took most of it on any live page.
  From 2026-11-01 the budget counts the WebKit processes but the GPU process, and the report shows the GPU process on a row of its own, never judged: re-reported with that split, the 12:25 run's webview memory is 425 MB, and its GPU process 262 MB.

### On the Rust path

Measured on 2026-11-07 with WebKit 22625.2.8.11.9, on the commits before a row's actions mounted lazily, in one run each of the driver cut down, WebContent only, in MiB: footprint and resident size from `twigo-bench sample` every second, every fourth kept, allocated from the `WebKit Malloc` zone in `vmmap -summary`, about 20 s into the steady phase and 37 s after hiding.

| Driver                 | Highest footprint | Resident | Allocated, steady | Allocated, hidden |
| ---------------------- | ----------------- | -------- | ----------------- | ----------------- |
| Open, churn only, 60 s | 189               | 213      | 125               | 66                |
| Eight sorts            | 338               | 360      | 97                | 81                |
| Scroll, 5 s            | 607               | 457      | 340               | 101               |
| Scroll and sorts       | 584               | 468      | 104               | 99                |

- **What holds it.**
  Churn does not: the scroll does, with footprint up by 300 to 440 MiB in its first 2 s.
  `heap` after the scroll: 18,011 blocks of 16 KB, 281 MiB of the zone's 340 MiB, are JavaScriptCore's heap; 2,963 of them, 46 MiB, 37 s after hiding.
  Everything native is small, such as `WebCore::RenderBlockFlow` at 126 KB.
- **What allocated it.**
  `HeapProfiler.startSampling` in headless Chromium, on the mock's 5,000 pods, counting collected objects: 8.7 MB a frame in the scroll, in Radix's Tooltip, Slot and Presence and in Lucide's icons, as every row of the window mounted a menu and one Tooltip per inline action on every frame.
  A row now mounts them only when they can be reached: 1.2 MB a frame, and WebContent's zone holds 75 to 143 MiB in the steady phase.
- **Why it stays.**
  On 16 GB or more, JavaScriptCore lets the heap grow by `3e^(-2x)+1`, about 4× for a small heap ([Heap.cpp](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/JavaScriptCore/heap/Heap.cpp#L180-L197), [OptionsList.h](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/JavaScriptCore/runtime/OptionsList.h#L223-L224)).
  That fits what was measured, not proven: 340 MiB stayed allocated for 60 s after the scroll under slow churn, and 101 MiB remained after hiding.
- **Why footprint misleads.**
  libpas marks freed pages with `MADV_FREE_REUSABLE` and never calls `MADV_FREE_REUSE` ([pas_page_malloc.c](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/bmalloc/libpas/src/libpas/pas_page_malloc.c#L458-L505)), which should leave pages written again off the ledger; the kernel of macOS 27.2 is not published, so that step is not verified.
  What was measured: one run read a footprint of 207 MiB with 327 MiB allocated in the zone, while dirty plus reclaimable stays constant within a process as the split moves, 578+91 MiB in the steady phase and 133+539 MiB after hiding.
  It also counts graphics that resident size does not: 36 to 71 MiB dirty of `Owned physical footprint (unmapped) (graphics)`.
- **From 2026-11-07 the budget judges resident size**, and the report shows footprint on a row of its own, never judged.
  Resident size is the high-water mark of what the page touched, so it follows the allocations above, and it does not depend on when the allocator last returned pages.

## What is left

- **20k and 50k pods.**
  The columns of 3.8 need `bench/pods.sh` at those counts; no run has judged them.
- **CI, with the release work.**
  The harness needs a logged-in, unlocked GUI session; whether GitHub's macOS runners give one is not verified.
  Linux needs the sampler's WebKitGTK branch and a display, as `bench/ipc/linux.sh` gets from Xvfb in Docker, whose numbers say nothing about a Linux desktop.
  A workflow would build once, run the harness per pod count, fail when it fails, and keep `report.json` as an artifact.
