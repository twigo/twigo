# Every error has a code, and a code is a closed enum with its wire name written out

Decided 2026-11-21.

## Decision

- `IpcError` is `{ code, kind, message, blocked, server }`.
  It is built only through `IpcError::new(code, message)`, which sets `kind` from the code.
- `ErrorCode` is one closed enum in `crates/twigo-ipc/src/error.rs`, each variant with its wire name, `family.condition`, written out beside it.
  A Rust rename never moves the wire.
- A code is never reused or removed, and its wire name and kind never change: an issue, a log or a person's note may name it.
  A code that no site builds any more stays.
- `kind` is derived by `ErrorCode::kind`, which is total, and stays on the wire.
  The core's retries, sign-ins and refusals branch on `kind`; the webview branches on `code` where one condition matters.
- A code names a condition, not a site: sites that say one thing share a code, and `message` carries what differs.
- The API server's `reason` and `causes` travel as data in `server`, never as a Twigo code: an aggregated API or a webhook can answer any reason.
- A test holds a code, never a message's text.
- `crates/twigo-ipc/tests/error_codes.rs` pins every wire name and kind in a literal table.
  `TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript` writes `ErrorCode` into `generated.ts` and the table of kinds into `errorKinds.ts`, from which the mock takes `kind`, so it cannot disagree with Rust.

## Why

- A message is for people and changes with the wording: a test in `crates/twigo-sessions/src/logs/stream.rs` held `error.message.starts_with("failed to try resolving symlinks")`, and a cluster's refusal was worded in four places that disagreed.
- A kind is a class that the core's retries, sign-ins and refusals branch on: a finer kind would make each new condition an edit in every one of those reads, and a string code is checked by nothing.
- A code is something to search for, copy and report, and unlike a message it carries no host, path or value.
- A closed enum makes the webview's tables over `ErrorCode` exhaustive, and the generated union fails to compile where a code is missing.
