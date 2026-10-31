# The IPC types are generated from Rust with ts-rs

Decided 2026-10-31, in step 5 of M0 (ARCHITECTURE 7.4).

## Decision

- Every type that crosses the webview boundary lives in `crates/twigo-ipc` and derives `ts_rs::TS` next to its serde attributes.
- `twigo_ipc::typescript()` renders one module, `packages/protocol/src/generated.ts`, with every type the commands reach and a `Commands` table.
  The table comes from the `Command` trait, so a command's name, request, response and channel message are written once, in Rust.
- The test `crates/twigo-ipc/tests/typescript.rs` fails when the committed module differs from a fresh render.
  `TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript` rewrites it.
- A Tauri command takes its request as the argument `request`, a subscription also its channel as `channel`, and returns `Result<Response, IpcError>`.

## Why

- ts-rs 12.0.1 is a stable release that derives from the compiled types and reads serde's attributes through its default `serde-compat` feature, so tagged and untagged enums come out as serde writes them.
- specta 2 and tauri-specta 2, which also generate command bindings, were still release candidates (2.0.0-rc.27 and 2.0.0-rc.26, published 2026-10-21, crates.io read on 2026-10-31).
- typeshare parses the Rust source with its own CLI, a second reader of the serde attributes that can drift from the compiler's.
- One module and a staleness test keep the review in one diff and make CI fail on a forgotten regeneration, without a step that commits generated files.
