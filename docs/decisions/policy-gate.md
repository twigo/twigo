# Every way to reach a cluster passes one gate, and one table says what it does

Decided 2026-11-07.

## Decision

- Every kube client is built with its actor's gate, so nothing reaches a cluster around it: `Clients::new` takes one, and `Gate::unrestricted()` is for tests and tools that own their clusters.
- A way to change a cluster adds its row to the table in `crates/twigo-policy/tests/gate.rs`: the request it sends, its class, and what each mode answers.
- A test that says a thing was blocked proves that the request did not leave the process, by what the server saw, and not only that an error came back.
- What the classifier cannot read as harmless is the stricter class.

## Why

The gate is the one thing between a person's mistake and production, so what it does has to be read in one place and cannot drift with each new action.
An error from the layer says nothing of whether the request also went out; a count at the server does.
The cases that matter are the unusual ones: `kubectl --sort-by` asks for whole Secrets through a Table, `nodes/*/proxy` reaches the kubelet's exec, and a `%2F` in a name routes to `exec` on the server.
