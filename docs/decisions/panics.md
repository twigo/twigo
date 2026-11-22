# A panic is contained where it happens, and what cannot be kept ends Twigo on purpose

Decided 2026-11-21.

## Decision

- `panic = "unwind"` stays, as Cargo's default.
  One hook, `twigo-log`'s, records every panic first.
- **The app-wide duties** run under `twigo_panic::Supervisor`, which `Core::start` builds: the catalog's sources, the contexts seen, the terminals' offers, the end of unlocks, the forwards' modes and the network, each a task of its own.
  A duty that panics starts again, at most 3 times in 5 minutes (VS Code's numbers for its extension host), with a line that names the duty and the task's id; the fourth panic in that window takes the fatal path.
  A duty that ends without a panic is logged and not started again.
  The kubeconfig watch and the state writer are threads: they say that they panicked to the same supervisor through a `Reporter`, which starts the watch again or lets the writer go on, and takes the fatal path once the state lock is poisoned.
  The policy proxy's accept loop takes the fatal path at once, since its listener goes with it and its address is in every proxy kubeconfig.
- **An item** that a person opened, a list, an open object, a logs tab and each of its streams, a pod shell, a local terminal, a forward's data path, runs under `twigo_panic::contain`.
  Its owner keeps the sender and the state the end needs outside the item, and sends the end the item already has, with `internal.panic`: a list's last batch changes only its state to `error`, an object's and a logs tab's likewise, a shell and a terminal end `Failed`, a container's stream says `error`, and a forward is `failed`, which a resume starts again as a new data path.
  Nothing starts an item again; the webview's next subscribe, or the person's resume, does.
  A hub upstream that panicked ends `Failed`, which the hub's existing path for an ended upstream starts for the next list, and a store that a panic under its lock poisoned is emptied and cleared before that relist.
- **A plan** whose run panics ends `Failed` with `internal.panic`, with an `ended` line of the outcome `failed` in the audit log and its bus entry and undo freed.
  It is never retried, since a write must not go out twice.
- **A command**: an async one runs through `contained()` and answers `internal.panic`.
  The invoke handler runs under `catch_unwind`, and a panic of a sync command takes the fatal path.
  The panic is caught around the generated handler, not through the fields of Tauri's `Invoke`, which Tauri marks as not stable.
- **The fatal path** writes the log, then shows a native dialog through `tauri-plugin-dialog` that says Twigo must restart, with Restart and Quit; Restart calls `AppHandle::request_restart`.
  It is native because the webview may be what the panic broke.
  In tests the callback it is given panics.
- A task that must run to its end is joined with `twigo_panic::joined`, which raises its panic again with its own payload, so the hook records it once; never `.expect("… does not panic")`.
- No `expect` or `unwrap` sits on an error that carries input text: a `KubeconfigError` quotes the lines of the file.
- One seam, behind the `inject` feature of `twigo-panic`: a name armed with `inject::arm` makes the supervisor's duty, `contain`'s item or a few other sites of that name panic, once armed in a test's own runtime (so tests in one process never spend each other's) or each time in the check build, where `TWIGO_PANIC=<name>` arms it.
  A release build never has the feature.

## Why

- A panic in one of the five loops of the old `Core::run` ended all five, since they shared one future: an exec session opened under an unlock then outlived the unlock, and the audit log lost its `relocked` line.
  A plan whose run panicked never ended; a list whose upstream panicked said `ready` over frozen rows, and a panic under the store's lock poisoned every later list of the scope (probes on a copy of the workspace, `cargo test`, tokio 1.54.1, macOS 27.2.1, 2026-11-21).
- A sync command's panic aborted the process on macOS (exit 134 in the same probes): [Tauri calls the invoke handler](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/manager/mod.rs#L458) from [wry's `extern "C" fn start_task`](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/wkwebview/class/url_scheme_handler.rs#L57), which cannot unwind.
  An async command's promise stayed pending, since Tauri [answers once the command's future ends](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/ipc/mod.rs#L371-L385).
- Containing a panic leaves a std lock that the panicking task held poisoned, and a state half changed: so what shares such a lock either fails loudly at its next use, which the fatal path then takes, or is made whole again where that is cheap, as the store is.
  Aborting on any panic, as Zed's hook does, would end terminals, shells and forwards for a bug in a list, and its released behaviour could not be tested, since the test harness needs unwinding.
- A deterministic panic returns as soon as its task runs again, so a restart needs a limit: the first probe of the supervisor hit the limit within milliseconds.
- A shared crate, not a helper in each: `twigo-kube`, `twigo-cache`, `twigo-sessions` and `twigo-core` all spawn items or join tasks, and the seam is checked by the supervisor and by the item helper alike.
- A [`Shared` future that panicked stays poisoned](https://github.com/rust-lang/futures-rs/blob/0.3.34/futures-util/src/future/future/shared.rs#L300-L318), so a map that kept it made every later asker of the same check panic.
