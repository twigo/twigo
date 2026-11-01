# TODO

Findings that belong to no step yet.

- A kubeconfig file that cannot be read or parsed is skipped with a line on stderr only (`twigo_core::catalog`): the catalog should say so in the UI, next to the contexts it hides.
- The request budget's cap for actors other than the UI (20 of the 28, ARCHITECTURE 3.2) waits for the first such actor: M1 has only the UI, so the stream counter (`crates/twigo-kube/src/client/counter.rs`) has three classes and no actors.
- Proxies (`twigo_kube::client::proxy`):
  - Go converts non-ASCII hosts and `NO_PROXY` entries to punycode before matching; Twigo compares them as written.
  - An http API server goes through an HTTP proxy's CONNECT tunnel, where Go sends the proxy the request in absolute form.
  - No test reaches a cluster through an https proxy, whose certificate would have to be in the OS trust store.
- `twigo-netmon` on macOS is tested only for registering its listeners: no test provokes a wake or a network change there, while on Linux a private bus and a dummy link do.
