# Twigo logs through tracing, to one file, in words and fields

Decided 2026-11-21.

## Decision

- Every crate logs through `tracing`, never `eprintln!`; clippy denies `print_stderr` and `print_stdout` for the workspace.
  What stays is a tool whose output is its interface, and the copy of Twigo that the login shell runs for `--dump-env`, each with an `#[expect]` that says why.
- The target is the module path, so `TWIGO_LOG=warn,twigo=info,twigo_kube::credentials=debug` adds the debug lines of one module to the default.
- Identifying values travel as fields named `context`, `space`, `cluster`, `server`, `user`, `namespace`, `object`, `path` and `url`.
  The message is words.
  A report aliases a value by the field that carries it, and reads no sentence.
- A change of state is logged once, and a repeat of it is counted: a listener that keeps failing logs its first failure and, when it works again or ends, how many followed.
  What happens per event goes to `trace`, which the default filter drops.
- No event carries a token, a client key, an exec plugin's output, a Secret's data, a terminal's input or output, the login shell's environment, a kubeconfig's text, a frame, a batch, an object's values, or a server's message for a failed request.
  A type that holds such a value prints names or sizes in `Debug`, and an error that quotes input is logged by what it says of itself, as a status or a location.
- One subscriber, set up by `twigo-log`: an `EnvFilter` behind a reload layer, `warn,twigo=info` by default and `TWIGO_LOG` at start, which replaces the default whole but for the first line of the run, and a JSON-lines layer into a file that rotates by size.
  The `log` records of Tauri and the libraries become events through `tracing-log`.
- The file is `twigo.log` in Tauri's log directory, a new file at each launch, 4 MiB each, the current one and five more.
  It is written synchronously, one append per line, so a panic's record is on disk when the hook returns.

## Why

- `tracing` is in the tree already, through kube-client, hyper-util, h2 and tower, so one subscriber sees every library's events.
- Not `tracing-appender` 0.2.5: its `Rotation` is by time only, from every minute to never, so a flood within a period grows one file without bound, and its worker drops a failed write with a `TODO` instead of saying it ([worker.rs](https://github.com/tokio-rs/tracing/blob/tracing-appender-0.2.5/tracing-appender/src/worker.rs#L74-L84)).
  A queued line is lost when the process aborts before the guard drops, the panic's own line among them.
- Not `tauri-plugin-log` 2.10.2: a default file of 40,000 bytes that `KeepOne` deletes ([lib.rs](https://github.com/tauri-apps/plugins-workspace/blob/log-v2.10.2/plugins/log/src/lib.rs#L53-L54)), opened with no mode ([lib.rs](https://github.com/tauri-apps/plugins-workspace/blob/log-v2.10.2/plugins/log/src/lib.rs#L232-L236)), and a level fixed when the plugin is built.
- Not `flexi_logger` 0.32.0: it requires jiff 1, a second major beside the 0.2 that kube-core and k8s-openapi pin (`.claude/rules/checks.md`).
- A process that launchd starts has `/dev/null` for stderr (`lsof -a -p <Finder's pid> -d 0,1,2`, macOS 27.2.1, 2026-11-21), so the `eprintln!` calls would reach nobody in a shipped app.
- A log that a person attaches to a bug report must hold no secret, and a field of a fixed name lets a redaction know a value without parsing prose.
- serde-saphyr's parse error of a kubeconfig quotes the lines around the fault: a probe (kube-client 5.1.0 and serde-saphyr 2.2.0, `Kubeconfig::read_from` on three broken files holding a fake token, 2026-11-21) printed the token's line, and in one case the next line's `client-key-data`.
  The login shell's `Debug` printed every variable's value.
  Both would have reached the file, and the second is fixed with the file.
- One line per change keeps a failing `accept` under too many open files from filling the file, and the size cap bounds the disk whatever slips through.
