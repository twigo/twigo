# Checks and gotchas

## Commands

- Rust, one crate: `cargo test -p twigo-cache`, `cargo clippy -p twigo-cache --all-targets -- -D warnings`, `cargo fmt --all --check`.
- One Rust test: `cargo test -p twigo-cache --test table_fixtures <name>`.
- Frontend: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm format:check`; one package: `pnpm --filter @twigo/workbench test`.
- The app: `TWIGO_KUBECONFIG=<kind kubeconfig> pnpm tauri dev`; the CI build is `pnpm tauri build --debug --no-bundle`.
- The UI on the mock backend: `pnpm --filter @twigo/desktop dev`, then http://localhost:1420/ in a browser; `?scenario=forbidden` pins a view state (`MOCK_SCENARIOS` in `packages/protocol/src/mock`), `?scenario=deviceCode`, `browser`, `pluginFailed`, `untrusted` or `review` pins prod-eu's credentials, `?scenario=policyFile` puts `prod-*` under an admin's policy file, and `?layout=french` picks a keyboard layout (`MOCK_LAYOUTS`).
- The TypeScript of the IPC types: `TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript`.
- The mock's keyboard layouts: `cargo run -p twigo-keyboard --example record` on a Mac reads installed layouts without selecting them and rewrites `packages/protocol/src/mock/layouts`.
- The mock's resources: `TWIGO_TEST_KUBECONFIG=<kind kubeconfig> cargo run -p twigo-kube --example record_discovery` rewrites `packages/protocol/src/mock/resources.json` from the cluster's discovery, as `resources_watch` answers it.
- The mock's objects: `TWIGO_TEST_KUBECONFIG=<kind kubeconfig> cargo run -p twigo-core --example record_objects` applies an object of each core kind to the namespace `overview` of a kind cluster with kwok, waits for the states it records (a rollout, a crash loop in its back-off, an image that cannot be pulled, a finished Job, a CronJob that ran: a few minutes on a fresh cluster), and records each with its events and what its describer needs into `crates/twigo-describe/tests/fixtures`; then `TWIGO_UPDATE_OBJECTS=1 cargo test -p twigo-describe --test overviews` describes them into `packages/protocol/src/mock/objects.json`, and writes what a Reveal of each recorded Secret's keys answers into `revealed.json` beside it.
- twigo-keyboard on Linux: `crates/twigo-keyboard/linux/run.sh` runs its tests in Docker, the live X11 test under Xvfb and the live Wayland test under a headless sway included; given a command, such as `cargo clippy -p twigo-keyboard --all-targets -- -D warnings`, it runs that instead.
- twigo-netmon on Linux: `crates/twigo-netmon/linux.sh` runs its tests in Docker, the ignored ones included; CI runs the netlink one as root in a network namespace of its own.
- twigo-keyboard on Windows: after `rustup target add x86_64-pc-windows-msvc`, `cargo clippy -p twigo-keyboard --target x86_64-pc-windows-msvc --all-targets -- -D warnings` checks the code; nothing runs it yet (D2).
- Live tests against kind, one release: `export TWIGO_BENCH_DIR=$(mktemp -d)`, then `bench/test-matrix.sh 1.37`.
  Without an argument it runs every supported release.
- A cluster to keep: `export TWIGO_BENCH_DIR=$(mktemp -d)`, `kubeconfig=$(bench/cluster.sh up <name> 1.37 | tail -1)`, then `TWIGO_TEST_KUBECONFIG=$kubeconfig cargo test -p twigo-cache -p twigo-kube -p twigo-core -p twigo-bench -p twigo-sessions -- --ignored`, and `bench/cluster.sh down <name>` with the same `TWIGO_BENCH_DIR` when done.
- `bench/harness/tests/view_live.rs` creates `bench/bench` at 5,000 pods, runs `twigo-bench churn` for 20 s and deletes the namespace `bench`, so it refuses a cluster that has it already, such as one the bench harness scaled.
- The IPC bench: `export TWIGO_BENCH_DIR=$(mktemp -d)`, then `bench/ipc/run.sh frames` or `bench/ipc/run.sh cost 3` on macOS, and `bench/ipc/linux.sh frames` for WebKitGTK in Docker.
  Each run opens a window and exits by itself.
- The bench harness ([bench](../../docs/bench.md)): `export TWIGO_BENCH_DIR=$(mktemp -d)`, then `bench/harness.sh` on macOS with the screen unlocked; it creates and deletes its cluster, or takes the kubeconfig of one that `bench/pods.sh` scaled to 5000.
  The app takes no focus and its window stays at the screen's left edge, behind other windows, so the desktop stays in use; the report prints, and its JSON lands in `$TWIGO_BENCH_DIR/harness`.
- The bench app alone: `pnpm tauri build --no-bundle --features bench --config src-tauri/tauri.bench.conf.json`, then `TWIGO_BENCH=<dir> target/release/twigo-bench launch target/release/twigo`.
- State across ⌘Q and a restart, on macOS with the screen unlocked: `bench/restart.sh <kind kubeconfig>` after the debug build; it runs the app with a temporary `HOME` and presses keys through System Events, which needs the terminal's Accessibility permission.
- The churn generator alone: `cargo run --release -p twigo-bench -- churn --kubeconfig <path> --rate 100 --seconds 60 --log churn.jsonl`.
- The hub's live tests sit in the library (`crates/twigo-cache/src/hub/live.rs`) and run with the others under `--ignored`; `crates/twigo-cache/tests/restart_live.rs` restarts the API server of a kind cluster through `docker exec … crictl stop`, so it refuses kwok contexts and waits for the controller manager before it ends.
- `crates/twigo-core/tests/bus_live.rs` runs the kubectl command of each plan through `sh`, with `KUBECONFIG` set to a copy of the test's kubeconfig, so it needs kubectl on `PATH`.
- The logs' live tests (`crates/twigo-sessions/tests/logs_live.rs`) and `objects_live`'s crash loop need a kubelet, so they refuse contexts other than `kind-*`.
  Their pods run on kind's node from its `docker.io/kindest/local-path-helper` image with `imagePullPolicy: Never`, so nothing is pulled; it has bash and no other command, so their scripts sleep by reading a coprocess that never writes, and a forced restart is `crictl stop` through `docker exec`.
- The hub's heap at 5,000 pods: `bench/pods.sh <kubeconfig> 5000`, then `TWIGO_TEST_KUBECONFIG=<kubeconfig> cargo run --release -p twigo-cache --example hub_memory`, next to `--example table_memory`.
- Before a push, run only the checks the change affects.
  CI runs the rest, the live tests on every release when `twigo-cache`, `twigo-kube`, `twigo-policy`, `twigo-core`, `twigo-sessions`, `bench/harness`, `bench/cluster.sh`, `bench/pods.sh` or the Cargo files change, and the frame probe on WebKitGTK when `bench/ipc` or the Cargo files change.

## Gotchas

- On macOS a debug build's debug info stays in `.rcgu.o` files beside it (`split-debuginfo = "unpacked"`), and every incremental build leaves its own in `target/debug/deps` without removing the old ones.
  At 492,498 of them (3 days of work, 2026-11-03) starting an FSEvents stream in a test binary there took 1–3 s, the same binary copied to `target/debug` 0.5 ms, so twigo-kube's kubeconfig watcher tests, which start one per watch and unwatch, timed out in parallel.
  When they time out locally, count the files (`find target/debug/deps -maxdepth 1 | wc -l`) and `cargo clean`.
- pnpm 12 comes from `packageManager`, and pnpm installs the Node of `devEngines.runtime`.
  An install fails on a package younger than a day (`minimumReleaseAge`): pin the previous version instead of excluding the new one.
- `tsc` is TypeScript 7 (`@typescript/native`), while `typescript` is `@typescript/typescript6`, the API typescript-eslint needs.
  Keep both aliases.
- The app reads the kubeconfigs kubectl reads, the user's real clusters among them, unless `TWIGO_KUBECONFIG` names one file: in debug and bench builds only that file's `kind-*` and `kwok-*` contexts count, so development and tests always set it.
  With a `HOME` of its own the app also keeps its state and window position apart, since Tauri finds the app-data directory through `HOME`.
- The hub's unit tests run on paused time against `crates/twigo-cache/src/fake.rs`, over `Clients::over` (the `test-util` feature of twigo-kube): a wait without a bound loops forever there, as time jumps to the next idle timer, so every wait goes through `until`, which gives up after ten virtual minutes.
  A state the fake passes through at once cannot be awaited: hold it there, as `hold_initial` holds a streaming list.
- Kubernetes clients come only from `twigo_kube::client::Clients`: `api` speaks HTTP/2, `sessions` HTTP/1.1 for exec, attach and port-forward.
  `api` counts its streams, 24 watches at most by default, so a test or tool that opens more raises `Options::budgets`, or its watches wait.
  Never `Config::infer()`, `~/.kube/config` or the current context: tests and examples read `TWIGO_TEST_KUBECONFIG` and refuse contexts other than `kind-*` and `kwok-*`.
- `Clients::new` takes the gate of the context it is for, so no client goes around the policy: the app's comes from `Policy::gate`, and tests and tools that own their clusters pass `Gate::unrestricted()`.
- Tauri runs a plain `#[tauri::command] fn` on the main thread, outside its tokio runtime, where `tokio::spawn` panics; tests that call the core inside `#[tokio::test]` never see it.
  A core method that spawns is `async`, so its handler has to be too, as `command_execute` is.
