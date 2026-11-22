# A panic is contained where it happens, and what cannot be kept ends Twigo on purpose

Decided 2026-11-21.

## Decision

- `panic = "unwind"` stays, as Cargo's default.
  One hook, `twigo-log`'s, records every panic first.
- **The app-wide duties** run under `twigo_panic::Supervisor`, which `Core::start` builds: the catalog's sources, the contexts seen, the terminals' offers, the end of unlocks, the forwards' modes and the network, each a task of its own.
  A duty that panics starts again, at most 3 times in 5 minutes (VS Code's numbers for its extension host), with a line that names the duty and the task's id; the fourth panic in that window takes the fatal path.
  A duty that ends without a panic is logged and not started again.
  The kubeconfig watch and the state writer are threads: they say that they panicked to the same supervisor through a `Reporter`, which starts the watch again or lets the writer go on, and takes the fatal path once the state lock is poisoned.
  A start of a thread that panics counts as another panic of its duty, since the watch's start reads the files whose content may be what panicked.
  The policy proxy's accept loop takes the fatal path at once, since its listener goes with it and its address is in every proxy kubeconfig.
  Past the limit the other duties go on, and a panic of the supervisor's own task takes the fatal path too.
- **An item** that a person opened, a list, an open object, a logs tab and each of its streams, a pod shell, a local terminal, a forward's data path, runs under `twigo_panic::contain`.
  Its owner keeps the sender and the state the end needs outside the item, and sends the end the item already has, with `internal.panic`: a list's last batch changes only its state to `error`, an object's and a logs tab's likewise, a shell and a terminal end `Failed`, a container's stream says `error`, and a forward is `failed`, which a resume starts again as a new data path.
  Nothing starts an item again; the webview's next subscribe, or the person's resume, does.
  A hub upstream that panicked ends `Failed`, which the hub's existing path for an ended upstream starts for the next list, and a store that a panic under its lock poisoned is emptied and cleared before that relist.
- **A plan** whose run panics ends `Failed` with `internal.panic`, with an `ended` line of the outcome `failed` in the audit log and its bus entry and undo freed.
  It is never retried, since a write must not go out twice.
- **A command**: an async one runs through `contained()` and answers `internal.panic`.
  The invoke handler runs under `catch_unwind`, and a panic of a sync command takes the fatal path.
  The panic is caught around the generated handler, not through the fields of Tauri's `Invoke`, which Tauri marks as not stable.
- **The fatal path** writes the log, ends every unlock at once (the audit log's `relocked` line says `fatal`), rechecks every forward against its mode and closes every forward where that recheck panics (`Core::fail_closed`), then shows a native dialog through `tauri-plugin-dialog` that says Twigo must restart, with Restart and Quit; either answer writes the state, and Restart calls `AppHandle::request_restart`.
  It is native because the webview may be what the panic broke.
  It is a sheet on Twigo's focused window, or its main one, given as the dialog's parent; where no window is left the fatal path writes the state and shows nothing, and the exit under way goes on.
  An answer that comes once Twigo has begun to end does nothing.
  The page-load and window callbacks run under the same catch as the invoke handler.
  A test's core, from `Core::start_for_tests`, fails the test when it is dropped if a duty panicked with nothing armed or could not be kept.
- A task that must run to its end is joined with `twigo_panic::joined`, which raises its panic again with its own payload, so the hook records it once; never `.expect("… does not panic")`.
- No `expect` or `unwrap` sits on an error that carries input text: a `KubeconfigError` quotes the lines of the file.
- One seam, behind the `inject` feature of `twigo-panic`: a name armed with `inject::arm` makes the supervisor's duty, `contain`'s item or a few other sites of that name panic.
  An arm counts in the runtime it was made in, and a thread checks it in the runtime that started it, so the tests of one process, each on a runtime of its own, never spend each other's arms; an arm made outside any runtime counts everywhere, as the check build's, where `TWIGO_PANIC=<name>` arms it each time.
  A release build never has the feature.

## Why

- A panic in one of the five loops of the old `Core::run` ended all five, since they shared one future: an exec session opened under an unlock then outlived the unlock, and the audit log lost its `relocked` line.
  A plan whose run panicked never ended; a list whose upstream panicked said `ready` over frozen rows, and a panic under the store's lock poisoned every later list of the scope (probes on a copy of the workspace, `cargo test`, tokio 1.54.1, macOS 27.2.1, 2026-11-21).
- A sync command's panic aborted the process on macOS (exit 134 in the same probes): [Tauri calls the invoke handler](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/manager/mod.rs#L458) from [wry's `extern "C" fn start_task`](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/wkwebview/class/url_scheme_handler.rs#L57), which cannot unwind.
  An async command's promise stayed pending, since Tauri [answers once the command's future ends](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/ipc/mod.rs#L371-L385).
- Containing a panic leaves a std lock that the panicking task held poisoned, and a state half changed: so what shares such a lock either fails loudly at its next use, which the fatal path then takes, or is made whole again where that is cheap, as the store is.
  Aborting on any panic, as Zed's hook does, would end terminals, shells and forwards for a bug in a list, and its released behaviour could not be tested, since the test harness needs unwinding.
- A deterministic panic returns as soon as its task runs again, so a restart needs a limit: the first probe of the supervisor hit the limit within milliseconds.
- The fatal path keeps the healthy duties and ends the unlocks because the person may never answer: with the duties gone, an exec session opened under an unlock outlived it, and the dialog does not stop the person from working on in another window.
- It rechecks the forwards itself because only the forwards' modes duty refuses a running forward when its mode changes: with that duty given up, or the supervisor's own task gone, ending the unlocks left a forward's open connections streaming, and with the recheck taken out of `Core::fail_closed` the forward of `the_fatal_path_fails_a_forward_an_unlock_let_run_once_forward_modes_is_given_up` did not fail within 10 s (`cargo test -p twigo-core --lib`, 2026-11-22).
  A recheck that panics leaves the forwards' table poisoned, so the shutdown that then closes them takes it back.
- The system's own alert, `CFUserNotificationDisplayAlert` in rfd 0.17.2, which the dialog was without a parent, outlives the process, and an alert that comes back without a click answers with its first button: a debug build with the `inject` feature, started with `TWIGO_PANIC="unlock expiry"` on macOS 27.2.1 on 2026-11-22 while the alert of a run ended by `kill` was still on screen, restarted itself five times in 9 s with no click.
  A sheet is part of Twigo's window and ends with it.
- Tauri [forgets a window in the run callback](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/manager/mod.rs#L655-L669), [which runs before the window's event handlers](https://github.com/tauri-apps/tauri/blob/tauri-runtime-wry-v2.12.5/crates/tauri-runtime-wry/src/lib.rs#L4227-L4236), and [ends once the last window is gone](https://github.com/tauri-apps/tauri/blob/tauri-runtime-wry-v2.12.5/crates/tauri-runtime-wry/src/lib.rs#L4259-L4273), so a panic in the last window's `Destroyed` handler found no parent: in a debug build with the `inject` feature and a panic armed there, on macOS 27.2.1 on 2026-11-22, the system's alert stayed on screen after Twigo had ended, and its Restart started nothing.
- Arms that counted everywhere were spent by the threads of other tests in the same binary: the thread tests of `crates/twigo-core/tests/panics.rs`, run 30 times on 2026-11-22, failed 4 times so.
- A shared crate, not a helper in each: `twigo-kube`, `twigo-cache`, `twigo-sessions` and `twigo-core` all spawn items or join tasks, and the seam is checked by the supervisor and by the item helper alike.
- A [`Shared` future that panicked stays poisoned](https://github.com/rust-lang/futures-rs/blob/0.3.34/futures-util/src/future/future/shared.rs#L300-L318), so a map that kept it made every later asker of the same check panic.
