---
paths:
  - "crates/twigo-core/src/state.rs"
  - "crates/twigo-core/src/state/**"
  - "crates/twigo-core/src/trust.rs"
  - "crates/twigo-core/src/forward/saved.rs"
  - "crates/twigo-policy/src/protection.rs"
  - "crates/twigo-ipc/src/access.rs"
  - "crates/twigo-ipc/src/forward.rs"
  - "crates/twigo-ipc/src/list.rs"
  - "crates/*/tests/kept/**"
---

# Files Twigo keeps for a person

- Every file Twigo keeps for a person (`state.json`, `trust.json`, `protection.json`) has a `version` and a fixture in `crates/*/tests/kept/` that its test reads to named values and writes back byte for byte ([decision](../../docs/decisions/kept-files.md)).
  The fixtures are hand-written to the writer's bytes, not recorded responses: prettier leaves them alone.
- Before the first release a change of a kept file's format, a wire type it holds included (`Mode`, `Environment`, `ForwardTarget`, `ForwardId`, `Gvr`), changes its fixture with it.
- From the first release on a change keeps reading each released version through a migration and that version's own fixture, and only then does a struct for disk split from the wire's.
- A file that protects reads closed: `protection.json` makes every context `read-only` and `trust.json` trusts nothing when it cannot be read, is not JSON, has an unknown key, a value that does not read back or an unknown version.
- Nothing writes a file it could not read: a protective one refuses every change until the next start, the others move aside first.
- A choice holds only once its file holds it: write, then hold; after a write that fails, read the file back and refuse what it does not hold.