- Exec plugins run only through `twigo_kube::credentials`, never kube's exec auth, which `Clients::new` strips.
  An unknown command may ask the person to sign in, so it runs only while a window has the focus: tests build their `Registry` with focus on, and the app runs a plugin only once its `HOME`'s `trust.json` lists it, else it starts with the review of untrusted plugins.
- k8s-openapi moves only together with kube: kube 5.0 requires `^0.29`.
  Dependabot bumps both in its `kube` group; a group PR that carries only k8s-openapi cannot build until a kube release requires that version.
- `windows` and `windows-core` move together and by hand: `#[implement]` expands to `::windows_core` paths, so twigo-keyboard names that crate directly, at the version `windows` uses.
  CI does not build for Windows, so its green says nothing about them and Dependabot ignores both; check a bump with the Windows `cargo clippy` command above.
- zbus stays on the major that `tauri-plugin-opener` and `tauri-plugin-single-instance` require, or Linux builds two D-Bus stacks; Dependabot ignores its majors until they move.
- A test that counts connections with `lsof` gets a test binary of its own, because `lsof` counts the whole process.
- On Linux a script this process wrote is busy (`ETXTBSY`) while a child forked meanwhile holds its descriptor until `exec`, and a spawn with `pre_exec` always forks, so twigo-env's tests have `cp` write their scripts.
  twigo-core's and twigo-kube's tests write theirs in-process; no such failure has been seen there.
