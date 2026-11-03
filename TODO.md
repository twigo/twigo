# TODO

Findings that belong to no step yet.

- A kubeconfig file that cannot be read or parsed is skipped with a line on stderr only (`twigo_core::catalog`): the catalog should say so in the UI, next to the contexts it hides.
- The request budget's cap for actors other than the UI (20 of the 28, ARCHITECTURE 3.2) waits for the first such actor: M1 has only the UI, so the stream counter (`crates/twigo-kube/src/client/counter.rs`) has three classes and no actors.
- Proxies (`twigo_kube::client::proxy`):
  - Go converts non-ASCII hosts and `NO_PROXY` entries to punycode before matching; Twigo compares them as written.
  - An http API server goes through an HTTP proxy's CONNECT tunnel, where Go sends the proxy the request in absolute form.
  - No test reaches a cluster through an https proxy, whose certificate would have to be in the OS trust store.
- `twigo-netmon` on macOS is tested only for registering its listeners: no test provokes a wake or a network change there, while on Linux a private bus and a dummy link do.
- After a GOAWAY that came between requests, hyper-util 0.1.21 sends the requests it hands back unsent again by itself, dialling a connection for each, below the gate of `crates/twigo-kube/src/client/connections.rs`; its public API tells such a retry from a failed request in no way (`retry_canceled_requests`).
- Credentials (`twigo_kube::credentials`, ARCHITECTURE 6.2):
  - `aws eks get-token` and aws-iam-authenticator run unattended, but an AWS profile with `mfa_serial` or a `credential_process` can prompt; Twigo cannot tell from the exec entry.
  - On Linux, killing a plugin's process group on a timeout or a cancel may kill a browser `xdg-open` started inside it; not verified.
  - The oidc refresh follows no redirect of the issuer's discovery document or token endpoint, where Go's client follows up to ten.
  - The webview reads whether a plugin may ask the person to sign in when its status changes, not when the login shell's environment does, so an `AAD_LOGIN_METHOD` the shell gains later shows at the next run.
  - A quit while refreshed oidc tokens are written back may leave `<file>.lock` beside the kubeconfig, which makes kubectl refuse its own write-back until the file is removed.
  - kube's loader turns an empty `tokenFile`, `client-certificate` or `client-key` into the kubeconfig's directory, so such a context fails where client-go skips the empty path.
  - A CA file the kubeconfig names, the cluster's or the IdP's, is read again only when a kubeconfig changes: the watcher follows the kubeconfig files, not the files they name.
- The watch hub (`twigo_cache::hub`, ARCHITECTURE 3.2):
  - The access review that lets more than four namespaces share a cluster-wide upstream is kept with the context's clients, so a RoleBinding granted later counts only once they are rebuilt or Twigo restarts.
  - A resumed watch reports `ready` on its `200`, before a `410 Gone` in its body turns it to `relisting`, so a view can flash ready for a moment.
  - When a watch reconnects with other column definitions, as a CRD's edited printer columns might bring (not verified that the API server sends them on a re-watch), the rows stored before keep their old cells, which the query view reads by the new columns until each row changes or a relist; the per-namespace upstreams of one list may disagree on columns meanwhile.
  - Listing and storing 5,000 pods by a streaming list allocates 44.2 MiB in all, HTTP/2 reads and body chunks included, to keep 4.0 MiB (`examples/hub_memory.rs`, kind 1.37 with `bench/pods.sh` at 5,000, 2026-11-02); a paged list of the same pods was not measured the same way, and step 11's budgets say whether it matters.
- Open objects (`twigo_core::objects`, ARCHITECTURE 4.3):
  - The Related tab lists the objects that the core controllers own (`twigo_describe::owned`); a custom resource's owned objects need an owner index across kinds.
- Overviews (`twigo_describe`, ARCHITECTURE 4.3):
  - A crashing container's finding has no button to its previous container's logs nor its last log line, which the logs of step 10 can give; until then the termination message stands in, when the container writes one.
  - A CronJob shows its last schedule and last success but not its next run, which needs its schedule read in its time zone.
  - A claim's Used By follows the whole objects of every pod in its namespace while its Overview is shown, as kubectl lists them; a projection watch (3.3) that keeps only their volumes would cost less (decision 8 of M1).