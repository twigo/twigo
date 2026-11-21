---
paths:
  - "crates/**"
  - "apps/desktop/src-tauri/**"
---

# Logging

- Log through `tracing`, never `eprintln!` or `println!`; the target stays the module path ([decision](../../docs/decisions/logging.md)).
- A value that identifies something is a field named `context`, `space`, `cluster`, `server`, `user`, `namespace`, `object`, `path` or `url`; the message is words.
- Log a change of state, not each repeat: the first failure at warn, how many followed when it works again or ends (`twigo_log::Repeats`), the per-event detail at `trace`.
- No event carries a token, a client key, an exec plugin's output, a Secret's data, a terminal's input or output, the login shell's environment, a kubeconfig's text, a frame, a batch, an object's values or a server's message for a failed request.
  A parse error that quotes its input is logged by its location, and a type that holds such a value prints names or sizes in `Debug`.
- A tool whose output is its interface, or a process that must not open the log, prints with an `#[expect(clippy::print_stdout, reason = "…")]` or `print_stderr`.
