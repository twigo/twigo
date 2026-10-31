# Checks and gotchas

## Commands

- Rust, one crate: `cargo test -p twigo-cache`, `cargo clippy -p twigo-cache --all-targets -- -D warnings`, `cargo fmt --all --check`.
- One Rust test: `cargo test -p twigo-cache --test table_fixtures <name>`.
- Frontend: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm format:check`; one package: `pnpm --filter @twigo/workbench test`.
- The app: `pnpm tauri dev`; the CI build is `pnpm tauri build --debug --no-bundle`.
- Live tests against kind, one release: `export TWIGO_BENCH_DIR=$(mktemp -d)`, then `bench/test-matrix.sh 1.37`.
  Without an argument it runs every supported release.
- A cluster to keep: `kubeconfig=$(bench/cluster.sh up <name> 1.37 | tail -1)`, then `TWIGO_TEST_KUBECONFIG=$kubeconfig cargo test -p twigo-cache -p twigo-kube -- --ignored`, and `bench/cluster.sh down <name>` when done.
- The IPC bench: `export TWIGO_BENCH_DIR=$(mktemp -d)`, then `bench/ipc/run.sh frames` or `bench/ipc/run.sh cost 3` on macOS, and `bench/ipc/linux.sh frames` for WebKitGTK in Docker.
  Each run opens a window and exits by itself.
- Before a push, run only the checks the change affects.
  CI runs the rest, the live tests on every release when `twigo-cache`, `twigo-kube`, the `bench/*.sh` scripts or the Cargo files change, and the frame probe on WebKitGTK when `bench/ipc` or the Cargo files change.

## Gotchas

- pnpm 12 comes from `packageManager`, and pnpm installs the Node of `devEngines.runtime`.
  An install fails on a package younger than a day (`minimumReleaseAge`): pin the previous version instead of excluding the new one.
- `tsc` is TypeScript 7 (`@typescript/native`), while `typescript` is `@typescript/typescript6`, the API typescript-eslint needs.
  Keep both aliases.
- Kubernetes clients come only from `twigo_kube::client::Clients`: `api` speaks HTTP/2, `sessions` HTTP/1.1 for exec, attach and port-forward.
  Never `Config::infer()`, `~/.kube/config` or the current context: tests and examples read `TWIGO_TEST_KUBECONFIG` and refuse contexts other than `kind-*` and `kwok-*`.
- k8s-openapi moves only together with kube: kube 4.2 requires `^0.28`.
  Dependabot bumps both in its `kube` group; a group PR that carries only k8s-openapi cannot build until a kube release requires that version.
- A test that counts connections with `lsof` gets a test binary of its own, because `lsof` counts the whole process.
- tauri-build fails unless the `isolation` features in `Cargo.toml` match the config's pattern, so each pattern of the IPC bench is a crate of its own: `bench/ipc/brownfield` and `bench/ipc/isolation`.
- Under the isolation pattern a `frame-src` must list the isolation frame's scheme, or every invoke waits forever.
  Tauri names it `isolation-<uuid>` anew on every build and adds it to `default-src` only, so `bench/ipc/isolation/src/main.rs` adds it to `frame-src` at startup from `Context::pattern()`.
- Files under `crates/*/tests/fixtures` are recorded server responses: never reformat or edit them by hand.
- `bench/` scripts run on macOS's bash 3.2: no associative arrays, and no `$(…)` inside a command's arguments where its failure must stop the script.
