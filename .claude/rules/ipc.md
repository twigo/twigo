---
paths:
  - "crates/twigo-ipc/**"
  - "packages/protocol/**"
  - "apps/desktop/src-tauri/**"
---

# IPC types

- Wire types live only in `crates/twigo-ipc`; `packages/protocol/src/generated.ts` is rendered from them, never edited ([decision](../../docs/decisions/ipc-codegen.md)).
- After changing a type or a command, run `TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript` and commit the module with the change.
- A new command is a `Command` impl in `crates/twigo-ipc/src/command.rs`, listed in `typescript()`, and a handler in the mock backend.
