---
paths:
  - "crates/twigo-core/src/actions.rs"
  - "crates/twigo-core/src/actions/**"
  - "crates/twigo-core/src/bus.rs"
  - "crates/twigo-core/src/bus/**"
  - "crates/twigo-policy/src/friction.rs"
  - "packages/protocol/src/mock/bus.ts"
  - "packages/workbench/src/operations/**"
---

# The command bus

- A command that changes a cluster or shows secret-grade data is an action in `crates/twigo-core/src/actions`, run through the bus; the webview never sends a write ([decision](../../docs/decisions/command-bus.md)).
- An action plans before anything is asked: its writes as the requests that go out, its risk, its words and its kubectl command; the bus names the friction, and Rust checks it before the plan runs.
- Its kubectl command does what it does: `crates/twigo-core/tests/bus_live/` runs it on kind.
- A plan sends no write before the confirmation: the exact objects it lists come from reads, never from a server dry-run of a DELETE or a subresource, which the gate takes for a write.
- An action an undo can put back ends with what reverts it, which holds to the object's generation, or to the field it set where there is none, and never to the resourceVersion of its own write.
- The mock's bus mirrors it, friction table included, and its writes add their rows to the gate's table.
