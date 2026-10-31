# Spike: Tauri isolation and tier-2 frames

M0 step 4, 2026-10-31.
Two questions, from 6.7 and 7.3:

1. What does Tauri's isolation pattern cost on invoke and on Channels?
2. Can a tier-2 frame, sandboxed with an opaque origin, reach any IPC path on WebKitGTK?

**Answers.**

1. The pattern doubles the round trip of a 1 KB invoke (0.17 to 0.32 ms) and multiplies that of a 64 KB one by nineteen (0.30 to 5.8 ms).
   Channels lose 5 to 26 % of their unpaced throughput and nothing at 3.5's flush rate.
   That fits every budget of 3.8, but the pattern buys Twigo little, so Twigo stays brownfield ([below](#decision-brownfield)).
2. No, on WebKitGTK and on macOS, with either pattern.
   The frame reaches WebKit's message handler and Rust's request parser, but invokes nothing.
   Under brownfield the per-run invoke key stops it, and on the fetch path its `Origin: null` already does; under isolation decryption stops whatever carries a body, and the key or `Origin: null` stops an empty one.
   Tier 2 can ship on Linux under the conditions [below](#what-keeps-a-frame-out).

- Bench: `bench/ipc`, a library with the commands and the page, and two apps over it, `brownfield` and `isolation`, identical but for the pattern.
- Runs: `bench/ipc/run.sh cost 5` and `bench/ipc/run.sh frames 2` on macOS, `bench/ipc/linux.sh frames 2` for WebKitGTK in Docker.
- CI: `.github/workflows/webview.yml` runs the frame probe on ubuntu-24.04 whenever `bench/ipc` or the Cargo files change, so a Tauri or wry update that opens a path fails its PR, and every Monday, because the job installs WebKitGTK from Ubuntu's archive at run time.

## The bench

- tauri-build fails unless the `isolation` features of `tauri` and `tauri-build` in `Cargo.toml` match the config's pattern ([manifest.rs](https://github.com/tauri-apps/tauri/blob/tauri-build-v2.7.4/crates/tauri-build/src/manifest.rs#L30-L58)), so each pattern is a crate of its own.
- The page, `web/bench.js`, runs what `TWIGO_BENCH_IPC` asks for: `cost` or `frames`.
  It ends with `report`, which prints one JSON line and exits non-zero when a check fails.
- Both apps set the CSP that 6.7 plans for Twigo: the app's own, plus `frame-src 'self' twigo-ext:`.
  The isolation app adds its isolation frame's scheme to `frame-src` at startup ([below](#the-isolation-pattern-and-frame-src)).

**Cost.**

- `echo` takes a 1 KB or a 64 KB string and returns it: 100 warm-up calls, then 2,000 and 500 sequential calls.
  WebKit's `performance.now()` resolves 1 ms in both webviews (the page measures it), so a single call cannot be timed.
  The tables give the mean per call and the p95 of the means of 50-call blocks.
- Channels carry JSON batches of Table-like rows from Rust.
  The page acknowledges each `seq` with an invoke, as 3.5's flow control does, and Rust times each batch from send to ack.
  - Unpaced: the next batch leaves once the previous one is acknowledged.
  - Paced: every stream ticks on one 50 ms grid counted from the app's start (`interval_at`, `MissedTickBehavior::Skip`), so all streams of a case flush on the same tick: 20 streams of 4 KB batches, then 5 of 64 KB, 100 batches each.
  - Tauri evaluates a JSON message under 8,192 bytes straight into the page, and has the page fetch a bigger one with an invoke ([channel.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/channel.rs#L36), [L318-L319](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/channel.rs#L318-L319)).
    The 2 KB and 4 KB cases take the first path, the others the second.

**Frames.**

- The page loads two frames and waits for each one's report:
  - the control, same-origin with `sandbox="allow-scripts allow-same-origin"`, invokes `probe` through `parent.__TAURI_INTERNALS__`;
  - the probe, `twigo-ext://probe/probe.html` with `sandbox="allow-scripts"`, comes from a custom scheme like 5.3's tier-2 frames, but without a CSP of its own, so that only Tauri stands in its way.
    It tries every path in the table below, each request with a probe source of its own.
    A request without a body carries no source, so it calls `probe_without_body`, which counts as `frame:no-body`; the two such requests share that source, and their answers in the report tell them apart.
- A second after the probe reports, the window invokes `probe` itself, then checks the hook ([below](#decision-brownfield)).
- Rust counts `probe` calls per source.
  A run fails unless the control and the window ran it once each, no `frame:` source ran it at all, and the hook check gives its pattern's answers and counts: under brownfield both calls run `bypass`, under isolation only the payload-less one does ([below](#decision-brownfield)).
  The control shows that a frame which gets through is counted.
- The failures were seen on purpose on 2026-10-31 on macOS, brownfield unless named:
  - with the control's source renamed `frame:control`, the run exits 1 and names that source;
  - with the control also sending `probe_without_body` through `parent.__TAURI_INTERNALS__.postMessage` without a payload, the run exits 1 and names `frame:no-body`;
  - with the hook letting `bypass` through, the isolation run exits 1 and reports the hook check;
  - with the probe served same-origin under `allow-same-origin`, its `parent.__TAURI_INTERNALS__` call runs `probe`, and the run exits 1 when the probe's report does not come within 10 s.
    The report never comes because Tauri drops a request whose key is wrong without an answer ([webview/mod.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/webview/mod.rs#L2009-L2025)), and the probe's `ipc://` fetch with a guessed key, now from a valid origin, waits forever.

## Isolation pattern: the cost on macOS

`bench/ipc/run.sh cost 5`: release builds on macOS 27.0, Apple M4 Max, 2026-10-31.
The patterns alternate, and each runs five times; the tables give medians over the five runs.

| Invoke | Pattern    | Mean per call, ms | Range over 5 runs | Worst p95 of 50-call blocks |
| ------ | ---------- | ----------------- | ----------------- | --------------------------- |
| 1 KB   | brownfield | 0.17              | 0.16–0.19         | 0.28                        |
| 1 KB   | isolation  | 0.32              | 0.32–0.35         | 0.48                        |
| 64 KB  | brownfield | 0.30              | 0.29–0.31         | 0.36                        |
| 64 KB  | isolation  | 5.83              | 5.60–5.91         | 6.46                        |

| Channel               | Pattern    | Batches/s | MB/s  | Send → ack p50, ms | p95  | p99  | Max of 5 runs |
| --------------------- | ---------- | --------- | ----- | ------------------ | ---- | ---- | ------------- |
| 2 KB, unpaced         | brownfield | 5,280     | 10.7  | 0.18               | 0.23 | 0.35 | 2.35          |
| 2 KB, unpaced         | isolation  | 3,893     | 7.9   | 0.25               | 0.34 | 0.44 | 5.70          |
| 64 KB, unpaced        | brownfield | 2,059     | 128.8 | 0.46               | 0.59 | 0.71 | 7.34          |
| 64 KB, unpaced        | isolation  | 1,643     | 102.8 | 0.58               | 0.74 | 0.96 | 2.45          |
| 1 MB, unpaced         | brownfield | 463       | 463.1 | 2.08               | 2.73 | 3.18 | 5.26          |
| 1 MB, unpaced         | isolation  | 441       | 441.1 | 2.17               | 2.77 | 2.92 | 3.83          |
| 20 × 4 KB every 50 ms | brownfield | 401       | 1.6   | 1.87               | 3.93 | 5.52 | 20.01         |
| 20 × 4 KB every 50 ms | isolation  | 402       | 1.6   | 2.61               | 4.06 | 5.76 | 7.58          |
| 5 × 64 KB every 50 ms | brownfield | 100       | 6.3   | 1.76               | 3.46 | 5.27 | 13.19         |
| 5 × 64 KB every 50 ms | isolation  | 100       | 6.3   | 2.44               | 3.82 | 4.94 | 9.32          |

An earlier round of five the same day, before the paced streams shared one tick grid, gave invoke means of 0.15, 0.32, 0.29 and 5.26 ms, so rounds differ by up to 13 %.

- **Invoke.**
  The pattern adds 0.15 ms to a small invoke and 5.5 ms to a 64 KB one.
  The isolation frame encrypts the arguments with SubtleCrypto and turns the ciphertext into an array of numbers ([isolation.js](https://github.com/tauri-apps/tauri/blob/tauri-utils-v2.10.2/crates/tauri-utils/src/pattern/isolation.js#L45-L69)).
  That array travels by postMessage to the window, then as JSON text to Rust, which parses and decrypts it ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L462-L474)).
  Uniform bytes average 3.57 bytes of JSON each, so a 64 KB argument travels as about 229 KB.
- **Channels.**
  Rust's messages to the page pass no isolation frame.
  The acknowledgements do, as invokes, and so do the fetches of messages of 8 KB and more.
  Unpaced, that costs 26 % of the batches at 2 KB, 20 % at 64 KB and 5 % at 1 MB.
  At 3.5's flush rate every stream kept its 20 batches a second, and the p95 from send to ack rose by less than 0.4 ms.
- **Paced batches.**
  A paced batch takes about 2 ms from send to ack at p50 (1.9 ms brownfield, 2.6 ms isolation with 20 streams), against 0.18 and 0.25 ms unpaced.
  Twenty batches served one at a time at the unpaced rate would put the median 1.9 and 2.6 ms behind its tick, which matches; not measured further.
- **The budget.**
  6.7 asks that the pattern's cost stay within "the IPC budget", which the document never set.
  The budgets IPC serves are 3.8's: a change paints within 150 ms at p95, through a batcher that flushes every 50 ms.
  Both patterns stay far inside them: the worst p95 above is 6.5 ms.
- Not measured: the cost on Linux.
  Docker Desktop's VM with Xvfb says nothing about a Linux desktop, and the decision below does not rest on the cost.

## Decision: brownfield

The pattern's value is its hook: code that sees what the page sends through `invoke` before Rust does, in a realm the page's scripts cannot reach.
Tauri presents it as protection against a compromised frontend dependency.
For Twigo it adds little and costs something:

- Rust validates every command at the boundary, and the policy layer (6.4) and the approval broker decide every write.
  A hook in JavaScript would repeat checks that Rust must make anyway, and a compromised page could still send whatever the hook lets through.
- A static CSP cannot name its frame, so the app has to add the frame's scheme to `frame-src` at startup ([below](#the-isolation-pattern-and-frame-src)).
- A 64 KB invoke costs 5.5 ms more, and the hook's frame cannot load ES modules (Tauri's docs).
- The hook does not see everything.
  A page script can call `window.__TAURI_INTERNALS__.postMessage` without a payload ([ipc-protocol.js](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/scripts/ipc-protocol.js#L88-L90)).
  The request goes out with the real key and no body, since `JSON.stringify(undefined)` gives none ([process-ipc-message-fn.js](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/scripts/process-ipc-message-fn.js#L17-L44), [ipc-protocol.js](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/scripts/ipc-protocol.js#L29-L41)), and Rust decrypts only a body that is there ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L449), [L463](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L463)).
  So a command without required arguments runs past the hook: the empty JSON body becomes `{}` ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L525-L531)), and an `Option` argument arrives as `None` ([command.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/command.rs#L146-L157)).
  Measured on both platforms: the bench's hook refuses `bypass`, and under isolation `invoke("bypass")` gets no answer while the payload-less `postMessage` runs it; `report` fails a frames run when that changes, so CI notices a Tauri update that closes the gap.
- It opens a route of its own: the window forwards every isolation-shaped message, from any frame, to Rust with its invoke key ([ipc.js](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/scripts/ipc.js#L187-L209)).
  AES-GCM rejects a forged one, but a tier-2 frame gains a way into Rust's decryption that brownfield does not offer.

So Twigo stays brownfield, with capabilities scoped per window label and commands allowlisted (6.7), and Rust validating every argument.
Serhii decided so on 2026-10-31.

## Tier-2 frames

Runs on 2026-10-31, both patterns each:

- macOS: `bench/ipc/run.sh frames 2`, WebKit of macOS 27.0, two runs per pattern;
- WebKitGTK: `bench/ipc/linux.sh frames 2`, WebKitGTK 2.52.6 on Ubuntu 24.04.5 (aarch64) under Xvfb, in Docker Desktop on the same Mac, two runs per pattern;
- CI: the `Webview` workflow on PR #9, WebKitGTK 2.52.6 on GitHub's ubuntu-24.04 (x86_64) under Xvfb, one run per pattern ([run 41235234365](https://github.com/twigo/twigo/actions/runs/41235234365)).

In every run the control and the window ran `probe` once each, and no `frame:` source ran it.

Both platforms gave the same outcome on every path:

| Path the probe frame tries                                                                         | Outcome                                                                                                                     | What stops it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window.__TAURI_INTERNALS__`, `window.__TAURI__`                                                   | `undefined`                                                                                                                 | Tauri injects its scripts into the top frame only ([manager/webview.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/manager/webview.rs#L161-L166)).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `parent.__TAURI_INTERNALS__`                                                                       | `SecurityError`                                                                                                             | The opaque origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `window.ipc.postMessage`                                                                           | absent                                                                                                                      | wry defines `window.ipc` in the top frame only ([webkitgtk/mod.rs](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/webkitgtk/mod.rs#L352), [wkwebview/mod.rs](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/wkwebview/mod.rs#L692-L697)).                                                                                                                                                                                                                                                                                                                           |
| `webkit.messageHandlers.ipc.postMessage`: wrong, empty and no key, and a forged isolation envelope | the handler is there, and the messages reach Rust                                                                           | Brownfield: the invoke key, logged as `__TAURI_INVOKE_KEY__ expected … but received …` for the wrong key, the empty key and the envelope; without a key the message does not parse ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L236-L245)). Isolation: a plain message fails to parse as an isolation message, and the envelope parses and goes to AES-GCM ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L249-L289)); on this path only the count was observed. |
| `ipc://localhost/probe` fetch with a guessed key                                                   | brownfield `500 Origin header is not a valid URL`, isolation `500 missing field nonce`                                      | An opaque origin sends `Origin: null`, which is no URL ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L487-L495)); under isolation, decryption comes first ([L462-L474](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L462-L474)).                                                                                                                                                                                                                                                |
| `ipc://localhost/probe` fetch without a key                                                        | brownfield `500 missing Tauri-Invoke-Key header`, isolation `500 missing field nonce`                                       | The key header ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L479-L485)), or decryption first.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ipc://localhost/probe` fetch with a forged isolation envelope and a guessed key                   | brownfield `500 Origin header is not a valid URL`, isolation `500 AES-GCM`                                                  | Under isolation the body is decrypted before anything else, and AES-GCM rejects it ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L462-L474)); under brownfield, `Origin: null`.                                                                                                                                                                                                                                                                                                                                            |
| `ipc://localhost/probe_without_body` fetch with an empty body, with a guessed key and without one  | brownfield and isolation `500 Origin header is not a valid URL` with the key, `500 missing Tauri-Invoke-Key header` without | An empty body skips decryption under isolation ([protocol.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/ipc/protocol.rs#L463)), so the key header and `Origin: null` stop it under both patterns.                                                                                                                                                                                                                                                                                                                                                     |
| `parent.postMessage` with an invoke message                                                        | no effect                                                                                                                   | Tauri's window listens to postMessage only under isolation, and only for isolation-shaped messages ([ipc.js](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/scripts/ipc.js#L187-L209)).                                                                                                                                                                                                                                                                                                                                                                        |
| `parent.postMessage` with a forged isolation message                                               | no effect                                                                                                                   | Under isolation the window forwards it to Rust with its key, and AES-GCM rejects it: the frame has no AES key. On this path only the count was observed; the fetch above shows AES-GCM rejecting the same envelope.                                                                                                                                                                                                                                                                                                                                                                 |
| `parent.frames[i].postMessage`, reaching the isolation frame                                       | no effect                                                                                                                   | The isolation frame accepts messages from the window's origin only ([isolation.js](https://github.com/tauri-apps/tauri/blob/tauri-utils-v2.10.2/crates/tauri-utils/src/pattern/isolation.js#L109)).                                                                                                                                                                                                                                                                                                                                                                                 |

### What keeps a frame out

WebKit gives a sandboxed frame the page's script message handler, so a frame's message reaches Tauri on both platforms.
On WebKitGTK, wry hands Tauri every message with the main frame's URI ([webkitgtk/mod.rs](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/webkitgtk/mod.rs#L743)): that is why Tauri documents that on Linux it cannot tell a frame's request from the window's.
On macOS wry passes the frame's own URL ([wry_web_view_delegate.rs](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/wkwebview/class/wry_web_view_delegate.rs#L49-L60)), but a frame served from a scheme the app registers counts as local too ([webview/mod.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/webview/mod.rs#L1978-L1985)).
So on neither platform does the capabilities' local/remote split separate a tier-2 frame from the app.

Under brownfield, what does is the invoke key: 16 random bytes per run ([lib.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/lib.rs#L1281-L1285)), held in a closure of the top frame's IPC script ([ipc-protocol.js](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/scripts/ipc-protocol.js#L12)) and compared before the ACL is consulted ([webview/mod.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/webview/mod.rs#L2009-L2025)).
It stays out of a frame's reach as long as:

- a tier-2 frame never gets `allow-same-origin` and never shares the app's origin (the control frame shows what happens otherwise);
- no top-frame code hands a frame the key, `__TAURI_INTERNALS__` or a function that invokes;
  the relay of 5.3 passes data, never functions, and accepts a message only when `event.source` is that extension's frame, as the bench's `runFrame` does;
- the probe keeps running in CI on every update of Tauri and wry, and weekly for WebKitGTK.

The frame's own deny-by-default CSP of 5.3 would add a layer the probe went without: `connect-src 'none'` stops the `ipc://` fetch inside the frame.
Not measured.

Windows is not covered: WebView2 passes messages its own way, not checked here, and gets the same probe once D2's Windows work starts.

## The isolation pattern and `frame-src`

Tauri serves the isolation frame from `isolation-<uuid>://localhost`, with a UUID drawn anew on every build ([embedded_assets.rs](https://github.com/tauri-apps/tauri/blob/tauri-codegen-v2.7.4/crates/tauri-codegen/src/embedded_assets.rs#L222)), and adds that origin to the page's `default-src` only ([manager/mod.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/manager/mod.rs#L430-L437)).

- A `frame-src` that does not list that scheme blocks the isolation frame, and every invoke then waits forever.
  The first isolation runs of this bench hung that way with `frame-src 'self' twigo-ext: isolation:`, and so did `frame-src *` and `frame-src isolation:`.
  A `securitypolicyviolation` listener reported `frame-src blocked isolation-90a31318-…://localhost`.
- A static CSP cannot name a scheme that changes with every build, but the app can read it before it runs.
  `Context::pattern()` returns the pattern with its `schema` ([lib.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/lib.rs#L494-L498), [pattern.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/pattern.rs#L22-L27)), and Tauri builds the page's CSP from the runtime config on every asset request ([manager/mod.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/manager/mod.rs#L361-L373)), from `devCsp` in dev builds when it is set.
  `bench/ipc/isolation/src/main.rs` adds the scheme to `frame-src` before `run`, and the isolation runs above passed that way.

## Changes to the architecture

- 3.5: what a Channel carries with acknowledgements, from the table above.
- 6.7: the isolation pattern stays off, with the reasons of the decision; a tier-2 frame is kept out by the invoke key alone, under the conditions [above](#what-keeps-a-frame-out); Windows needs the `http(s)://<scheme>.localhost` form of `twigo-ext:`.
- 7.2: the frame probe joins the Windows work.
- 7.3: tier 2 may ship on Linux, and CI repeats the probe.
- 2.2: `bench/ipc`.

## Reproducing

```bash
export TWIGO_BENCH_DIR=$(mktemp -d)
bench/ipc/run.sh cost 5      # macOS, release builds; opens a window per run
bench/ipc/run.sh frames 2    # macOS
linux=$(mktemp -d)
TWIGO_BENCH_DIR=$linux bench/ipc/linux.sh frames 2  # WebKitGTK in Docker
```

Each run leaves `<mode>-<pattern>-<run>.json` and `.log` in `$TWIGO_BENCH_DIR/ipc`, the Linux runs in `$linux/ipc`.
