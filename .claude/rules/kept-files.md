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
- A file that protects reads closed when it cannot be read, is not JSON, has an unknown key, a value that does not read back or an unknown version, and what it may do next goes by what its loss does:
  - `protection.json`, whose loss would loosen protection, makes every context the policy file sets no mode for `read-only` and is never written while it cannot be read, so every change of protection is refused until the person starts over or Twigo starts again; a start over asks for `protection.json` typed, as it is weighed as unmarking every context the file held `read-only`, looks at the file again as it plans and as it runs, is refused where the file reads by then, and moves it aside as `protection.json.unreadable` where it is there, refused with nothing changed where the move fails, so the next choice writes a new file only once the old one is aside;
  - `trust.json`, whose loss only tightens, trusts nothing and may start anew: it moves aside, the next trust writes a new file, and where the move failed that write replaces it, which costs only a plugin asking again.
- `state.json` fails open: it moves aside and the app starts without it, and where the move failed the next save replaces it.
- In `protection.json` a choice holds only once the file holds it: write, then hold; after a write that fails, read the file back and refuse what it does not hold.
  A trust that fails to save is refused without a read-back, which costs only a plugin asking again.
