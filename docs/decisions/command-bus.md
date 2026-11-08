# A command that changes a cluster is planned, confirmed and checked in Rust

Decided 2026-11-07 with the command bus (ARCHITECTURE 5.1, 6.4).

## Decision

- A command that changes a cluster or shows secret-grade data is an action of the command bus in `crates/twigo-core/src/actions`.
  Nothing in the webview sends a write; it asks for a plan by resource references and runs the plan by its id.
- An action plans before anything is asked: what it acts on, its writes as the requests that will go out, what it risks, its words, and its kubectl command.
  The policy refuses a blocked write then, and the bus names the friction from the risk and the context's mode (`twigo_policy::friction`).
- The webview draws the friction; Rust checks it before the plan runs: the name typed, the countdown passed.
  A plan runs once, from the window it was made for, on the cluster it was planned for, and not when the mode now asks for more than the plan did.
- The kubectl command a dialog shows does what the action does: `crates/twigo-core/tests/bus_live/` runs each on kind.
- A plan lists the exact objects it acts on and those that follow by reading them, and sends no write before the confirmation (decided 2026-11-08).
- Scale, cordon and suspend end with what reverts them: for 30 s the space's last action can be put back, from its toast or ⌘Z, refused once anyone else changed the object (decided 2026-11-08).
- The mock backend's bus (`packages/protocol/src/mock/bus.ts`) mirrors each action and the friction table.
- An action's writes add their rows to the gate's table ([decision](policy-gate.md)).

## Why

A confirmation drawn only by the webview is a promise: a stale page, a second window or a bug runs a plan nobody confirmed, on whatever cluster the name means by then.
Rust already holds the mode, the context's fingerprint and the objects, so it can name the friction and hold the plan to it.
A kubectl line that only looks like the command teaches people the wrong thing; running it in a test keeps the two the same.

The gate reads no body, so a server dry-run of a DELETE, an eviction or a scale is a write to it: sent before the confirmation it would be logged as one, and a fault in its body would change the cluster unconfirmed.
Reading the objects and what the garbage collector takes with them shows the same list and sends nothing.

An undo cannot hold to the resourceVersion its own write left: status moves it within a second (a scale's went 873 to 888 on kind 1.37, 2026-11-08).
The generation moves only when someone changes the spec, so the undo holds to that, or for a node, which has none, to the field it set, and its write carries the resourceVersion it checked.
