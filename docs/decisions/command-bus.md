# A command that changes a cluster is planned, confirmed and checked in Rust

Decided 2026-11-07 with the command bus (ARCHITECTURE 5.1, 6.4).

## Decision

- A command that changes a cluster or shows secret-grade data is an action of the command bus in `crates/twigo-core/src/actions`.
  Nothing in the webview sends a write; it asks for a plan by resource references and runs the plan by its id.
- An action plans before anything is asked: what it acts on, its writes as the requests that will go out, what it risks, its words, and its kubectl command.
  The policy refuses a blocked write then, and the bus names the friction from the risk and the context's mode (`twigo_policy::friction`).
- The webview draws the friction; Rust checks it before the plan runs: the name typed, the countdown passed.
  A plan runs once, from the window it was made for, on the cluster it was planned for, and not when the mode now asks for more than the plan did.
- The kubectl command a dialog shows does what the action does: `crates/twigo-core/tests/bus_live.rs` runs each on kind.
- The mock backend's bus (`packages/protocol/src/mock/bus.ts`) mirrors each action and the friction table.
- An action's writes add their rows to the gate's table ([decision](policy-gate.md)).

## Why

A confirmation drawn only by the webview is a promise: a stale page, a second window or a bug runs a plan nobody confirmed, on whatever cluster the name means by then.
Rust already holds the mode, the context's fingerprint and the objects, so it can name the friction and hold the plan to it.
A kubectl line that only looks like the command teaches people the wrong thing; running it in a test keeps the two the same.
