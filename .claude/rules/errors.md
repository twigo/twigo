---
paths:
  - "crates/**"
  - "apps/desktop/src-tauri/**"
  - "packages/**"
---

# Errors

- Every error has an `ErrorCode`: `IpcError::new(code, message)` is the one constructor, and `kind` is derived from the code ([decision](../../docs/decisions/error-codes.md)).
- A new condition adds a variant to `error_codes!` in `crates/twigo-ipc/src/error.rs` with its wire name, `family.condition`, and its kind, and a line in the pinned table of `crates/twigo-ipc/tests/error_codes.rs`; then regenerate the TypeScript.
- A wire name that a release has shipped is never reused, renamed or removed, and its kind never changes.
- Sites that say one condition share a code.
- The API server's `reason` and `causes` stay data in `server`; they are never a code.
- A test holds the code, not the message's text.