- tauri-build fails unless the `isolation` features in `Cargo.toml` match the config's pattern, so each pattern of the IPC bench is a crate of its own: `bench/ipc/brownfield` and `bench/ipc/isolation`.
- Under the isolation pattern a `frame-src` must list the isolation frame's scheme, or every invoke waits forever.
  Tauri names it `isolation-<uuid>` anew on every build and adds it to `default-src` only, so `bench/ipc/isolation/src/main.rs` adds it to `frame-src` at startup from `Context::pattern()`.
- Files under `crates/*/tests/fixtures` are recorded server responses: never reformat or edit them by hand.
- `packages/protocol/src/mock/resources.json` is recorded by the `record_discovery` example from a cluster of `bench/cluster.sh up <name> 1.37`, which installs kwok's CRDs: never edit it by hand.
- `packages/protocol/src/mock/objects.json` is written by `twigo-describe`'s `overviews` test from the recorded objects: never edit it by hand.
  The same test writes `revealed.json`, the values a Reveal answers, and checks that `objects.json` holds none of them.
- kube-apiserver keeps events an hour (`--event-ttl`), so `record_objects` records objects older than that without their events: delete the namespace `overview` first, or record only the fixtures that changed and keep the others.
- `packages/protocol/src/mock/layouts/*.json` are recorded by `cargo run -p twigo-keyboard --example record`: never reformat or edit them by hand.
  `UCKeyTranslate` takes the keyboard type (`LMGetKbdType`), so a Mac with another keyboard may record other characters; the committed ones come from an ANSI keyboard, type 91 (2026-10-31).
- The live X11 test changes the X server's keymap and group, so it runs only where `TWIGO_TEST_X11_DISPLAY` equals `DISPLAY`, as under `xvfb-run`.
- The live Wayland test changes sway's keyboard, so it runs only where `TWIGO_TEST_WAYLAND_DISPLAY` equals `WAYLAND_DISPLAY`, as under `crates/twigo-keyboard/linux/wayland.sh`.
  Headless sway has no input devices, so the test gives its seat a virtual keyboard of its own and sets the keymap and the group through it: sway 1.11, unlike 1.9, applies no input config to a virtual keyboard, `swaymsg input … xkb_layout` included (`sway/input/keyboard.c`, `sway_keyboard_configure`), and Ubuntu 26.04, which `ubuntu-latest` became on 2026-11-04, ships 1.11.
- `crates/twigo-env/tests/live.rs` runs bash and zsh from `PATH` as login shells and fails if either is missing, so CI installs zsh.
  It runs without the test harness, because the shells re-run it with `--dump-env`.
- TIS must run on the main thread, so `crates/twigo-keyboard/tests/layouts.rs` runs without the test harness.
- Tailwind scans `packages/` through `@source "../../../packages"` in `apps/desktop/src/index.css`.
  A glob such as `packages/*/src` there generated no utilities from the packages (Tailwind 4.3.3, 2026-10-31).
- eslint-plugin-react-hooks warns that `useVirtualizer` cannot be memoized by React Compiler; the app does not run the compiler, so the warning stays visible rather than silenced.
- WebKit paints nothing while the screen is locked, with the display asleep or awake: the document turns `hidden` and `requestAnimationFrame` stops, so the bench driver fails at once rather than measure.
  A window that others cover turns `hidden` too, unless WebKit's occlusion detection is off, as in the bench ([bench](../../docs/bench.md#the-window)).
- A process started from a terminal has the terminal as its responsible process, and so do its `com.apple.WebKit.*` processes; `twigo-bench launch` starts the app responsible for itself, and `twigo-bench sample` refuses an app that is not.
- The bench build has the identifier `io.twigo.ide.bench`, so it shares neither the single-instance lock nor the window state with Twigo.
- WebContent's physical footprint misleads: pages WebKit reused stay off it and unmapped graphics count on it, so read resident size and the `WebKit Malloc` zone's allocated bytes in `vmmap -summary`; blocks of 16 KB in `heap` are JavaScriptCore's heap ([bench](../../docs/bench.md#on-the-rust-path)).
- `bench/` scripts run on macOS's bash 3.2: no associative arrays, and no `$(…)` inside a command's arguments where its failure must stop the script.
