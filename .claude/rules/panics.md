---
paths:
  - "crates/**"
  - "apps/desktop/src-tauri/**"
---

# Panics

- An app-wide duty is a task under the supervisor `Core::start` builds, never a loop spawned and forgotten; a thread of a duty tells the supervisor that it panicked through `twigo_panic::Reporter` ([decision](../../docs/decisions/panics.md)).
- An item that a person opens runs under `twigo_panic::contain`, whose owner keeps the sender outside it and sends the end the item already has, with `internal.panic`; nothing starts an item again.
- An async Tauri command runs through `contained()`; a plan whose run panics ends `Failed` and is never retried.
- A joined task that must not panic is joined with `twigo_panic::joined`, never `.expect("… does not panic")`.
- No `expect` or `unwrap` on an error that carries input text, such as a `KubeconfigError`.
- A test of a panic arms the name with `twigo_panic::inject::arm` and holds that the item ends or the duty starts again; the supervisor's contract is `crates/twigo-panic`'s own tests.
