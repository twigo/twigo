# Every file Twigo keeps for a person has a version and a fixture, and a file that protects reads closed

Decided 2026-11-27 (ARCHITECTURE 4.8, 6.2, 6.4).

## Context

Twigo keeps three files for a person in the app-data directory: `state.json` (what the UI leaves behind, the spaces and their forwards), `trust.json` (the exec plugins the person trusted) and `protection.json` (the mode they chose for each context and the type they marked it as).
`audit.jsonl` is never read back for a decision, and `cache/`, `proxy/` and `terminals/` can be thrown away.

Wire types go to disk as they are: `protection.json` holds `twigo_ipc::Mode` and `Environment`, and a space's forwards in `state.json` hold `ForwardTarget` and `ForwardId`.
A serde rename made for the webview would change the disk format with no version bump, and no test noticed one.
A second set of structs for disk would catch it too, at the cost of a copy of each type and a conversion for one caller.

The person's modes and types lived under a key of `state.json`, which moves aside whole when it cannot be read, as the UI's values may.
A lost key cost the person their locks: a context they had made `read-only` over a lock that only says `guarded` came back `guarded`.

## Decision

- **A version and a fixture.**
  Every file Twigo keeps for a person has a `version` and a committed fixture under the tests of the crate that owns it, in `crates/*/tests/kept/`: a test reads the fixture to the values it names and writes those values back to the fixture's bytes, so a rename of a type that goes to disk fails it.
  The fixtures are written by hand to match the writer's bytes; they are no recorded server responses, and prettier leaves them as the writer writes them.
- **Before the first release** a change of a file's format changes its fixture with it, and there are no migrations.
- **From the first release on** a change keeps reading each released version through a migration and that version's own fixture, which stays.
  Only then does a struct for disk split from the wire's, where a wire change would otherwise change a released format.
- **A file that protects reads closed**: the person's protection and the trust file.
  A file that cannot be read, is not JSON, has a key nothing reads, holds a value that does not read back or has a version this build does not know gives the strictest reading: `protection.json` makes every context `read-only`, below a policy file's entry, and `trust.json` trusts nothing.
  `state.json` keeps failing open, as it holds only what the UI leaves behind: it moves aside and the app starts without it.
- **What a file that cannot be read may do next goes by what its loss does.**
  `protection.json`, whose loss would loosen protection, is never written before the next start: while it cannot be read every change of protection is refused, so a newer build's file outlives a downgrade and reads again once that build runs; it is read again only at the next start.
  `trust.json`, whose loss only tightens, may start anew: it moves aside as `trust.json.unreadable` with its bytes and takes new trust at once, and where the move fails the next trust writes over it.
  `state.json` moves aside as `state.json.unreadable` in the same way, and the next save starts a new file, or replaces it where the move failed.
- **A choice holds only once its file holds it.**
  The policy writes `protection.json` before it holds a change, and refuses one the file does not hold: a write that fails is read back, since its last step, the directory's fsync, comes after the new file is in place.
  So a choice holds where the file holds it as written; the rare write whose read-back fails too is refused though it may be in place, and one held after a directory fsync that failed may not survive a crash.

## Why

- A fixture pins the bytes the reader takes and the writer gives, which is what a released file depends on, with no second type to keep in step until a format has shipped.
- A protective file read open loses protection silently: an unknown key skipped is a lock the writer meant that does not hold, and a value dropped is a context back at a looser default.
  Read closed, the same mistake shows as every context the policy file sets no mode for `read-only`, which the person sees in the popover, the blocked toasts and the problems, and gets out of by restoring or removing the file.
- A `protection.json` rewritten after it could not be read would replace what a newer build wrote with what an older one knows, so a downgrade and an upgrade back would lose the person's choices, and a context they had made stricter than its locks say would come back looser.
- A `trust.json` lost the same way only has each plugin ask again before it runs, so starting it anew leaves nothing looser than the person set, and spares them a file to restore before any plugin can be trusted.
- A choice held before it is written lasts for the run only, and the person believes a lock holds that the next start does not have.

## Consequences

- A person whose `protection.json` cannot be read has every context the policy file sets no mode for `read-only` until they restore or remove the file and restart Twigo: no command starts it over yet.
- A change of `Mode`, `Environment`, `ForwardTarget`, `ForwardId` or of a kept file's own structs fails a fixture test, and whoever makes it decides there whether the disk format changes.
- A `trust.json` or a `state.json` whose move aside fails says so in the log, and the next write replaces it.
- The modes and types that `state.json` kept under `policy/choices` before this change are not read: before users exist there is no import.

## Where it is implemented

- `crates/twigo-policy/src/protection.rs` and `crates/twigo-policy/tests/kept/protection.json`.
- `crates/twigo-core/src/trust.rs` and `crates/twigo-core/tests/kept/trust.json`.
- `crates/twigo-core/src/state.rs`, `crates/twigo-core/src/forward/saved.rs` and `crates/twigo-core/tests/kept/state.json`.
