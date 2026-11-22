# Twigo architecture

Twigo is an open-source desktop IDE for Kubernetes: native, fast and keyboard-first.
It aims to show the person who runs many clusters what is wrong, why, and what changed, from the keyboard, with every change guarded (D13).
This document fixes the architecture; the M0 spikes in `docs/spikes/` correct it wherever they measured otherwise.

- Status: M0 in progress, steps 1 to 5 done, steps 6 and 7 in review, 2026-11-01
- Stack: Tauri 2 (2.12.x), Rust with kube-rs (5.0.x, k8s-openapi 0.29), React 19 + TypeScript, Tailwind 4, shadcn/ui, pnpm monorepo
- Reference code: the retired NATS IDE at `6ee327f`, whose history survives only in a local checkout; section 1 maps what carries over

## 0. Context

### 0.1 Decisions taken with the owner (2026-10-31)

| #   | Decision                                                                                                                                                                                                                                                     | Consequence                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Kubernetes only. The NATS IDE is retired; NATS may come back as an extension.                                                                                                                                                                                | One app in the monorepo, so there is no multi-domain shell. A NATS extension would later be the first real test of the API.                  |
| D2  | The first public release ships on macOS and Linux. Windows follows directly after.                                                                                                                                                                           | Every design choice must work on WebView2. Only CI, signing and the test matrix for Windows are deferred.                                    |
| D3  | The extension ecosystem is open to third parties.                                                                                                                                                                                                            | Isolation, capability grants, signing and a versioned API are needed from the first version of the API.                                      |
| D4  | Extension logic runs as WASM components inside the Rust core (wasmtime + WIT). The core renders declarative UI. Sandboxed iframes cover views that cannot be declared.                                                                                       | Credentials never leave Rust. Extensions keep running when the webview reloads. Section 5.3.                                                 |
| D5  | The core is an MCP server first (MVP). An agent panel over ACP that runs existing agents (Claude Code, Codex, Gemini CLI) comes later. Twigo has no LLM client of its own and needs no model keys.                                                           | One policy layer covers the UI, extensions and agents. Section 6.6.                                                                          |
| D6  | One space per cluster. A rail of space tiles at the left, as Lens's hotbar, each holds one context, or a group of contexts for multi-cluster tables, with their own explorer, editors and layout. Comparing across spaces takes an explicit Compare command. | The title bar's breadcrumb always says which cluster and namespace you are in. Section 4.2.                                                  |
| D7  | Lists come from server-side Table watches (`as=Table`, `includeObject=Metadata`). Metadata-only watchers serve only as indexes (owners, CRDs). The full object is fetched when it is opened.                                                                 | **This replaces the brief's "metadata-only watchers for lists"**: `PartialObjectMetadata` has no Ready, Status, Restarts or Node. Section 3. |
| D8  | Good design is a requirement. The legacy design language (tokens, density, restraint) carries over.                                                                                                                                                          | Section 4.9.                                                                                                                                 |
| D9  | Licence: Apache-2.0.                                                                                                                                                                                                                                         | A patent grant for contributors and extension authors, and the CNCF default. `LICENSE` sits at the repository root.                          |
| D10 | Bundle identifier `io.twigo.ide`. The repository and its releases live at github.com/twigo/twigo, which replaced the legacy repository.                                                                                                                      | A new updater key; the endpoint stays that repository's `latest.json`. Section 1.                                                            |
| D11 | Extension manifests are `extension.json`, checked against a published JSON Schema.                                                                                                                                                                           | Validation and completion in any editor. Section 5.4.                                                                                        |
| D12 | Kubernetes 1.33 and later. 1.32 left upstream support on 2026-02-28 and will be out of date by the time Twigo ships; older releases come back only if users ask.                                                                                             | The test matrix runs from 1.33 to the newest release kind ships. Section 3.2.                                                                |

Decisions taken with the owner on 2026-11-14, after the [strategic review](reviews/2026-11-fable-strategic-review.md):

| #   | Decision                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D13 | Twigo is not presented as an open Lens. It is for the person who runs many clusters and has to find what is wrong, why, and what changed, from the keyboard, with every change guarded.                           | The first lines of this document say so. "Performance is the product" stays an engineering principle (0.2).                                                                                                                                                                       |
| D14 | The extension runtime (D3, D4, D11) moves to the end of the roadmap. D3 and D4 stand.                                                                                                                             | M3 and the first beta ship without extensions. Until then a provider's clusters come through the kubeconfig and its exec plugin. Sections 5.3, 7.1, 7.2 and 7.4.                                                                                                                  |
| D15 | Agents read and propose, and the person applies. This is tried first and may change.                                                                                                                              | The MCP server gets no tool that writes, execs or forwards, and the grant `read + approved writes` of 6.6 is not built until this is revisited. The approval broker for child processes (6.4) is unchanged. Section 7.2.                                                          |
| D16 | At the first write to a context nobody marked, Twigo asks once what the context is. Protection is lowered only by a confirmed command that the audit log records; a kubeconfig or a provider can only tighten it. | A context nobody marked is `guarded` and its first write or exec asks what it is; locks from the kubeconfig, a provider or a type only tighten, and a person's choice wins both ways; mode, type and unlock are plans of the command bus that the audit log records. Section 6.4. |
| D17 | macOS builds are signed with the maintainer's personal Apple Developer membership, not a company's.                                                                                                               | Section 6.7 and the release work.                                                                                                                                                                                                                                                 |

### 0.2 Principles

1. **Performance is the product.**
   Watch only what is visible and keep full objects out of lists.
   The backend batches its changes and the frontend renders only the visible rows.
   Budgets are numbers that a harness checks (section 3.8).
2. **An IDE, not a dashboard.**
   The workbench has parts, editors with inputs, commands, keybindings, context keys and contribution points.
   Every action is a command.
   A user reaches every command from the palette and can bind it to a key.
3. **Safe by default.**
   The read-only lock, dry-run diffs and approvals are enforced in Rust at one point.
   The UI, extensions and the MCP server always go through it.
   Child processes get a policy proxy, which guards against accidents but is not a security boundary (6.4).
4. **An open core that names no vendor.**
   The core never mentions Segla or any cloud.
   Providers attach only through the extension API.
5. **Lazy everything.**
   No cluster connection, exec plugin, extension or watch starts until the user needs it.
6. **No account, no telemetry by default.**
   Crash reports are opt-in.
   A problem report is the person's to send: Twigo opens a page of their browser and sends nothing itself (4.10).

### 0.3 What the other clients teach

The sources are in the appendix.

| Their problem                                                                                                                                           | Seen in                                            | Twigo's answer                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login wall, paid tiers for basics (hotbar, MCP, extensions), closed source                                                                              | Lens since 2023                                    | Apache-2.0, no account, every core feature free (0.2)                                                                                                         |
| Full list of every kind with no `limit`; one watch per namespace; a full app instance per open cluster (iframes)                                        | Freelens / OpenLens                                | Shared, ref-counted Table watches per GVR and scope (per namespace, widened above 4 namespaces); one webview; per-cluster budgets (3.2)                       |
| Unbatched global events per watch event; full snapshot per change; merge on the UI thread                                                               | Kubeli, srelens, Aptakube                          | Rust coalesces, sorts and windows; one Channel per view; acks for flow control (3.5)                                                                          |
| Hangs with "All namespaces" on 30k pods; eager metrics on huge lists                                                                                    | Aptakube #499                                      | Rust owns sort, filter and window; metrics only for the rows in view, polled by a poller of its own (3.4, 3.6)                                                |
| Freezes on big ConfigMaps                                                                                                                               | Aptakube #575                                      | Large values rendered lazily (3.6)                                                                                                                            |
| Exec plugins not found from a Dock launch; kubelogin re-run every 30 s, opening browser tabs; device codes lost; plugins run for every context at start | Lens #7956, Headlamp #7879, Freelens < 2.0         | Login-shell environment, a credential runner of our own: timeout, single-flight, no retry loops, visible prompts; connect only on space activation (6.1, 6.2) |
| Empty views after a fixed cache-sync timeout                                                                                                            | k9s PR #4023                                       | Typed view states: `syncing / ready / relisting / forbidden / unauthorized / error` (3.7)                                                                     |
| Port-forwards tied to one pod; no failover behind a Service; random pod names restored                                                                  | k9s, Aptakube #384, #519                           | Forward targets are Services or workloads, their pods read through EndpointSlices, and a new pod is taken when the current one leaves (4.6)                   |
| Extension API removed, rewritten or put behind a paywall; extensions break with each host React/MobX bump                                               | Lens 2024.9 and 2026.10, Freelens 2.0              | Versioned WIT kept side by side (Zed), no host libraries shared as implicit API, a fixture extension in CI (5.3)                                              |
| In-process plugins with no boundary; malware in plugin stores                                                                                           | Headlamp, Backstage, Obsidian, VS Code (GlassWorm) | WASM sandbox, capabilities declared and granted, signed packages, nothing executes in the workbench DOM (5.3, 5.6)                                            |
| A local proxy that breaks SOCKS, bastion and corporate proxies                                                                                          | Freelens #766, Lens #6063                          | No proxy in the UI path. The core talks to the API server directly through the kubeconfig proxy settings (6.3)                                                |
| Projects that died with their only sponsor                                                                                                              | Octant, Monokle, Kubernetic, Seabird               | Vendor-neutral core; Segla is an extension, not a dependency (0.2)                                                                                            |

Worth taking:

- k9s `:` command grammar, aliases, single-key verbs, marks and plugin scopes.
- Lens catalog model: entities, sources and categories.
- Aptakube multi-cluster tables and kubeconfig `extensions` metadata.
- JET Pilot shared watch hub and credential broker.
- kftray port-forward ergonomics.
- Headlamp capability-gated native commands and per-plugin secure storage.

## 1. Reuse map from `legacy/`

The legacy repository already has a domain-free shell.
Its views, status bar, domains, watermark and commands go through registries, and an ESLint boundary rule keeps NATS code out of `shell/`.
That is the part worth carrying over.
Everything NATS-specific goes.

### Keep (move, rename paths)

| Legacy                                                                                                                                                                                                                                                                          | New home                                | Notes                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo tooling: `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js` (incl. the boundary rule), Prettier, husky + commitlint, `cliff.toml`, Dependabot, `.github/workflows/ci.yml` and `pr-title.yml`, issue/PR templates, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT | root                                    | The boundary rule changes its target: the workbench must not import `packages/kube`.                                                                                                                                                                                                            |
| `.github/workflows/release.yml`, `RELEASING.md`, `apps/twigo/scripts/set-version.mjs`                                                                                                                                                                                           | root, `apps/desktop/scripts`            | The tauri-action matrix (macOS arm64 and x64, Linux on ubuntu-22.04), notarization secrets, updater signing, a draft release with `latest.json`. **Use the bundle identifier `io.twigo.ide` and a new updater key (D10)**, so the two apps share no app-data directory or single-instance lock. |
| Tauri plugin set (`src-tauri/src/lib.rs`): single-instance (registered first) and window-state now; updater, process, opener and dialog with the features that call them                                                                                                        | `apps/desktop/src-tauri`                | Window chrome stays: `titleBarStyle: Overlay`, `trafficLightPosition`, and the strict CSP.                                                                                                                                                                                                      |
| `libs/ui` (shadcn components, `theme.css` tokens, sparkline, `cn`)                                                                                                                                                                                                              | `packages/ui`                           | It is the base of the design system (4.9). `code-viewer` (CodeMirror) is replaced by Monaco.                                                                                                                                                                                                    |
| `apps/twigo/src/index.css`: typography (Inter `cv01`/`ss03`, weights 510/590, 13 px base, tabular numbers) and the dockview tab skin (selected-tab chip, no underline)                                                                                                          | `packages/ui`, `packages/workbench`     | The rest of the design language (4.9).                                                                                                                                                                                                                                                          |
| `ErrorBoundary`, `PanelBoundary`, `store/zoom.ts`, `store/commandHistory.ts`, `lib/updater.ts` + `store/updateCheck.ts`, `shell/menu.ts` (native menu built from commands), `lib/appVersion.ts`                                                                                 | `packages/workbench`                    | `menu.ts` changes: it is built from the menu registry (5.1), not a hand-written list. `store/zoom.ts` became `src/zoom.ts`, which keeps the factor in the app's state while `apps/desktop` applies it (4.1).                                                                                    |
| Typed IPC errors: Rust `Error::kind` + TS `IpcError` (`lib/api.ts`, `nats/error.rs`)                                                                                                                                                                                            | `crates/twigo-ipc`, `packages/protocol` | Error codes and kinds are generated from Rust instead of written by hand ([decision](decisions/error-codes.md)).                                                                                                                                                                                |
| Bounded coalescing with a `dropped` counter (`nats/subscription.rs`)                                                                                                                                                                                                            | `twigo-sessions` (logs)                 | The same rule holds: never lose data silently, show the gap.                                                                                                                                                                                                                                    |

### Adapt

| Legacy                                                                                                   | Becomes                                                                           | Change                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/commands.ts` (static commands plus providers; `when` is a closure; one keybinding string)           | Command service, menu registry, keybinding service, context keys (5.1, 5.2)       | `when` becomes a data expression evaluated against context keys. Handlers can live in the frontend, the backend or an extension. Keybindings get weights, chords, platform variants and user overrides.                                                     |
| `shell/views.ts`, `shell/statusBar.ts`, `shell/watermark.tsx`, `shell/domains.ts`                        | Contribution registries: view containers, views, status-bar items, editors, menus | One registry per contribution point. Core features register through the same registries that extensions use, so the API gets dogfooded. `domains.ts` goes (D1).                                                                                             |
| `shell/editorHost.ts` + `components/editor/EditorArea.tsx` (dockview)                                    | Editor service (4.3)                                                              | Panels are keyed by `EditorInput` URIs and opened through a resolver. Adds preview tabs, dirty working copies and one layout per space. Keep the `withReplacingLayout` guard: bulk swaps must not count as user closes.                                     |
| `store/spaces.ts`, `components/workbench/SpaceTabs.tsx`                                                  | Spaces (4.2)                                                                      | Space = a context, or a group of contexts, instead of a domain × target. Each space remembers its views and layout. ⌘1..9, a raw keydown listener in legacy, becomes commands. Legacy hides the strip when only one domain exists; here it is always shown. |
| `store/workspace.ts` (dockview layout per connection)                                                    | Per-space state                                                                   | Keyed by space ID. Holds layout, open inputs, explorer state and namespace scope.                                                                                                                                                                           |
| `components/editor/InspectorSplit.tsx`                                                                   | Row details over a list                                                           | The inspector becomes a drawer that slides in over its list from the right, as Lens's (4.3).                                                                                                                                                                |
| `store/readonly.ts` + `ConnState.readonly` (frontend-owned, synced to Rust by `conn_sync_readonly`)      | `twigo-policy` (6.4)                                                              | **Rust owns the lock.** The frontend only displays it. Three modes, several policy sources, timed unlock.                                                                                                                                                   |
| Diff before apply (`lib/diff.ts`, `diffStreamPatch` in `StreamFormDialog`, `RawConfigDialog`)            | Server-side apply dry-run + Monaco diff editor (6.5)                              | The diff now compares live state with the server's dry-run result, so it includes webhook and defaulting changes. A local diff guesses.                                                                                                                     |
| `lib/persist-storage.ts` (tauri-plugin-store)                                                            | Settings files + state store (4.8)                                                | Settings are user-editable JSONC files with layers. UI state (layouts, history) goes to `twigo-core`'s state store, one JSON file written atomically, not tauri-plugin-store.                                                                               |
| `components/views/VirtualTree.tsx`, `components/editor/MessageTable.tsx` (TanStack Virtual)              | Explorer tree, resource table                                                     | The table becomes window-driven: Rust sends only the visible window (3.4).                                                                                                                                                                                  |
| `store/connScoped.ts` (teardown registry)                                                                | Space and context teardown registry                                               | Same pattern, keyed by context.                                                                                                                                                                                                                             |
| Connection manager UX (`ConnectionPicker`, `ConnectionSwitcher`, import and write-back of NATS contexts) | Cluster catalog (5.5)                                                             | Same promise: **read what the CLI already has**, here the kubeconfig. Twigo never writes the kubeconfig except through explicit commands.                                                                                                                   |
| `emit.rs` (global events)                                                                                | Channels per subscription + a few typed global events                             | Tauri documents its events as "not designed for low latency or high throughput".                                                                                                                                                                            |
| `components/workbench/Toaster.tsx` + `store/toasts.ts`                                                   | `Toast` and `notify` in `packages/ui`; the shell mounts `<Toaster>`               | sonner positions, stacks and times the toasts, so the hand-written store goes; the look and the lifetimes stay, and a repeat with the same key replaces its toast                                                                                           |

### Drop

- The NATS domain: `src-tauri/src/nats/*`, `src/modules/nats`, every NATS view, editor and store (subjects, stream, jetstream, kv, objstore, monitor, services, responder, codecs, series), `libs/utils` subject-tree and message helpers.
- NATS dependencies: async-nats, protox, prost, prost-reflect, rmp-serde, ciborium.
  reqwest stays: the extension host's `host-http` needs a client.
- QuickJS-WASM and the `'wasm-unsafe-eval'` CSP entry.
  Extension code runs in wasmtime in Rust, not in the webview.
- CodeMirror.
  Monaco is the only code editor (4.6).
- `docker-compose.yml`, `nats.conf`, the traffic generator.
  The dev and bench environment becomes kind + kwok (3.8).

## 2. Processes and modules

### 2.1 Processes

```
┌──────────────────────────── twigo (one OS process, tokio) ────────────────────────────┐
│ apps/desktop: Tauri shell: windows, native menu, plugins, IPC registration            │
│ twigo-keyboard  active keyboard layout map · layout changes (TIS, xkbcommon, TSF)     │
│ twigo-netmon    wake from sleep · network changes (IOKit, SystemConfiguration,        │
│                 logind, rtnetlink)                                                    │
│ twigo-log       diagnostics log (twigo.log) · panic hook · the audit log's file       │
│ twigo-panic     supervisor of the app-wide duties · what ends an item · the seam      │
│                                                                                       │
│ twigo-core      spaces · settings · catalog · command bus · policy proxy · approval   │
│                 broker · state                                                        │
│  ├─ twigo-kube      kubeconfig source · client factory · credential runner            │
│  │                  discovery + OpenAPI cache · operations (apply, scale, drain…)     │
│  │                  └─ policy layer (tower) ◄── twigo-policy: modes · approval · audit│
│  ├─ twigo-cache     watch hub: upstream watches → row stores → query views → batcher  │
│  ├─ twigo-sessions  logs · exec/attach · port-forward manager · local pty             │
│  ├─ twigo-ext-host  wasmtime, one store per extension · capability gate · registry    │
│  ├─ twigo-mcp       MCP server (rmcp) on a per-user local socket                      │
│  └─ twigo-env       login-shell environment for every child process                   │
└───────┬───────────────────────────────┬─────────────────────────────┬─────────────────┘
        │ invoke + Channels             │ child processes             │ local socket (0600)
┌───────▼───────────┐       ┌───────────▼─────────────┐     ┌─────────▼────────────┐
│ webview per window│       │ exec credential plugins │     │ `twigo mcp` stdio    │
│ workbench, kube UI│       │ $SHELL env probe        │     │ shim ◄── Claude Code,│
│ sandboxed ext     │       │ pty shells (terminal)   │     │ Cursor, VS Code      │
│ iframes (tier 2)  │       │ tier-3 ext processes    │     └──────────────────────┘
└───────────────────┘       │ ACP agents (later)      │
                            └─────────────────────────┘
        all cluster traffic: core → kube-apiserver (HTTPS, WebSocket); never from the webview
```

**VS Code's process split, and why most of it is skipped.**
VS Code runs a main process, renderers, extension hosts (Node, web worker, remote), a shared process and a pty host.
Most of that exists because of Node: it isolates crashes and JS event loops.
Twigo has one Rust process.
A tokio task that panics does not take the process down: Twigo contains it where it happens, as [a decision](decisions/panics.md) records.
The hook of `twigo-log` records every panic first (4.10).

- **The app-wide duties** run as tasks of their own under one supervisor, which `Core::start` builds: the catalog's sources, the contexts seen, the terminals' offers, the end of unlocks, the forwards' modes and the network.
  A duty that panics starts again, at most three times in five minutes, and logs it with its name and task id; past that, or when a thread of the core that cannot go on panics (the state writer once its lock is poisoned), or when the policy proxy's accept loop panics, which no restart brings back for the kubeconfigs that name its address, the fatal path runs, and the other duties go on.
  The kubeconfig watch and the state writer are threads, and report to the same supervisor; a start of the watch that panics counts as another panic of it, and a panic of the supervisor's own task takes the fatal path.
- **An item**, a list, an open object, a logs tab, a pod shell, a terminal or a forward, ends where it panicked and is not started again: its owner sends the end the item already has, with the code `internal.panic`, which is a list's last batch in the state `error`, an object's or a logs tab's error, `Failed` for a shell or a terminal, and `failed` for a forward, which the person can resume.
  A logs tab's download asked of a session that panicked answers `internal.panic`.
  A hub upstream that panicked ends `Failed`, so the next list that holds it starts it, and a store a panic poisoned is emptied before that.
  An exec or a port-forward through the policy proxy ends when its context relocks, and when the wait for that relock panics.
- **A plan** whose run panics ends `Failed` with `internal.panic`, its `ended` line in the audit log says `failed`, and its bus entry and undo go free.
  A plan is never retried, since a write must not go out twice.
- **A command** that is async answers `internal.panic`.
  A sync one runs inside Tauri's own handler, which on macOS is called from wry's `extern "C"` URL scheme handler, so a panic there aborted the process (`SIGABRT`, exit 134, in a probe on macOS 27.2.1 with Tauri 2.12.7, 2026-11-21); the invoke handler now runs under `catch_unwind`, and a panic takes the fatal path.
  So do the page-load and window callbacks, after whose panic tao would stop the app with no `RunEvent::Exit`, so with no flush of the state.
- **The fatal path** writes the log, ends every unlock at once, so that the windows, the sessions and the audit log hear each end as at its time, and asks in a native dialog, since the webview may be what the panic broke, whether to restart or quit.
  Before it asks it rechecks every forward against its mode itself, since the forwards' modes duty that would may be the one that died: a forward the mode now refuses fails and ends its connections, and where that recheck panics every forward closes, as at a quit.
  The dialog is a sheet on Twigo's focused window, or its main one, which blocks that window and ends with it.
  Where no window is left, as when the last one's `Destroyed` handler panicked, Twigo is ending already: the fatal path writes the state and asks nothing, since the dialog without a parent is the system's own alert, which would outlive Twigo.
  Either answer writes the state first, and Restart asks Tauri to restart: spaces and forwards come back as they do at any start.
  An answer that comes once Twigo has begun to end does nothing, so an exit never turns into a restart.
- **A joined task's panic** goes on as it was (`twigo_panic::joined`, and `twigo_panic::blocking` for a closure on the blocking pool), so the hook records it once.
- **The rest** is left to tokio, and the hook's record is all its panic leaves: among it the forward's pump, whose row then stops changing, the discovery follower, the metrics poll, a credential plugin's run, whose status stays `running`, the sign-in and fingerprint followers, the terminals' kubeconfig watcher threads, the per-window followers and the proxy's connections.
- `TWIGO_PANIC=<name>` makes the duty or the item of that name panic each time it runs, and the kubeconfig watch at each change of its files, in a build with the app's `inject` feature, which turns on `twigo-panic`'s and which a release build never has: the names are the duties above, `supervisor`, `forward restore`, `list`, `object`, `logs`, `log stream`, `pod shell`, `terminal`, `forward`, `forward recheck`, `hub upstream`, `store lock`, `plan run`, `command`, `policy proxy`, `proxy relock`, and the threads `state writer` and `kubeconfig watch`.

A wasmtime trap ends the extension call, not the app.
Each webview is already a separate OS process managed by the system.
The only extra processes Twigo needs are the ones it must run anyway: exec plugins, shells, native helpers and agents.

**Multiple windows.**
One core process serves every window.
List subscriptions are keyed by `(window, view)`, so a window reaches only its own, and closing or reloading it drops them: a page that starts to load has none of the lists of the page it replaces.
The followers of the catalog, the credentials, the resources, the shell and the keyboard are kept one per window, replaced when its next page subscribes and dropped with the window.
A send ends a follower only when it fails, which Tauri 2.12.7 does only once the event loop is gone: a reloaded page and a closed window both take it ([`Channel`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/ipc/channel.rs#L428-L438), [`send_user_message`](https://github.com/tauri-apps/tauri/blob/tauri-runtime-wry-v2.12.5/crates/tauri-runtime-wry/src/lib.rs#L259-L276)).
Detached editor windows (VS Code's auxiliary windows) come after the MVP.

### 2.2 Repository layout

```
twigo/
├─ apps/desktop/              Tauri app: thin glue; src-tauri only wires crates into commands/channels
├─ crates/
│  ├─ twigo-core/             app services: spaces, settings layers, catalog, command bus and its actions, policy proxy and approval broker
│  ├─ twigo-kube/             contexts, client factory, credential runner, discovery/OpenAPI cache
│  ├─ twigo-cache/            watch hub (upstreams, row stores, query views, batching), the discovery it follows, the metrics poller
│  ├─ twigo-describe/         describers by GroupKind: an object and its related facts → the Overview document (4.3)
│  ├─ twigo-sessions/         logs, exec/attach, port-forward manager, pty terminal
│  ├─ twigo-policy/           read-only modes, authorize(), what an approval covers, audit log, redaction
│  ├─ twigo-quantity/         Kubernetes resource quantities: the describers and the metrics poller read them alike
│  ├─ twigo-env/              login-shell environment resolution
│  ├─ twigo-log/              the diagnostics log's subscriber, the rotating file the audit log shares, the panic hook, the facts of a run, the problems of Twigo's own files
│  ├─ twigo-panic/            the supervisor of the app-wide duties, the helper that ends an item, the join that raises a panic again, the seam that arms a panic by name
│  ├─ twigo-ipc/              protocol types (serde) + TS codegen (ts-rs); channel framing
│  ├─ twigo-keyboard/         active keyboard layout and its changes, from TIS, xkbcommon and ToUnicodeEx
│  ├─ twigo-netmon/           wake from sleep and network changes, from IOKit, SystemConfiguration, logind and rtnetlink
│  ├─ twigo-ext-host/         wasmtime host, manifests, capability enforcement, registry client
│  ├─ twigo-ext-api/          WIT package `twigo:extension` (versioned dirs) + Rust guest SDK
│  ├─ twigo-mcp/              MCP server + `twigo mcp` stdio shim
│  └─ twigo-helm/             Helm release decoding (read); CLI bridge later
├─ packages/
│  ├─ ui/                     design system (from legacy libs/ui)
│  ├─ workbench/              parts, registries, commands, keybindings, context keys, quick access, settings UI
│  ├─ kube/                   explorer, resource tables, resource editors, YAML/diff, logs, terminal views
│  ├─ protocol/               generated TS types + typed invoke/channel client + mock backend
│  └─ utils/
├─ extensions/                first-party extensions built on the public API (fixture + dogfood)
├─ bench/                     kind/kwok cluster scripts, perf harness (harness.sh)
│  ├─ harness/                twigo-bench: churn generator, process sampler, report
│  └─ ipc/                    IPC bench: the isolation pattern's cost, the tier-2 frame probe
└─ docs/
```

Why these crates:

- The core builds and tests without Tauri.
  Integration tests run the real crates against kind and kwok clusters.
- `twigo mcp` reuses the IPC types.
- `twigo-describe` is pure: describers name the related queries they need and turn the object and the answers into sections, while `twigo-core` runs the queries.
  Its tests run on objects recorded from kind, and the UI and `twigo mcp` describe an object alike.
- `twigo-policy` sits under everything that can reach a cluster.
  `twigo-kube` builds its gate into every client, so the crate holds no Kubernetes client of its own.
  What an approval covers is its too, while the policy proxy's server and the approval broker live in `twigo-core`, since they need the context's clients and the windows.
- `twigo-log` holds what logging needs once, so no crate sets up a subscriber of its own: the rotating file that both the diagnostics log and the audit log write through, the subscriber with its run-time filter, the panic hook, the facts of a run and the list of the problems of Twigo's own files (4.10), which is why it depends on `twigo-ipc` for `IpcError`.
  Every other crate logs through `tracing`, and depends on `twigo-log` for no more than a repeated failure's count and the problems it reports.
- `twigo-panic` holds what containing a panic needs once, so the crates that spawn an item or join a task do not each write it: it depends on no other crate of Twigo, and `twigo-kube`, `twigo-cache`, `twigo-sessions` and `twigo-core` use it.
- `twigo-keyboard` keeps the OS's keyboard APIs out of `apps/desktop`.
  It needs no Tauri, and its tests read named layouts without a window.
- `twigo-netmon` keeps the OS's power and network notifications out of the transport, which only learns that the machine woke or the network changed.

`apps/desktop/src-tauri` holds no domain logic.
It translates Tauri commands and channels into calls on `twigo-core`.

### 2.3 Frontend packages

| Package              | Owns                                                                                                                                                                                                                                                                                                                                                             | May import                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `packages/ui`        | Tokens, and primitives (shadcn/Radix) for every recurring pattern: actions and their menus, tones and status dots, counts, keys, fields, segmented controls, view switches (`TabBar`), the data grid, the tree, the line list and styled text, the histogram, property lists, sections, callouts and banners, toasts (`notify`), empty, loading and error states | —                             |
| `packages/workbench` | Layout parts and the panel's own dockview, contribution registries, command, menu, keybinding and context-key services, the list service and its `list.*` commands, quick access, the toaster and notification centre (4.7), settings UI, spaces UI, editor service over the editor area and the panel                                                           | `ui`, `protocol`              |
| `packages/kube`      | Every Kubernetes view and editor, column rules and cells, status entries; registers into the workbench registries                                                                                                                                                                                                                                                | `ui`, `workbench`, `protocol` |
| `packages/protocol`  | Generated request and response types, a channel client with seq/ack, and a **mock backend** that runs the UI in a plain browser on fixtures (design reviews, component tests)                                                                                                                                                                                    | —                             |
| `packages/utils`     | Pure helpers without React or IPC, such as formatters                                                                                                                                                                                                                                                                                                            | —                             |
| `apps/desktop/src`   | Bootstraps the workbench, registers `kube`, and applies the interface zoom to the webview (`zoom.ts`)                                                                                                                                                                                                                                                            | all                           |
| `apps/desktop/bench` | The bench mode's entry and driver, built only by `vite build --mode bench` ([bench](bench.md))                                                                                                                                                                                                                                                                   | all                           |

Every package may import `utils`.
The ESLint boundary rule from legacy now enforces the whole table; above all, `workbench` must not import `kube`.
The workbench only learns about Kubernetes through registries.
Contributions are data that the workbench renders, menus become `ui` actions through `workbench.actions`, and outside `ui` and the workbench's parts class names only lay things out ([decision](decisions/frontend-architecture.md)).

## 3. Data flow: watchers → cache → batching → UI store

### 3.1 Pipeline

```
kube-apiserver
  │ Table list/watch           single-object GET + watch      metadata watch
  │ (as=Table, includeObject=  (editor open)                  (namespaces, CRDs, APIServices,
  │  Metadata)                                                 owner index)
  ▼
Upstream  (context × GVR × scope × server-side selectors)   ref-counted · linger 60 s · per-cluster budget
  │ decode rows; managedFields skipped at deserialisation; typed cells
  ▼
RowStore  uid → Row { meta-lite (name, ns, uid, rv, labels, owners, created, received), cells[] }
  │ change set
  ▼
QueryView  (per subscription: namespaces, label filter, text filter, values, groupBy, sort, window)   incremental ordered index
  │ window diff
  ▼
Batcher   coalesce by uid · flush ≤ 50 ms · one unacked batch · paused while hidden
  │ Channel (JSON): { seq, total, columns?, window?:{start, ids}, upserts, status, groups? }
  ▼
View store (frontend)   Map<id, Row> + version, read via useSyncExternalStore
  ▼
Virtualized table (TanStack Virtual, fixed row height; TanStack Table for column state only)
```

### 3.2 Upstreams: what is watched

- **One upstream per `(context, GVR, scope, server-side selectors)` and kind (3.3), shared by every view.**
  A name that can be no path segment, as Kubernetes' `IsValidPathSegmentName` has it, is refused before any request, since the API server decodes `%2F` before it routes.
  Subscribing increments a reference count.
  When the last subscriber leaves, the upstream lingers for 60 s so going back and forth costs nothing, then it stops.
- **Watch only what is visible.**
  - A subscription lives as long as its view or editor is visible.
  - Background tabs and inactive spaces unsubscribe.
    Their upstream lingers, then stops.
  - Coming back resumes from the last `resourceVersion`, or relists on `410 Gone`.
- **Scope follows the namespace selection.**
  - One upstream per selected namespace, so looking at 200 pods in one namespace never watches the cluster's 50k.
  - More than a few selected namespaces (default 4) switch to one cluster-wide upstream, if the person may list the kind cluster-wide.
    Rust then filters by namespace.
  - **"All namespaces" lists the namespaces where the person may list the kind.**
    - One SelfSubjectAccessReview asks whether they may list it cluster-wide, and the clients keep its answer: a yes for their life, a no for 30 s.
      A yes keeps one cluster-wide upstream, as for any selection of more than four.
    - A no resolves the set: the names of the namespaces, a review of each, at most 8 at a time, and an upstream per namespace that a review allows.
      The names come from one list request of the namespaces' metadata, in pages as the hub lists, which takes a request slot and never waits for a watch; the picker's `namespaces_list` reads them the same way, once per opening, and tries a transient failure again with the backoff for 10 s before it answers `stale`, while a refusal answers at once.
      A review that another asker has under way is not sent again, so lists opened together ask each question once.
      The set is kept per context and resource with the clients, for 5 minutes: every list of all namespaces of that resource opened meanwhile reads it and sends no review.
      The first list after that reads it too, at once, and the hub resolves it again in the background, so a sort or a filter never starts empty; the lists opened after that show a namespace created or a binding granted since, and an open list keeps its parts.
      A resolution asks again the cluster-wide review, whose no is kept 30 s, and the namespaces that were refused or did not answer, and keeps the ones allowed, since a yes is kept for the clients' life, as the server still decides: a namespace revoked since stays in the set, its part refused and saying so, until the clients are rebuilt.
      Only a resolution that answers every question replaces the set, with a set that may be empty, as the cluster-wide yes and a refusal come to: one that fails, or leaves a review unanswered, keeps the set it renews, and the next list resolves it again.
      A set with no namespace, which the cluster-wide yes, no namespace allowed and a refusal to list the namespaces come to, is kept for 30 s, as long as a review's no, so a grant shows within it and a sort or a filter inside it asks nothing.
    - `Parts.omitted` counts the namespaces the cluster lists that the parts per namespace leave out, and is 0 beside the cluster part (3.7).
    - With no namespace allowed, or the list of namespaces refused, which is a person who may not list namespaces, "all" is the cluster part, which the cluster refuses in its own words.
      Such a person types the namespaces they read in (4.5).
    - What does not answer is no answer.
      A namespace whose review does not answer counts as allowed, as an unanswered check does in the UI (5.1): its part lists and says its own state, and with no set to renew the next list resolves it again.
      The clients may take long to come, as they do while a credential plugin signs the person in, and they, the cluster-wide review or the list of namespaces may fail without a refusal: a 429, a 5xx, a timeout or a connection that broke.
      The hub settles what "all" reads apart from the list's subscription, which returns at once, and tries again with the backoff below: the subscription has no part and says what it waits on, the clients' error while they fail and else `connecting`, never the cluster's refusal.
      Clients that say `unauthorized`, and a review or the list of namespaces that the cluster answers with a 401 or a failed credential plugin, stay so until a new subscription asks, since a retry would run the plugin by itself.
      A review that the server refuses itself, which waiting does not change, leaves all namespaces to the cluster part, which says the server's own answer; it is kept 30 s, as a review's no.
    - On kind 1.37.0 (2026-11-21, a scratch probe that opens the list through the hub, with a delay added before each request as an assumed round trip, not a remote cluster's), a person allowed 3 of 46 namespaces had rows 32–34 ms after the list opened and 517–524 ms with 50 ms added; allowed 3 of 206, 71–162 and 1670–1718 ms; a cluster admin's first rows come 52–67 ms later than they did with 50 ms added, for the review that asks first (three runs each at 46 and at 206 namespaces, 58 and 60 ms on average), and on loopback within the runs' spread (21–23 ms before and 23–27 ms after at 46, 35–56 and 32–40 at 206).
    - The 8 reviews at a time leave the context's request slots (28) to the rest of the UI: at 206 namespaces and 50 ms added, the home page's three namespaced kinds, 621 reviews, had rows at 1779 ms with 8, 1521–1571 ms with 16 and 1462–1520 ms with 28, and an unrelated request took 55, 81 and 219 ms meanwhile.
  - Hysteresis: while a cluster-wide upstream runs or lingers, it serves narrower selections too, without holding it, so toggling back and forth costs nothing.
    Once it has lingered out, those selections move to upstreams per namespace, and keep its rows until theirs are listed.
    A person refused cluster-wide never has one.
  - A new space starts on the namespace its kubeconfig context names (`Context.namespace`), else on all namespaces.
- **Label selectors** are applied in Rust, because labels are in the row metadata.
  Field selectors always go to the server as their own upstream: row metadata does not carry the fields they match.
- **One HTTP/2 connection per cluster.**
  kube-rs's default client speaks HTTP/1.1 only: hyper is built with `http1` alone, as checked in `kube-client/Cargo.toml` at 4.2.
  So each context has two shared hyper-util clients of Twigo's own: an HTTP/2 one for requests, watches and followed logs, and an HTTP/1.1 one for exec, attach and port-forward, whose WebSocket upgrade fails over HTTP/2 with 400.
  Every actor's kube clients sit over them (6.2, 6.4, [HTTP/2 spike](spikes/http2.md)).
- **Per-cluster budgets.**
  - kube-apiserver allows 100 concurrent streams per connection by default.
    A request beyond that waits for a free stream, and hyper opens no second connection.
    It reports neither the server's limit nor the wait.
  - So one stream counter per context, a single state shared by every actor, sits below the per-actor policy layers (6.4).
    The hub, commands, discovery, MCP tools, extensions and the policy proxy all pass it.
    A stream takes a permit for its class when it starts and keeps it in its response body until the stream ends.
  - The classes and their defaults:
    - watches, 24;
    - followed logs, 32;
    - the policy proxy's streams, 16;
    - requests, the 28 left.
      Actors other than the UI may hold at most 20 of them, so an agent's lists cannot starve the UI, and a context's metrics polls take at most 4 of the UI's at a time (3.6).
  - A watch, log or request over its budget waits in the counter and shows `queued`.
    The proxy's class refuses instead, with the `429` of 6.4.
  - A request the policy proxy sends carries a marker, `Proxied`, that makes the counter take a stream of the proxy's class whatever its URI, a watch or a followed log included, so it never waits among the hub's, and fail at once with `OverBudget` when they are all taken.
  - The credential layer drops a `401`'s response before its retry, so no request holds two streams: with a budget of one, a request's retry waited for its own first try, or the proxy's refused it (`a_retry_after_a_401_goes_through_a_full_budget_of_one` in `crates/twigo-kube/tests/credentials.rs`).
  - Timeouts start when the counter admits a stream.
    A per-request timeout, a tower layer rather than a socket read timeout, backs the counter up against a server with a lower limit.
    It gives the response's headers 70 s, more than the 60 s the API server allows a request that is not long-running, so it cuts nothing the server still works on.
  - The connection's flow-control window covers every stream the counter admits.
    h2 takes a DATA frame from the connection's window when it arrives and gives it back only as the stream's body is read ([`recv.rs`](https://github.com/hyperium/h2/blob/v0.4.20/src/proto/streams/recv.rs#L465-L497), [`incoming.rs`](https://github.com/hyperium/hyper/blob/v1.12.0/src/body/incoming.rs#L185-L190)), so a body nobody reads keeps up to a stream window of the connection's, and hyper's defaults are 2 MiB a stream and 5 MiB a connection ([`client.rs`](https://github.com/hyperium/hyper/blob/v1.12.0/src/proto/h2/client.rs#L48-L49)).
    The third unread stream freezes the others: their headers come, which no window limits, and their bodies never do, so a request waits without failing (`streams_nobody_reads_do_not_hold_up_a_request_on_the_connection` in `crates/twigo-kube/tests/clients_live.rs`, run with `crates/twigo-kube/src/client.rs` built without its two window settings and the test's loop at one to four lists: on kind 1.36.4, 2026-11-20, one or two unread lists of 3 MiB left `/version` its body and three or more kept it for more than 5 s; the test as committed, with the window below set, gets the body with sixteen unread lists).
    So the `api` client sets the stream window to 2 MiB, hyper's default, and the connection window to that times every stream its counter admits: watches, logs, requests and the proxy's, 100 by default, 200 MiB, capped at 2^31-1, the most a window can be.
    The context's budgets decide it, so a raised budget raises the window.
    Sessions are not counted, since each has a connection of its own on the HTTP/1.1 client.
    The streams the counter admits then cannot fill the connection's window between them.
    The price is memory: a stalled stream holds up to its 2 MiB of body until it ends, which the proxy's 16 streams can reach together, 32 MiB; the resident size measured in a scratch client was about 4 MB a stream, so about 64 MB (a debug build against kind 1.36.4, 2026-11-20, not repeated with the shipped window).
  - Sessions, meaning exec, attach and port-forward connections, have their own budget (default 64), counted in the same place below every actor.
    A session's permit outlives the `101` response, which `hyper::upgrade::on` drops: the task of the session holds it, a shell's or a forward's connection's, not the upgraded stream, and so does the policy proxy's splice.
    A proxied upgrade takes its session from this budget, not the proxy's 16, and over it gets the proxy's `429` instead of waiting (6.4).
  - A proxy or server that answers HTTP/1.1 turns every stream back into a connection; the budgets stay the same.
    Benchmarks tune each of them.
  - When the watch budget is full, the least recently used idle upstreams are evicted.
    The counter tells a watch that it waits, through an extension of its request, and that is when the hub evicts one: an idle upstream with a watch open, since evicting one in its backoff or in a paged list frees none.
    The freed watch goes to the one that has waited longest, as the counter admits them in order, and an upstream whose watch waits while nobody shows it goes at once, so it takes none from one that is shown.
    When nothing is idle, the new subscription waits in the state `queued` and its view says why, until an upstream of the context lingers and makes way at once, or a watch ends.
  - A watch ends after its `timeoutSeconds` and asks the counter again, behind the one that waits, since the counter's semaphore is fair (tokio's `Semaphore` hands permits out in the order they were asked for).
    So over the budget, once the watches end, the one that waits takes a watch and a part that had one waits in its place as `queued`, keeping its rows as `stale` (3.7), until the next watches end.
  - When the log or session budget is full, a new log stream, exec session or port-forward connection waits in `queued` the same way.
    Its tab says why, and the status bar lists open sessions so the user can close some.
  - Nothing fails silently.
- **Dead connections.**
  kube 4.0 removed the global read timeout, and a watch can stall silently after sleep or a network change.
  - Every watch sets `timeoutSeconds`, kube's 290 ([`params.rs`](https://github.com/kube-rs/kube/blob/5.0.0/kube-core/src/params.rs#L383)), and uses TCP keepalive.
  - The HTTP/2 connection sends keep-alive pings, while idle too, since one dead connection now stalls every watch of the cluster.
    A failed ping closes it.
    Both take client-go's timings: keepalive after 30 s, and a ping once the connection has read nothing for 30 s, answered within 15 s.
  - A request the server never processed is retried once, whatever its method (RFC 9113, 8.7): a stream above the last one a GOAWAY names, whatever its code, or one refused with `REFUSED_STREAM`.
    The streams below that id run on, and fail if the connection closes under them.
  - An idle timer expects an event or a bookmark within 120 s: the watch cache sends a bookmark roughly every minute ([`nextBookmarkTime`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/storage/cacher/cache_watcher.go#L233-L264)), so two are missing.
    When it fires, a probe, `GET /version`, goes over the shared connection first.
    If the probe gets any answer, only that upstream re-watches.
    If it gets none, the connection is retired and every upstream re-watches, as on wake; idle upstreams whose probes fail together retire it once.
    The probe's body has 15 s from its headers, client-go's ping timeout: the request timeout above covers headers only, and a connection whose flow-control window is full still delivers headers, since only DATA frames are flow-controlled ([RFC 9113, 5.2.1](https://www.rfc-editor.org/rfc/rfc9113#section-5.2.1)), but never the body.
    The headers keep the request timeout, which starts once the stream counter admits the probe, so a probe that waits for a request slot is no answer only when the connection is.
    A probe that times out is no answer, and the body is read and dropped.
  - On wake from sleep, every connection is retired and every upstream re-watches.
    `twigo-netmon` hears of it from IOKit's system power notifications on macOS, as Chromium's and Firefox's power monitors do, and from logind's `PrepareForSleep(false)` on Linux.
  - On a network change, a context's connections are retired only when the route of one of its live api connections moved: the kernel would now send to that connection's server, or its proxy, from another address, or not at all.
    A context with no live api connection has no route to judge, so a network change retires nothing there.
    `twigo-netmon` hears of a change from SystemConfiguration's dynamic store on macOS, which tells the addresses of services and interfaces, and from rtnetlink's address and route groups on Linux, where an overflow of its buffer counts as a change, and passes a burst on once it has been quiet for a second.
    On macOS a change of routes alone, without an address, goes unseen.
    Chromium closes every HTTP/2 session on any address change, which Docker's interfaces set off on Linux; here containers, kind's bridge and VPNs for other networks leave connections alone, while a Wi-Fi switch or a VPN in front of the cluster retires them.
    A move to another network that keeps the address goes unseen until a ping fails, 45 s at most.
  - A wake and a moved route of a live api connection are also counted apart, as a change of the network (`Connections::network`), which ends the sessions of exec and attach (4.6): their sockets are on the sessions client, whose connections a retirement does not reach, and a retirement from a new certificate or a failed probe says nothing of them.
    Only the api client's connections are tracked, so a context with a shell and no live api connection hears a wake but no network change: its shell ends later, when the kernel fails its socket, as `ConnectionLost` (how long that takes: not measured).
  - Retiring poisons the connection: the pool keeps a dead connection that still looks open, and every actor's client holds a clone of that pool, so rebuilding one client would not reach the others.
    The streams on it run until their upstreams re-watch.
  - While a client has no usable connection, one request dials and the others wait until it is connected or has failed: a cold client opens one TCP and TLS connection per concurrent first request and keeps only the first that negotiates `h2` ([HTTP/2 spike](spikes/http2.md)).
    After a failure the others go together, so none waits out another's timeout.
    A connection counts as usable once it has carried a request, which only a connection in hyper-util's pool does, and stops once it is retired or closed, once a request learns that the server is going away, or once hyper-util dials past it, as a GOAWAY that came between requests makes it do.
    The requests such a GOAWAY hands back unsent, hyper-util sends again itself, dialling a connection for each, which no layer above it sees.
  - Views show `stale` while this happens.
- **Initial list.**
  - Every list and watch asks for gzip and is decoded by its `Content-Encoding` (`twigo_cache::encoding`).
    kube-apiserver compresses an answer above 128 KiB ([`writers.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/responsewriters/writers.go#L152-L155)), and from 1.37 a streaming list as one gzip member at every flush ([`watch.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/watch.go#L334-L346)), so a stream is decoded member after member.
    No tower layer does it: tower-http 0.7.1's gzip decoder reads the first member only ([`body.rs`](https://github.com/tower-rs/tower-http/blob/tower-http-0.7.1/tower-http/src/decompression/body.rs#L338-L352)), and the policy proxy shares the client stack.
  - A streaming list (`sendInitialEvents=true`) where the server compresses streaming lists, which the answer's headers say: one that comes without `Content-Encoding: gzip` pages its group-version at once, before its body is read, since its pages come gzipped and its stream would not.
    So 1.37 and later stream, and 1.34 to 1.36 page, as do aggregated servers on older libraries.
  - Otherwise a paginated list followed by a watch from its exact `resourceVersion`.
  - Any refusal of a streaming list pages its group-version too: a 400 or a 422 whatever its cause (1.33 answers 422 on `sendInitialEvents`, a library of Kubernetes 1.19 to 1.26 on `resourceVersionMatch`), and before the end bookmark the response ending, an `ERROR` event, a `DELETED`, a bookmark without the annotation, a line that does not decode, or 30 s without a line while `GET /version` answers.
    kube-apiserver's watch cache sends its snapshot as `ADDED` and the end bookmark straight after it ([`cache_watcher.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/cacher/cache_watcher.go#L450-L530)), so on a server that streams these come only from the server ending the list itself.
    It sends one `ERROR` event and ends the response in three cases: its watch cache is more than 3 s behind etcd (a 504, [`waitUntilFreshLocked`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/cacher/watch_cache.go#L354-L358), `blockTimeout` at [L49](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/cacher/watch_cache.go#L49)), reading etcd's current version fails, and its check of etcd's watch-progress feature has not answered yet ([`Supports`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/feature/feature_support_checker.go#L91-L97)), each of the last two a 500 ([`Watch`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/cacher/cacher.go#L576-L584), [`newErrWatcher`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/cacher/cacher.go#L1400-L1415)).
    It ends the response with no event when the cacher goes unready meanwhile ([`Watch`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/cacher/cacher.go#L650-L651), [`newImmediateCloseWatcher`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/storage/cacher/cacher.go#L671-L677)), at `timeoutSeconds` and when the server shuts down, in any phase ([`watch.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/watch.go#L425-L437)).
    Each of these pages that group-version until its clients are rebuilt, which costs a 1.37 list its streaming and not its gzip.
    A 401, 403, 404, 405, 429, a 5xx, a connection error, a retirement and a probe without an answer are no refusal: each is handled as for a watch, and the group-version keeps streaming; a silent stream on a dead connection retires it and streams again.
  - A first list that falls back clears what the stream stored and lists in pages from scratch in the same call; a relist drops what it collected, and keeps its old rows, `relisting`, until its pages end.
    An upstream counts as listed only once a whole list has ended.
  - The fact is kept per group-version, the unit an APIService serves, with the context's clients, as are the access reviews of the scope: clients rebuilt for another server learn them again, a retirement keeps them, and a group-version once paged is not asked for a stream again while its clients live.
  - A relist, after `410 Gone` or over rebuilt clients, keeps the rows on screen and replaces them with its own once it ends.
  - A changed fingerprint or proxy variables, or a context no source lists any more, retire the connections of its clients at once, so its watches re-open over rebuilt clients and relist, or show that no source lists the context.
    Such clients are abandoned, not only retired: a watch that starts on them later still learns that they were replaced, which a count of retirements, followed from the moment it subscribes, would not tell it; so are clients a build finishes after such a change.
  - A resource the server cannot watch, which answers a watch with 405 as ComponentStatus does ([`handleWatch`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go#L268-L270)), is listed in pages again every 15 s.
    Metrics are not relisted by the hub, which would reset every reader on every poll, linger 60 s after the last, and spend a watch on the 405: the poller of 3.6 reads them.
- **Backoff.**
  UI-friendly: 0.5–5 s with jitter, reset by an event that is not an error, so a server that answers every watch with an `ERROR` event is not asked again every second.
  kube-runtime's default of 0.8–30 s leaves lists stale for a long time after an API-server restart.
  A watch the server ends without sending anything reopens after the backoff too.
- **Refusals retry too.**
  A `forbidden` or another error shows in the view while the upstream keeps trying with the backoff: a kind 1.33 API server answered a watch it had allowed with 403 for a while after a restart (`restart_live`, 2026-11-02).
  A part that has never listed, whose first list got a 403, waits 30 s and the backoff's jitter (30–60 s) between tries instead, the time the hub keeps a review's no: a person who may not read a namespace stays refused, and the 37 parts refused of a selection of 40 sent 9.75 requests a second at the backoff, 197 of 200 sent 52.75 (kind 1.37.0, 2026-11-21, a service account bound in 3 namespaces, over a selection of every namespace).
  A subscription that holds such a part anew ends that wait once it has run 5 s, the ordinary backoff's longest, and tries then, so Retry after a grant and a list opened again try within 5 s of the refusal, and a filter typed over many refused parts asks each at most once per 5 s; an open list keeps its 30 s.
  Only `unauthorized`, a 401 the auth layer's retry did not cure or a credential plugin that failed, stops the upstream until a subscription asks for it again, since retrying would run the plugin by itself.

### 3.3 Three upstream kinds

| Kind         | Request                                                                                                                                                                                                                | Used for                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Table**    | `GET …?watch=true&allowWatchBookmarks=true&includeObject=Metadata` with `Accept: application/json;as=Table;v=v1;g=meta.k8s.io, application/json`, read through `Client::send`, decoded by its `Content-Encoding` (3.2) | Every list, for built-in kinds and CRDs alike. The server computes the columns, the same as `kubectl get -w`.                                                                                                     |
| **Metadata** | List and watch with `Accept: application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1` and `…as=PartialObjectMetadata…`, managedFields skipped at deserialisation                                              | Indexes: CRDs and APIServices (discovery invalidation), and owner references for the "Related" tab.                                                                                                               |
| **Object**   | List and watch with `fieldSelector=metadata.name=…`, another field selector or none, as a Table with `includeObject=Object`: whole objects with their cells                                                            | An open editor: live YAML, overview, conflict detection; an object's events; what its describer reads while it is open, such as a namespace's ReplicaSets or EndpointSlices, or a node's pods by `spec.nodeName`. |

All three run on the hub's own list and watch rather than kube-runtime's `watcher`, which 5.0 cannot start from a `resourceVersion` once it is recreated, nor tell to re-watch on wake or after a probe: it reopens a quiet watch only after `timeoutSeconds` and 5 s, without a probe ([`next_with_idle_timeout`](https://github.com/kube-rs/kube/blob/5.0.0/kube-runtime/src/watcher.rs#L529-L548)).

Table details that the decoder handles, checked on kind clusters from 1.33 to 1.37 ([Table decoder spike](spikes/table-decoder.md)):

- `columnDefinitions` arrive only in the first object of each response: every list page, and the first event of each watch connection, a BOOKMARK included.
  The decoder keeps them per upstream, across pages and reconnects.
- Every watch event carries a Table with exactly one row.
  A BOOKMARK is a Table too: one row of placeholder cells whose object holds only the `resourceVersion`.
  It never becomes a row.
- `row.object` is a `PartialObjectMetadata` and still includes managedFields.
  The serde struct for rows names neither managedFields nor annotation values, so they are never allocated.
- If table conversion fails, the server sends the raw object, and when that was a connection's first event, no definitions follow on it.
  A raw object becomes a row with its Name and Age cells and empty others.
  Rows with no definitions known fail to decode, and the hub reconnects.
- Cells follow their JSON type, not the column's declared type: ConfigMap Data is declared `string` and sent as an integer.
- Column `priority` 0 is the default view; higher priorities appear only in the wide view (k9s `ctrl-w`).
- Age cells and the other durations the server prints are strings it works out once, as it encodes the row ("5m").
  Rust recomputes Age from `creationTimestamp`.
  An Age column is the one named Age that prints `creationTimestamp`, built in or as a CRD printer column.
  The other printed durations are a column's whole text or its end, as a pod's Restarts, `3 (5m ago)`: the decoder marks them by resource and column (`table::PRINTED`: a pod's Restarts, a CronJob's Last Schedule, an event's Last Seen and First Seen, in core and `events.k8s.io` events alike), and marks every `date` column, which a custom resource prints as a duration.
  A custom resource's other string columns hold what their JSONPath finds, whatever their name, so none of them is marked.
  A marked column says so on the wire as `printsDuration`, and the webview draws its cells from the time the row's cells arrived (3.4, [decision](decisions/printed-durations.md)).
- Every server built on `k8s.io/apiserver` implements Table, aggregated ones such as metrics-server included.
  A server that does not answers through the JSON fallback with raw objects, which get the metadata columns, Name and Age; the namespace comes from meta-lite, as for every kind.
- Some objects have no uid or resourceVersion: ComponentStatus.
  Their rows keep only a name, and the row store keys them by namespace and name.
- An empty Table may send `rows: null`, and metrics-server then sends no column definitions either.

**Custom columns.**
Users (k9s `views.yaml` style) or extensions can define JSONPath columns for a GVK.
For that GVK only, the upstream switches to a _projection_ watch: Rust watches full objects, evaluates the JSONPaths, keeps meta-lite plus the cells, and drops the object.
The memory cost stays at row level and the CPU cost is paid only for kinds that need it.

Memory for 5,000 pods on kind 1.37 with kwok (`bench/pods.sh`), counting allocator, requested bytes ([Table decoder spike](spikes/table-decoder.md)):

| Representation                                 | 5k pods |
| ---------------------------------------------- | ------- |
| Full Pod                                       | 137 MiB |
| Pod without managedFields                      | 85 MiB  |
| `PartialObjectMeta<Pod>`                       | 60 MiB  |
| `PartialObjectMeta<Pod>` without managedFields | 7.4 MiB |
| Table row                                      | 3.4 MiB |
| The hub with one Table upstream                | 4.0 MiB |

A Table row takes about 700 bytes, half of a `PartialObjectMeta<Pod>` without managedFields.
The hub's row store adds about 130 bytes a row for its key and map, by `examples/hub_memory.rs` on the same cluster (2026-11-02, three runs alike).
A row's meta-lite (`Meta`) is 128 bytes and the row (`Row`) 144, held by const assertions in `twigo-cache`, so an `Arc<Row>` with its two counters asks for 160 bytes, which macOS 27.2's malloc keeps in a class of 160 where 176 would take 192 (`malloc_size` after `malloc`, 2026-11-17).
`created` and `received` (3.4) are milliseconds in `i64`s rather than timestamps to fit in it, so the stamp costs a stored row nothing; `hub_memory` was not run again since it came.

### 3.4 Query views: Rust sorts, filters and windows

The frontend never holds the full list.
A subscription carries a `ListQuery { space, gvr, namespaced, namespaces, labelSelector, fieldSelector, owners, text, columns, sort, countBy, groupBy, values }`.
The field selector goes to the server with the list's requests, as a node's pods need; `owners` keeps the rows whose controller reference names one of its uids, an empty set none, after the labels and before the text and the counts, as a workload's pods are its ReplicaSets'.
`namespaced` comes from discovery, which the webview holds already, so a list subscribes once its space's resources are known: Rust needs the scope for the request's path and for the Namespace column, which a cluster-scoped kind never has.
The webview then sends `setWindow(start, end)` as the user scrolls, covering the visible rows plus about two screens of overscan.

- Rust keeps an incremental ordered index per query view, indexset's two-level B-tree with a Fenwick tree over its nodes: a change finds its place in O(log n) and shifts at most a node of 1,024 entries, and one that fills or empties a node rebuilds the Fenwick tree, O(n/1,024).
  - Cells carry their column type, but many core columns are formatted strings: Pod Ready `1/2`, Restarts `3 (5m ago)`, Age.
  - Rust derives sort keys: a ratio by its fraction, then its total, `0/0` as whole; a count such as `3 (5m ago)` by the count, then the duration; durations such as `1h5m` in seconds; Age by `creationTimestamp`, the youngest first.
  - A column that prints a duration (3.3) sorts instead by the moment its cell stands for, the row's `received` less the printed age, the latest first as in Age, and a pod's Restarts by the count, then that moment: the moment does not move as time passes, so nothing is sorted again as the ages grow, and the order is the order of the ages the webview draws.
    A cell of such a column that reads as no duration, as `<unknown>`, sorts as text.
    Other text sorts naturally: runs of ASCII digits by value, ASCII letters folded, ties by code points.
    Empty cells come first, then numbers, ratios and text; rows with equal keys follow their ids, ascending in either direction.
  - A CPU or Memory cell is an integer of nanocores or bytes, empty for a row without a sample, which sorts last in both directions; no text filter, count, group or value reads it (3.6).
  - A sort, a count, a group or values for a column the list lacks do nothing, and no sort sorts by Name.
- Each reader of a row store has a feed of the keys changed since it last read, coalesced, and a key added since then and deleted again leaves it, so it holds no more keys than the reader held and the store holds, however long the reader waits.
  A flush drains it, updates the index row by row and computes what changed **inside the window**; a relist, new columns, new upstreams or a part that starts or stops showing send every row again.
- Text filter on the columns the table shows, Name always among them: a substring in any case of ASCII letters; `!` before it keeps the rows without one; `/…/` is a case-insensitive regex, and `!/…/` its negation.
  Until the closing slash the text stays a substring, so typing a regex never turns the list into an error; a closed regex that does not parse is refused.
  In a column that prints a duration the filter reads no age, since the age on screen is no longer the one printed: it reads a pod's Restarts by its count, and nothing of a cell that is only a duration; counts and groups by value read the text as printed.
  Fuzzy matching belongs to Quick Access (4.5), not to tables.
  `columns` carries the user's choices by name, and Rust resolves them against its own columns, so the first batch already filters right and a choice for a column the list lacks, such as Namespace under one namespace, does nothing; without choices the columns of priority 0 count.
- Label selectors are matched in Rust against each row's labels, with the grammar and checks of apimachinery's `labels.Parse`.
- Values keep the rows whose column holds one of them, such as a pod's Status in CrashLoopBackOff or Error.
  `countBy` counts the rows that the labels and the text keep before values drop any, so a filter by health keeps every health's count.
- `groupBy { column, collapsed }` groups the rows by a column's text: groups in the natural order of their values, the empty value last, and rows within a group by the sort.
  Only groups with a matching row show; a batch carries them whenever one appears, goes, moves or changes, each with its rows and its own `countBy` counts, counted before values drop any.
  A collapsed group's rows still count, but they leave the sequence the window indexes, so `setWindow` and the window cover only the rows of open groups; the webview puts each group's header before its rows (4.4).
- Each row says where the generated part of its name starts, when the name is its `generateName`, cut to 58 bytes as the API server cuts it, and the five characters the API server appends: after the `generateName`, less a `pod-template-hash` it ends with, so a Deployment's pod `api-7f9c8d6b5-x2kq9` reads `api-` and a generated `7f9c8d6b5-x2kq9`, which the list draws as a hash and a last segment, and a StatefulSet's `db-0`, whose `generateName` is `db-` but whose controller names it, has none (4.4).
- Each row carries `received`, the time the core received its cells, beside `created` and in the same form, RFC 3339, to the millisecond, so the webview can count a printed duration back from the moment the server printed it ([decision](decisions/printed-durations.md)).
  - A watch event is stamped as its line arrives, and a list page as its response starts, once its status and headers are in: the server prints a row's ages as it builds the answer, so a page stamped once its body is whole, seconds later on a slow link, would count every age from a later moment than it was printed at.
    The time comes from the hub's clock, which its tests set.
  - A row keeps the stamp it has, whatever else in it changed, while each of its printed durations can stand for the moment the held print stands for (`printed::keeps_stamp`): the new text reads the age the held one read, and less than that age's step has passed since, give or take 2 s, the margin `HumanDuration` gives clocks out of step ([duration.go](https://github.com/kubernetes/apimachinery/blob/v0.37.2/pkg/util/duration/duration.go#L49-L54)).
    The step is the unit the server prints the age in: a second below ten minutes, a minute below eight hours, an hour below eight days, a day below eight years, then a year ([duration.go](https://github.com/kubernetes/apimachinery/blob/v0.37.2/pkg/util/duration/duration.go#L48-L93)).
  - So a pod printed again, by a relist or by a change of its status under the same restart age, keeps its stamp, and sends nothing when its cells read as before, while an age that reads otherwise, or an event's Last Seen that reads `0s` again 3 s or more after the held print (its second and the 2 s margin), as each repeat of the event prints it, takes the new stamp.
  - The view sends a row again when its stamp changed, as when a cell did, since the webview draws its ages and the sort orders it by the stamp; by the rule above that happens only when a moment moved.
  - The mock backend stamps rows and keeps their stamps by the same rule, and `packages/protocol/src/printed-cases.json` holds cases that both it and Rust run.
- A list sends the rows of each part that has listed and is not refused, whatever the other parts are, so a view of 22 namespaces, one of them forbidden, shows the rows of the other 21, and its sort, filter, counts, groups and total are exact over them (3.7).
- The mock backend sorts, filters and groups by the same rules, and `packages/protocol/src/query-cases.json` holds cases that both it and Rust's query view run.
  Its regexes are the browser's, which agree with Rust's `regex` crate only where both the pattern and the text are ASCII, without carriage returns, in the syntax both have, since the crate's `\d`, `\w`, `\s` and case folding follow Unicode and its `.` matches a carriage return, and it prints numbers as JavaScript does, `1e-7` where Rust prints `0.0000001`: the shared cases keep to what both read alike.
  It sends the pod columns once a list knows them, from its first page on, and an empty list of columns before, as Rust does.
- Multi-context spaces (7.2): the query view merges the upstreams of several contexts and adds a Context column.
  Row identity is `context/namespace/name` already, so one-context spaces, all that M1 serves, need no change then.
- Selections and bulk actions refer to row IDs, so "select all 5,000" never ships 5,000 rows.

This scales to 50k rows.
Shipping every row would cost about 15 MB of JSON, plus a sort on the UI thread after every batch.

### 3.5 Batching and flow control

- One Tauri `Channel` per subscription.
  Channels deliver in order.
  Payloads over 8 KB travel via the `ipc://` fetch path, not `eval`.
  Global events are used only for rare notices: catalog, settings, policy prompts.
- Coalescing by uid inside a flush window, in the row store's feed (3.4), which holds the keys and reads each row as it is at the flush:
  - the latest version wins;
  - a delete wins;
  - add followed by delete sends nothing;
  - add followed by modify is sent as add.
- One task per subscription flushes on a tokio interval (`MissedTickBehavior::Skip`) that each batch restarts, so 50 ms after its last batch, or sooner when the window changes.
  The interval waits while a batch is unacknowledged, so a hidden window wakes nothing, and an ack later than the tick flushes at once.
  A window that changes while a batch waits for its ack goes out with the ack, not on the next tick.
- **Credit-based flow control.**
  - Channels have no backpressure, so the frontend acknowledges every `seq`.
  - Rust keeps at most one batch unacknowledged and keeps coalescing while it waits.
  - Memory stays bounded by the number of rows, and a slow frame merges updates instead of queueing them.
- Delivery pauses while the window is hidden or minimised: the list client acks on an animation frame, which a hidden window does not run, so the batch in flight stays unacknowledged.
  The next flush carries everything that changed in between.
- On macOS a Channel with this flow control carries 5,300 batches of 2 KB or 460 of 1 MB a second, and 20 subscriptions flushing on the same tick see 3.9 ms at p95 from send to ack ([isolation spike](spikes/tauri-isolation.md)).
- Rows are serialized once in Rust.
  The frontend uses the browser's native `JSON.parse`.
  Terminal and exec bytes go as raw binary (`ArrayBuffer`).

### 3.6 Opening an object, and what is never pre-fetched

- **Opening an object.**
  `GET` the full object, then start an Object upstream for live changes.
  - managedFields stay on the Rust side: they serve conflict display and are hidden in the editor.
  - Secrets keep their values in Rust.
    Only keys and sizes are sent, until the user explicitly reveals a value.
    A Reveal is a command of the bus (5.1): it sends one key's value, read from the open object as it runs, which the view keeps until Hide or until it closes, and nothing stores.
  - The `kubectl.kubernetes.io/last-applied-configuration` annotation on a Secret holds its values in clear text.
    The decoder strips it from Secret rows and objects everywhere: tables, editors, agents.
  - **Secret-grade data** is anything that can carry Secret values: Secret data, Helm values, and Secret objects inside a Helm release manifest.
    The UI shows it masked, and revealing it follows the Reveal row of the policy table (6.4).
    Twigo's MCP tools always return it masked.
    Reading Secrets through the policy proxy or `host-kube` is its own policy class, `secret-read` (6.4).
- **Events for an object.**
  A watch of `events.k8s.io/v1` with a field selector on the regarding object: its `regarding.uid`, a node's `regarding.kind=Node,regarding.name=…`, since the kubelet reports a node's name as its uid, and a mirror pod's the uid of the pod it mirrors, as kubectl describe reads them ([research](research/details.md#events)).
  It runs while the object's Overview is followed, which is on every view, or its events are asked for: the Overview holds its events section, and the Events view's own part of the batch goes only while that view is shown (4.3).
  No field of an event is indexed and the API server keeps no watch cache for events by default, so such a query is filtered, by inference from the source, from the namespace's events in etcd ([research](research/details.md#events)).
- **Metrics** (metrics-server).
  - `metrics.k8s.io` cannot be watched, and its lists carry no `resourceVersion`, uid or ETag, so a poller of its own, `twigo_cache::metrics`, reads it beside the hub, as plain JSON through the UI's client with gzip asked for: the Table has no namespace, containers or time.
  - What a context serves comes from the discovery its cluster last confirmed, in three states.
    Absent: no CPU and Memory columns, and no request to the group.
    Served: `pods`, `nodes`, each or both, at `v1` before `v1beta1`, as kubectl picks.
    Stale: the APIService exists and its version lists no resources, as while metrics-server is down.
    Served and stale give pod and node lists the columns whatever the poller has answered, so the columns never depend on a response.
    They come together with the list's own, in the batch that brings them: a list that has not listed yet has an empty list of columns and no state, so its header never shows CPU and Memory alone.
    The core follows each context's discovery with one follower, shared by every `resources_watch`, every list of pods or nodes and every open pod or node of the context, so the fact costs no second fetch.
    It runs while at least one of them holds it, and stops with the last: its CRD and APIService watches and its fetches end with it, as a background space's other subscriptions do (3.2), so a context nobody follows costs nothing.
    A context that leaves the sources while something holds its follower keeps the one follower and the one poller context when it returns, so the in-flight limit below holds across it.
    The registry keeps what the follower last confirmed of the Metrics API, per context and the context's fingerprint (6.2), after it stops: a follower started again begins from it, so a list opened again has its columns in the batch that brings its own, and corrects it with its first answer if the cluster changed meanwhile; a kept state is used only under the fingerprint it was kept for.
    The webview subscribes a list only once its space's resources came (3.4), so a list finds the fact at its first batch; a list opened before any discovery answered gets the columns in the batch after the answer.
    Every change of the fact reaches lists and objects, a stale API that is uninstalled and an absent one that is installed but never ready included: the columns come and go, and an open usage hears `absent`.
  - A scope, a namespace or the cluster, is listed every 15 s, the metrics-server manifest's and the chart's resolution, while a reader wants it, the first time at once; with the last reader gone it is not listed again, with no linger.
    Two readers of a scope share one request.
    A pod open alone asks for its namespace with a field selector on its name, and asks nothing when a list reads its namespace.
  - A list reads metrics only while its webview says so with its window (4.4), and it wants nothing once a batch has gone unacknowledged for 15 s, as a hidden window leaves it.
    It wants the namespaces of the rows in its window, one request each, and at most 4 of a context's requests are under way at once, since the UI's request budget is 28 streams (3.2) and one list over many namespaces would take them all.
    On kind 1.37 with 5,111 pods in 19 namespaces, the lists of the namespaces with the most pods, sent four at a time as the poller sends them, were measured against the cluster's list, gzipped as the poller asks, in three runs of `cargo run --release -p twigo-cache --example metrics_cost 41` on 2026-11-14, on a quiet Mac (a load average of 4 to 9).
    The 10 namespaces took 9.6–10.8 ms and 72,780–75,761 bytes, the 11 took 9.9–10.8 ms and 83,436–86,416, the 16 took 9.1–9.7 ms and 88,721–91,791, the 19 took 10.3–11.9 ms and 90,508–93,521, and the cluster's list took 17.5–18.0 ms and 74,480–77,056.
    The bytes of the namespaces' lists pass the cluster's at the 11th, since the ten largest hold nearly all the pods and each request adds its own.
    The time of one row differed between the runs by up to 1.2 times (the 19 namespaces: 10.3, 10.9 and 11.9 ms), and the namespaces' lists never took as long as the cluster's.
  - Sorted by CPU or Memory, a list reads every namespace of the list, not the window's: the one exception to "only the window", since rows without a sample would otherwise sort wherever the window left them and the order would move as it does.
    A list of all namespaces sorted so asks for the cluster in one request as well (decision 69) and its namespaces as the fallback: the cluster covers the namespaces' and the pods' readers only while it answers, so when it is forbidden or unavailable they are listed themselves and say their own state.
    A list of chosen namespaces never asks for the cluster, nor does a list of all namespaces that the hub resolved to the namespaces the person may list (3.2): a person who may not list the pods cluster-wide is taken to be refused their metrics there too, so the request would only repeat every 15 s to be refused.
  - A list's first batch has what the poller already holds.
    A list that joins a scope another reads, as a new query's subscription does while the old one is still open (4.4), has the scope's samples and state in its first batch, with no request.
    A list sorted by CPU or Memory whose first window says it reads metrics holds the first batch that shows its rows until each of its scopes has answered or failed once, so that its first order is the true one, and for 2 s at most, a bound of its own beside the poll's interval.
    One cluster's list is far inside it (above), but a list of chosen namespaces, or of all namespaces when the cluster's request is refused, needs every namespace's answer, four at a time, so a slow server reaches it as well as one that does not answer: on the fake with every request taking 250 ms, an assumed latency of a remote cluster and not a measured one, 40 namespaces answered by 2.75 s, and the batch left at 2 s with a value for 28 of its 40 rows (`a_list_of_many_namespaces_whose_answers_are_slow_reaches_the_bound_and_the_order_settles`, paused time, 2026-11-13).
    When the bound passes the batch goes out as it is, the rows that have an answer with their values and the others with none, and the order settles as the answers come.
    A list not sorted by a metric never waits for the poller, nor does one sorted by a metric while its window says it does not read metrics.
  - An answer is parsed into nanocores and bytes per container, and samples are compared by value, ignoring the order of containers and the request's time, so a reader hears only the keys whose values changed, appeared or went.
    A pod's value is the sum over its containers, as kubectl sums them, joined to its row by namespace and name in Rust, and dropped with the row and with its uid.
    A row that enters the filters, as a pod does that turns CrashLoopBackOff under a text filter, takes the sample the poller already holds, since the poller tells only what changes, unless the sample was taken before the row was created: the API carries no uid, so that one is of another pod by the name.
    An open pod or node drops its sample with its uid as well.
    The poller holds 5,095 pods in 0.87 MiB (`cargo run --release -p twigo-cache --example metrics_memory`, kind 1.37, 2026-11-13).
  - Absence is no data and never zero: pending and finished pods, pods too young for two scrapes and unscraped nodes are missing from the answer, a missing key has no sample, and a real zero is `0`.
  - A scope that fails is a state of its readers, `unavailable` for a 503 whose body is plain text and no Status, a 404 or a failed connection, and `forbidden` for a 403, never an error on screen; it holds no value until it answers again, and is asked again one interval after the failure, as after an answer, with no fast retries, since metrics are not worth more requests to a server that refuses than to one that answers.
    A `401` or a failed credential ends its run until the context's clients are rebuilt or a reader asks for the scope anew, as the hub's upstreams restart for a new subscription (3.2), since a retry by itself would run the credential plugin again.
  - A reader is told a state from the scopes that have answered or failed once, and, for one still waiting for its first answer, from the failure its last request ended in, which the poller remembers.
    It keeps, per context, resource and scope (a namespace of pods, the nodes), that last failure, `forbidden` or `unavailable`, after the scope's readers leave, since Kubernetes refuses metrics per namespace and nodes apart from pods; a scope that answered, or was never asked, has none.
    A pod open alone asks for its own name, and its failure is kept for its namespace, since RBAC tells names apart only through `resourceNames`, which it matches against the name that the API server gives a `list` selecting `metadata.name` ([`NewRequestInfo`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/staging/src/k8s.io/apiserver/pkg/endpoints/request/requestinfo.go#L245-L251), [`RuleAllows`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/plugin/pkg/auth/authorizer/rbac/rbac.go#L201)): a person limited that way sees a namespace's refusal for one request on a pod they may read, where everyone else sees it on the right pod at once.
    It is forgotten when a request of the scope answers, the cluster's answer covering the namespaces' scopes, when the context's clients are rebuilt, and when what the context serves of the Metrics API changes, as metrics-server removed and installed again does.
    It holds one entry for each scope that failed and has not answered since: a table of 5,000 refused namespaces with names of 10 characters took 516,952 bytes of allocations and one of 100 took 8,304, in a throwaway unit test with a counting allocator, a debug build, 2026-11-14.
    It also holds a slot for each context of the session, kept after its last reader leaves: the `Arc<Mutex<Refusals>>` (112 bytes, 80 of them `Refusals`), the 56 bytes of the `Context` that the slot's `Weak` keeps allocated, the context's name and its place in the poller's table, and the 64 bytes that a mutex allocates at its first lock on macOS, 313 bytes in 4 blocks for each of 300 contexts named with 10 characters and 293 bytes for each of 100.
    The slot keeps the follower's `watch` channel alive once the follower is gone, 933 bytes in 9 blocks, which a channel measured alone put at 440 bytes for its block and 512 for the eight 64-byte mutexes of its notifiers that its sender's drop allocated on macOS, so a context none failed in held 1.25 KB in 13 blocks and one refused once 1.5 KB in 15, the failure's entry adding 243 bytes in 2 blocks.
    The failure keeps the channel of the clients it came over alive too: 928 bytes in 9 blocks for a channel of its type alone with its sender dropped, not measured inside the slot.
    The figures are the growth of the heap, from `dhat` in a throwaway unit test, over a run without the contexts, with 100 and 300 of them, followers alive and then dropped, twice each, a debug build, macOS 27.2, Rust 1.99.1, 2026-11-14; Linux was not measured.
    A list that has said a state keeps it while its scopes are asked anew, as when its tab returns, so in a context that refuses metrics the header's mark does not go and come back.
    The first batch of a list that shows rows says what the poller remembers of the scopes of its window, so the mark is there with the first rows and the first answers correct it, and nothing where it remembers nothing, but for a stale API, which says `unavailable` with the columns, since discovery knows it without a request.
    An open pod or node of a context that serves the resource is sent a usage with the batch that carries its Overview once the context's discovery is known, or in the next one when the part is asked for later, so that what it draws, a node's Usage section and a pod's vitals cells and its containers' lines, is known before any request answers.
    An object opened before that, as when an editor is restored at a start and its `GET` beats the follower's first fetch, gets its usage in a later batch, which the usual order of events, resources first, makes rare; a list opened before any discovery answered gets its columns in the batch after the answer in the same way.
    Where its scope has answered already, as when a list reads its namespace, that usage has the figures.
    Where it has not but the scope's last request failed, the usage says that state, `waiting` false, and the request is made all the same: the answer replaces it with the figures if the refusal has ended.
    Where it has not and nothing is remembered, the usage says `waiting`: `ready`, every figure null, and for a pod `containers` naming those that run by its own status, in the order a sample lists them and with their requests and limits.
    A container runs when its `state.running` is set in `initContainerStatuses`, `containerStatuses` or `ephemeralContainerStatuses`, the restartable init containers among them, and the kubelet sets it exactly for a container the runtime says is running ([`toKubeContainerState`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/kuberuntime/helpers.go#L72-L77), [`convertToAPIContainerStatuses`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/kubelet_pods.go#L2381-L2382)).
    The kubelet's resource metrics, which metrics-server scrapes, list only those on containerd, whose kubelet takes the CRI stats provider: `ListPodCPUAndMemoryStats` takes the stats of a container only if it is in the map that `getPodAndContainerMaps` builds ([L388-L391](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/stats/cri_stats_provider.go#L388-L391), [L431-L456](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/stats/cri_stats_provider.go#L431-L456); on the sandbox path [`addCRIPodContainerCPUAndMemoryStats`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/stats/cri_stats_provider_linux.go#L62-L78)), and `removeTerminatedContainers` keeps only the containers in `CONTAINER_RUNNING` ([L1078-L1103](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/stats/cri_stats_provider.go#L1078-L1103)); `/metrics/resource` reads them through `GetCPUAndMemoryStats` ([`resource_metrics.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/metrics/collectors/resource_metrics.go#L168), [`summary.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/server/stats/summary.go#L135-L148)).
    On CRI-O the kubelet takes cadvisor's provider by default, since `UsingLegacyCadvisorStats` is true for a runtime endpoint ending in `run/crio/crio.sock` unless `PodAndContainerStatsFromCRI` is on ([`util.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/cadvisor/util.go#L76-L84)), a gate that is Beta and off by default at v1.37.1 ([`kube_features.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/features/kube_features.go#L1940-L1943)), and the kubelet then uses cadvisor's ([`kubelet.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/kubelet.go#L873-L874)).
    That provider filters on use, not on the runtime's state: `ListPodCPUAndMemoryStats` keeps a container's cgroup unless cadvisor reads it as terminated, with zero instantaneous CPU, zero RSS and no network traffic, and, among the cgroups of one container name, only the newest with both CPU and RSS non-zero ([`filterTerminatedContainerInfoAndAssembleByPodCgroupKey`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/stats/cadvisor_stats_provider.go#L437-L482), [`isContainerTerminated`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/pkg/kubelet/stats/cadvisor_stats_provider.go#L538-L560)).
    So the usage's rule, the containers that run by the pod's own status, follows the runtime's state on containerd and, on CRI-O, only as far as use shows it, which was not run there.
    metrics-server v0.9.1 lists each container of the last scrape that has an earlier point, but leaves a pod out when one of its containers has none ([`GetMetrics`](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/storage/pod.go#L48-L100), [L66-L71](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/storage/pod.go#L66-L71)), and a pod with a container of zero CPU or memory ([`checkContainerMetrics`](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/scraper/client/resource/decode.go#L190-L204)): that pod has no sample, and its vitals cells and its containers' lines say no data yet.
    A container that started less than 10 s before the scrape ([`freshContainerMinMetricsResolution`](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/storage/pod.go#L31)) has an earlier point only if the scrape before listed it, but one that started between 10 s and one resolution before it, 15 s in the manifest, is given one at its start time ([`Store`](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/storage/pod.go#L121-L125)), so its pod is listed.
    A container whose start time or cumulative CPU went back is skipped while its pod is listed ([L72-L76](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/storage/pod.go#L72-L76)), so a pod's containers may be fewer than the running ones.
    On kind 1.37 with metrics-server v0.9.1, a pod with a finished init container, a running restartable one, a running container and a crash-looping one was listed with the two running ones, in four reads of `/apis/metrics.k8s.io/v1beta1/namespaces/default/pods/<name>` over 30 s (2026-11-14).
    A stale API says `unavailable`, not waiting, at once, since discovery knows it without a request, and the failure of its request then says the same.
    The answer replaces the usage: the figures, `used` null for an object an answer lacks, or the failure's state, each with `waiting` false, so the drawer never reads "no data yet" before an answer that has not come, and a refusal is said as soon as it is known.
    An object that has had an answer keeps its figures while the request that serves it is replaced, as when a list starts or stops reading its namespace, a cluster-wide request that served it fails, or the part is hidden and shown, until the new request answers, and a failure it answers takes them away: `waiting` is said while an object has had no answer: a pod replaced under its name has had none, and nor has one whose context stopped serving the resource and serves it again, since `absent` withdrew its figures and those from before are not shown.
    The hold of a list sorted by a metric is unchanged: it waits for the answers, not for a state.
  - An open pod or node reads the same sample: its usage is a part of its batch with its own dirty flag, so a changed sample does not describe the Overview again (4.3).
    Once the context stops serving the resource while the part is shown, the batch says `absent` in a usage with no figures, once, so the webview draws none; a list is never told, since its columns go with the API.
- **Discovery and OpenAPI.**
  - Aggregated discovery, GA since 1.30: one request each to `/api` and `/apis`, with client-go's `Accept`, the aggregated form first and plain JSON after it ([`acceptDiscoveryFormats`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/client-go/discovery/discovery_client.go#L68)).
    kube's `run_aggregated()` is not used: it sends no `If-None-Match`, and it reads a legacy `APIGroupList` as an empty list, since its `items` default ([`v2.rs`](https://github.com/kube-rs/kube/blob/5.0.0/kube-core/src/discovery/v2.rs#L20-L28)).
  - There is no fallback to legacy discovery, since every supported release serves the aggregated form.
    An answer of another type, as from a proxy that drops the `Accept` header, fails and says that the server did not answer aggregated discovery.
  - Discovery answers with the resources that have the `list` verb, each at its group's most preferred version that serves it, as client-go's [`ServerPreferredResourcesWithContext`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/client-go/discovery/discovery_client.go#L976-L1044) picks them.
    Those that cannot be watched, as ComponentStatus, are listed again (3.2).
    A version that an aggregated server left stale comes after the others, where client-go drops it ([`convertAPIGroup`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/client-go/discovery/aggregated_discovery.go#L80-L82)), so its kinds stay and their lists say why they fail.
  - A disk cache in the app's cache directory holds each cluster's discovery with its ETags (`If-None-Match` → 304), so a start revalidates it rather than downloads it.
    A cluster is named by its URL, its `tls-server-name` and the CAs its clients trust it with, so one recreated at the same address with a CA of its own gets a file of its own.
    One recreated with the same CA shares the name, and only the server's ETags tell the two apart.
  - `resources_watch` follows the active space's discovery in `twigo-cache`, through the CRD and APIService metadata upstreams.
    It answers at once and sends the resources over its channel, since discovery may wait on the network or a sign-in, and the webview asks for the next space's watch only once the last one answered.
    The follower is the context's own, shared by every watch, list and object that reads it, and lives while any of them holds it: a watch starts from what it knows, `Ready` with no `Pending` before it once resources are known, and sends each change.
    Once nothing holds it, following the space again starts a new follower, which fetches discovery and holds the CRD and APIService upstreams anew.
    The API server updates its discovery from such a change in a controller of its own, which may not be done when the change reaches Twigo: apiextensions' discovery controller waits for the CRD's `Established` condition through an informer of its own ([`sync`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiextensions-apiserver/pkg/apiserver/customresource_discovery_controller.go#L105)).
    So discovery is fetched once the changes have been quiet for 0.5 s, or 2 s after the first of them if they keep coming, and again 2 s and 10 s after the last of them.
    A new follower whose upstreams another one left listed fetches at those times too, since the changes they told may still lag.
    On kind 1.37 a CRD came with the first of these, 0.52 to 0.54 s after its creation, in four runs of `a_crd_created_while_followed_comes_without_a_restart` (2026-11-02).
  - Users who may not list CRDs or may not list APIServices poll discovery with its ETags every minute, the interval at which kube-aggregator refreshes an aggregated server's discovery ([`discoveryRefreshInterval`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kube-aggregator/pkg/apiserver/handler_discovery.go#L58)).
    An aggregated server whose resources change while its APIService does not is seen with the next change, or once the space is followed again after nobody followed it.
  - A follower first sends the name of the cluster its context reaches, as soon as its clients are built from the kubeconfig and before it asks for discovery, and again whenever an edit moves the context to another cluster.
    An edit drops a discovery request under way, which may wait on the old cluster's timeout or sign-in.
    A space keeps its last resources in the explorer while that name is the same, so a switch shows it at once, and shows a placeholder until the new cluster answers when the name changed.
  - A failed fetch keeps the resources the server last answered to the follower, and is tried again after 5 s, the hub's longest backoff.
    A copy from the disk cache counts only once the server has confirmed it, since only the server's ETags tell apart clusters at the same address with the same trust, as behind a load balancer; clients that cannot be built fail it rather than show another cluster's resources.
  - A fetch whose credential failed stops the follower, since retrying would run the plugin by itself, as for the upstreams (3.2), until the context's fingerprint changes.
    Then it holds its CRD and APIService upstreams anew, which restarts those the failure ended, and fetches again; the fetches due after a change stay, since the server's discovery may still lag it, and a change that the new upstreams list but the old ones had not told yet gets its own.
    The fingerprint is taken once the catalog's sources have been read, so their first read at a start is no change, and it leaves out the oidc tokens that Twigo and kubelogin write back (6.2) and other contexts' entries, so neither sets off a fetch.
    The frontend follows the active space again whenever a credential comes after none or after a failed run, and a watch of a stopped follower asks it to fetch again, as a new follower did.
    A run that a rejected credential sets off by itself does not count: against a server that keeps refusing fresh credentials, every view asking again would run the plugin again, forever.
    A fix on the server's side, as a role binding for the identity, and new oidc tokens are seen once the space is followed again after nobody followed it, as after switching to another space and back.
    A follower that a list or an object still holds keeps the CRD and APIService upstreams that a `401` ended until the context's fingerprint changes: a watch that follows it again asks only a stopped follower to fetch again.
  - OpenAPI v3 documents are fetched on the first edit of a group/version, through the context's `api` client, so the gate sees them.
    `GET /openapi/v3` lists each group/version with a `serverRelativeURL` whose `?hash=` is the upper-case hex SHA-512 of the JSON the server serves for it ([`computeETag`](https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/handler3/handler.go#L121-L126)), the aggregated servers' documents included.
    A document is cached on disk for good under that URL, and used only while its bytes still hash to it, so a cached copy cannot be stale or another cluster's, and a server that answers something else under a hash writes nothing.
    The module docs of `twigo_kube::openapi` give the source of each step.
    The index is asked for on every load and never cached, since a CRD's change gives its group a new hash.
  - Rust keeps a document's `components.schemas` only for the call that needs them.
    `schema_get` answers the JSON Schema (draft-07) of a kind, with the definitions it reaches under `definitions`, and the apply engine reads from the same schemas how the server merges each field (6.5).
    A first load of `api/v1` (1,604,476 bytes) took a fresh process from 11,456–11,504 KiB resident to 19,024–19,312 KiB, and one of `apis/apps/v1` (719,385 bytes) from 11,472–11,536 KiB to 16,112–16,224 KiB.
    The allocator kept it after the document was dropped, and ten more loads of `api/v1` added 1,792 to 1,968 KiB (`cargo run --release -p twigo-kube --example openapi_memory -- v1 Pod`, three runs each, release build, macOS, kind 1.37, 2026-11-08).
- **Never pre-fetched.**
  Counts for every kind, full lists of CRDs (they can be tens of MB), large ConfigMap values (rendered lazily), metrics for invisible rows.

### 3.7 View states

Each upstream reports one of:

- `queued` (waiting for a stream slot, 3.2)
- `connecting`
- `syncing` (with a progress count)
- `ready`
- `relisting`
- `stale` (no event or bookmark in time, or the stream broke; reconnecting)
- `forbidden` (verb and resource from the 403)
- `unauthorized` (a sign-in action is offered)
- `error` (an `IpcError`, with its code and its kind, plus a retry)

`connecting` and `stale` carry `cause`, the last failure that may pass, as an `IpcError`, so a list that waits can say why without turning into an `error` and back at each retry.

A refusal outranks `queued`: a `forbidden` part whose retry waits for a watch says `forbidden`.

Every view header and the status bar render these states.
A blank table is never an error state.

Every failure that reaches the window is an `IpcError` with a code, but for the few that stay in words (below): a view's `error`, a cause, a refused command, a session's end, a forward's `failure`, `reconnecting` and `failed`, a plugin's failure, the login shell's environment, a dry run the server refused, a kubeconfig file's failure, a context's `problem`, the problems of Twigo's own files (4.10) and an object's unavailable events.
What stays in words is the answers of an edit's preview (`stale` and `immutable`, the server's `409` and `422` refusals of the dry run), a stopped command's text, which tells the failures of its requests after Twigo's own sentence, the reason an unreadable policy file gives as the source of a mode, which sits beside the `policy.file-unreadable` that refuses a command (4.10), the runtime's words of a container with no shell, and the kubelet's `reason` for a container that ended or waits.
The code names the condition (`connect.refused`, `server.forbidden`), its kind is the class that retries and sign-ins branch on, and the API server's own `reason` and `causes` travel beside it as `server`, never as a code ([decision](decisions/error-codes.md)).

A list reads its upstreams as parts, one per namespace or one for the cluster (`Parts`, `ListBatch.parts`):

- A part's rows are in the list once it has listed and while it is not refused (not `forbidden`, `unauthorized` or `error`), whatever the other parts are.
  So a part that is `syncing`, `queued` before its first list, `connecting` or refused adds none, and one that has listed and waits for a watch, or is `stale` or `relisting`, keeps its rows.
- `status` is the state of the rows shown: the least ready of the parts shown, one that waits for a watch after its whole list counting as `stale`.
  While no part shows, it is the least ready of the parts still on their way, one whose first list broke off counting as `connecting`, and once none is, the worst refusal.
  So `ready`, `relisting` and `stale` say that some part's rows are shown, and a refusal that no part is on its way.
- `parts` has `count`, the parts the list reads, `unready`, each part that is not `ready` with its own state and whether its rows are shown (`shown`), and `omitted`, for all namespaces settled on parts per namespace, the namespaces of the cluster that those parts leave out because the person may not list the kind there (3.2), and 0 for any other list, the cluster part included.
  It goes in the first batch and whenever it changes, and a change of `parts` alone is a batch.
- While the hub settles what all namespaces read (3.2) the list has no part: it says what the hub waits on, `connecting` or the clients' error, with `count` 1 and nothing unready, and the parts come when it has.
- A cluster-wide upstream that serves a narrower selection without being held is the part `Cluster`.
- A part that starts or stops showing sends every row of the parts shown again (3.4).

What needs the rows of every part, as an object's page and a workload's pods do, reads the least ready state of all of them.

### 3.8 Performance budgets and the benchmark

These are targets, measured on a kwok cluster, which simulates nodes and pods without kubelets, at 5k, 20k and 50k pods with churn:

| Metric                                                   | Target (5k pods)     | Target (50k pods)     |
| -------------------------------------------------------- | -------------------- | --------------------- |
| Pod list first paint after the space connects (LAN)      | < 1 s                | < 4 s                 |
| Change → painted cell, p95                               | < 150 ms             | < 300 ms              |
| Scroll and sort                                          | 60 fps, sort < 50 ms | 60 fps, sort < 200 ms |
| Core RSS with the pod list open                          | < 150 MB             | < 500 MB              |
| Webview memory with the pod list open                    | < 300 MB             | < 400 MB              |
| Idle CPU (100 changes/s background churn, window hidden) | < 2 %                | < 2 %                 |

The memory numbers count WebKit's `com.apple.WebKit.*` processes, all but the GPU process.
Any page that repaints, a blank one with one changing number included, holds about 260 MB there, WebKit's pool of IOSurfaces, so counting it would measure WebKit rather than Twigo; the report shows it on a row of its own ([bench](bench.md#where-the-webviews-memory-goes)).
They are children of launchd, not of the app, so measuring per process under-reports a Tauri app by about half.

`bench/harness.sh` measures them at 5k pods on macOS ([bench](bench.md)).
It builds the app's bench mode in release, runs a churn generator at 100 changes/s against kwok, launches the app on the cluster's kubeconfig, whose webview driver opens the space of its one context, then opens, scrolls, sorts and watches the pod list, and prints one row per metric with its value, target, status and what it measured:

- **First paint** runs from opening the list to its first rows painted; the space's discovery starts as the space opens, before the list, so only what remains of it counts.
- **Change → painted cell** joins the churn generator's log of changes, by pod and restart count, with the webview's paints of the new count, through Unix ms on both sides, from the patch sent.
- **Scroll** is the mean fps of `requestAnimationFrame` over 5 s of scrolling at 4,000 px/s, and **sort** the p95 from a header click to the resorted rows painted, over eight sorts.
- **Core RSS** is the app process's resident size with the list open under churn.
- **Webview memory** is the resident size of the WebKit processes the app is responsible for, the process macOS records as having asked for them, but the GPU process; the harness starts the app responsible for itself, since one started from a terminal shares the terminal's.
  Their physical footprint and the GPU process are shown apart and never judged: footprint leaves out pages WebKit reused and counts graphics that resident size does not, so it swings between runs ([bench](bench.md#on-the-rust-path)).
- **Idle CPU** is the CPU time of the app and those WebKit processes over 30 s with the window hidden, as a share of one core.
- **Visible CPU** is the same over 20 s with the window on screen, while the driver sleeps; it is shown and never judged, since it swings too much to tell a regression from noise ([bench](bench.md#the-visible-window)).

The report judges every metric but those three, and fails the run on a missed target.
CI does not run the harness yet: it needs an unlocked GUI session, since WebKit paints nothing behind a locked screen, and Linux needs the sampler's WebKitGTK branch.

The bench also replays the cases that broke other clients, and one that loopback cannot show:

- all namespaces on 30k pods;
- a ConfigMap with 2,000 keys;
- 25 contexts whose exec plugins time out;
- an API-server restart during a watch;
- packet loss on the one HTTP/2 connection, for head-of-line blocking ([HTTP/2 spike](spikes/http2.md)).

## 4. Workbench and UI model

### 4.1 Parts (VS Code layout)

```
┌ ●●● ● prod-eu 🔒 ▾ › payments ▾      ───────────────────────────── title bar ⌕ ┐
│ PE │╭ Explorer ───╮╭ ⎈ Pods │ deploy/api ──────────────────────────────────────╮│
│ ST ││ ▾ Workloads ││ 5,000 pods · synced          ┌ Pod api-7f9 ──────────── ✕ ┐││
│ DQ ││   Pods  2.1k││ Name         Ready  Status   │ details over the list,     │││
│ +  ││   Deploym.  ││ api-7f9      1/1    Running  │ Lens's drawer; arrows move │││
│    ││ ▸ Network   ││ …                            │ it along, Esc closes       │││
│    ││ ▸ CRDs      │╰──────────────────────────────┴────────────────────────────╯││
│    ││             │╭ Terminal · Events · Output · Agent activity ─────────────╮ ││
│    │╰─────────────╯╰───────────────────────────────────────────────────────────╯ ││
├────┴─────────────────────────────────────────────────────────────────────────────┤
│ prod-eu · ns: payments · READ-ONLY · ⇄ 3 forwards · syncing 2/9     status bar   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

| Part               | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title bar          | Breadcrumb of the space and its namespace scope; in the middle a search field with its key that opens quick access, as VS Code's Command Center; drag region; native traffic lights on macOS; where it is too narrow its parts give way (below). The side bars show and hide by keys (⌘B, ⌥⌘B), the View menu and the palette, not buttons; so does the panel, by ⌘J, and by buttons too: its strip's Hide, and the status bar's count of sessions, which shows it, besides the other ways it hides (the Panel row)                                                                                                                                                                                                                                                                                                                               |
| Space rail         | Tiles of the open spaces (D6, Lens's hotbar), each with a dot of its connection and a lock while its mode holds writes back (4.2), ⌘1..9 by position, a button that opens any context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Primary side bar   | View containers as the plates of a `TabBar` in its header (Explorer, Port forwards, Helm, Extensions and contributed ones), or the title of the only one; the active one's views: resource tree, saved filters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Editor area        | Dockview grid of editor groups: tabs, preview tabs, splits, drag between groups; with no editor open, the space's home                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Panel              | A dockview of its own for sessions opened by URI, its layout kept per space beside the editor area's: logs, shell and terminal tabs now (4.6); the cluster's Events, Output (Twigo logs per channel) and Agent activity (audit, 6.6) later. Its tabs split and move; it maximizes over the editor area, and hides with ⌘J, its strip's Hide, Toggle Terminal, a drag of its sash past half its minimum, or a person's close of its last tab (below)                                                                                                                                                                                                                                                                                                                                                                                               |
| Secondary side bar | The ACP agent panel later; hidden while nothing lives there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Status bar         | In the shell's colour, entries as data: on the left the active space as a full-height block of its context's colour in the bar's corner, with a lock while its mode holds writes back (6.4), a warning while the login shell's environment is missing (6.1), credentials that need the person, the cluster's version, or its connection in words when it is not connected (sync later), and, while some parts of the active list are not ready (3.7), the worst of them with how many, `Forbidden · 2 of 3 namespaces`, each named in its tooltip, one entry counting the listening port-forwards, `⇄ 3 forwards`, while any runs, in warning while one fails or reconnects, and one counting the space's sessions, `2 sessions`, while the panel is hidden (below); on the right the active list's rows and how many fail or wait, each a filter |

The parts sit flush, split by hairlines, with no cards or gaps: the owner tried islands, as JetBrains Islands and VS Code's 2026 layout ([research](research/workbench-chrome.md)), and preferred flat parts.
Views are descriptors (ID, title, container, `when`, provider), so the user can move a view to another container, VS Code style.
An editor area with no editor open shows the first watermark a feature registered whose `when` holds, else the workbench's key hints.
`kube` registers the space's home for spaces of one context: the space's tile, name, Kubernetes version and node count; a tile each for nodes, pods, Deployments and warning events, which opens its list with the filter that shows what is wrong (`h=` or `q=`); what needs attention, the abnormal pod statuses by count in words and then nodes not ready and Deployments short of ready, each with a Show; and the keys that open things.
Rust counts each tile's list in a query view with `countBy` and an empty window, so no row crosses the IPC (3.4), and only while the home shows (3.2).
A list the credentials may not read shows "–" and why, never 0.
The layout per space is persisted (dockview `toJSON` and which parts show); part sizes are the app's (4.8).

The title bar gives way in a fixed order where it is too narrow, by the widths of hidden copies of its parts at their natural size ([decision](decisions/parts-give-way-by-width.md)).
First the search field folds to an icon that keeps its key, ⌘P, and still opens quick access; then the search leaves the middle for the bar's right end; then the mode chip folds to its icon, a 20 px square, its words in its tooltip; only then are the crumbs cut.
Each crumb is cut in the middle, a fixed head and tail around a middle that shrinks to no less than 2em, so that a whole glyph and the ellipsis always show, the scope first and the name only once the scope is at its floor.
The name keeps 28 characters, head and tail together, its tail the part after its last `:` or `/` while that leaves the head 4 characters, 1 to 24, else its last 12, so that an EKS ARN keeps its cluster's name; the scope keeps 16, its tail the part after its name's last `-` by the same rule, so `All namespaces` is never cut, and no text as short as its floor is.
The scope crumb reads as the scope chip does (4.4): `All namespaces`, or the first namespace cut in the middle and `+N` for the others, with every name in its tooltip, so a scope of any length takes no more of the bar than one long name, and the hidden copy that decides the stages measures that form.
The crumbs' accessible names say what they hold, `Switch space, prod-eu` and `Select namespace, payments and 2 more`.
A stage counts half a pixel for each rounded width it adds up, so that a part stays whole only where it fits whichever way the widths were rounded.
The bar stays 36 px high, which the position of the macOS traffic lights in `tauri.conf.json` is tied to.
The mode chip after the context's name says its type and its lock, `Production · read-only`, and opens what set it and the choices the person has (6.4).
A context nobody marked has a quiet chip, `Not marked`, that opens the same choices, and its tile in the rail says so in its tooltip.

The panel hides when a person's close takes its last tab (`Editors.dismiss`, 4.3): its X, a middle click, ⌘W, Delete or Backspace on the focused tab, and the Close Terminal… and Close Shell… picks.
It leaves maximize and hides in one step, and gives the focus back (4.3).
The app's own close of a tab, a session that ends by itself and keeps its tab, a move between groups, a switch of spaces and a restart that reuses a tab hide nothing.
Its dockview keeps its last group as it empties (`noPanelsOverlay: 'emptyGroup'`, [`doClose`](https://github.com/mathuo/dockview/blob/v8.8.3/packages/dockview-core/src/dockview/dockviewGroupPanelModel.ts#L1644-L1655) at dockview 8.8.3) and makes one for a space that has none, so its strip keeps Hide in every state, the empty one included; Maximize Panel Size shows and runs only while it holds an editor (`panelHasEditor`).
Opened with nothing in it, as by ⌘J, it names the space, `No sessions in prod-eu`, and offers the `panel/empty` menu as the outline buttons an empty state draws for its action, each with its key where it has one: New Terminal, and Reopen Logs while the space has a closed logs tab to bring back (4.3).
Its sash snaps it shut: allotment's `snap` hides the pane once a drag takes it half its 80 px minimum past that minimum ([split-view.ts at v1.20.6](https://github.com/johnwalley/allotment/blob/v1.20.6/src/split-view/split-view.ts#L868-L879)), a drag that brings it back shows it unmaximized, and a double click on the sash restores the default height of 340 px while the panel shows, as allotment resets no pane that its snap hid ([the reset](https://github.com/johnwalley/allotment/blob/v1.20.6/src/split-view/split-view.ts#L504-L525)).
A height is remembered only from a drag that ends with the panel not maximized.
While the panel is hidden, the status bar counts the space's sessions, `2 sessions`, and a click shows the panel: shells and terminals that have not ended, and logs tabs whose target is not down (an error, forbidden or unauthorized) and that, once their pods are known, have a stream queued, connecting, following or waiting, or no pods at all, as a workload at zero replicas, whose pods they wait for.
The entry that lists open shells (4.6) gives way to it meanwhile.

The interface zoom is the app's too.
Zoom In (⌘=, ⇧⌘= and the numpad's +), Zoom Out (⌘- and the numpad's −) and Reset Zoom (⌘0 and the numpad's 0), with Ctrl on Linux and Windows, step it from 0.5 to 2 in tenths; the palette and the macOS View menu hold them too.
The workbench keeps the factor under `window/zoom` (4.8), read once at start, and `apps/desktop` applies a stored factor other than 1 before the first render (the webview starts at 1, so 1 sends nothing and the first render does not wait for a command that changes nothing), then each change in turn: in the app as the webview's zoom, which wry sets on macOS as WKWebView's `pageZoom` ([mod.rs at wry-v0.57.1](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/wkwebview/mod.rs#L1024-L1031)), and in the mock as CSS `zoom` on `<html>`.
In WKWebView that zoom scales `devicePixelRatio`, the screen's scale times the page zoom ([`devicePixelRatio`](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/WebCore/page/LocalDOMWindow.cpp#L1780-L1794)), while resolution media queries keep the screen's scale (a plain WKWebView on macOS 27.2, 2026-11-14).
On a layout where `=` needs ⇧, as the German one, ⌘+ zooms nothing, while the numpad's + works on every layout ([`TODO.md`](../TODO.md)).

### 4.2 Spaces (D6)

- A space has an ID, a list of contexts (one or more), a namespace scope and a persisted layout: open inputs, view placement, and what each view keeps, such as the explorer's open sections (4.8).
  M1 serves one-context spaces, whose ID is the context's name; `Space.contexts` stays a list for 7.2.
- The rail shows the spaces whose contexts the catalog lists.
  A space whose context goes away keeps its state and comes back with it.
  When the catalog lists contexts but no space has them, as on the first start, the first context's space opens.
- Switching spaces moves the whole workbench: explorer, editors, status bar, policy badge.
  The rail shows a tile per open space: two letters on the tint of its context's colour, the active one ringed and marked, a dot of its connection (connected, connecting, failed, or idle while another space is active).
  A tile whose context is read-only carries a lock on its other bottom corner, as far past the tile as the dot's cut-out, and an open lock while an unlock lifts that (6.4), the mode in words in its tooltip; a guarded context, which asks before a write and holds none back, has none.
  The title bar's breadcrumb names the active space and its namespace scope and opens their pickers; where the bar is too narrow, it is the last of the bar's parts to give way, cut in the middle (4.1).
  Every context has a colour, the only extra colour, from six tokens: red, orange, yellow, green, blue and purple.
  It comes from the context's kubeconfig metadata (5.5), else from the user's pick in Twigo (Set Space Colour… in the palette and the tile's menu, kept in the app's state), else from its environment type (6.4), Production red, Staging orange, Development green and Local blue, else from its name, the same each time, among blue, purple, green and orange: red and yellow stay for the user and the environment types (6.4), so neither says danger by chance.
  Decided with the owner on 2026-11-03, after contexts without metadata left the workbench grey.
  It tints the tile and the title bar's left end behind the breadcrumb, as JetBrains does with a project's colour, and fills the status bar's space entry.
  A space with several contexts shows none.
- What can outlive its space, or be left with the person while another space shows, leads with that space's 20 px tile, so it says whose it is whichever space shows: a toast about a space or a context, a command's or a forward's failure that the gate refused among them; the confirm and approval dialogs, before the badge with the context's type or mode; the unlock banner; a terminal's offer (4.6); and a row of quick access that opens something in another space (4.5).
  What belongs to no space, as the app's own failures, has no tile.
- Every editor in a space belongs to that space's contexts.
  Opening another cluster's object means switching spaces or running **Compare with…**, which opens a diff editor against an object picked from any context and says so in its title.
- A multi-context space ("dev+qa", 7.2) gets merged tables with a Context column.
  Its editors still each carry one context, shown as a chip on the tab.
- A space connects lazily on its first activation.
  A background space's sessions (port-forwards, exec, logs) survive; its list subscriptions linger, then stop (3.2).
- Shortcuts: ⌘1..9 selects a space by its place in the rail; the rail's button and `ctx ` in quick access switch to a space or open one for any context; ⌘⇧N opens a space in a new window.
- The `ctx ` picker lists the open spaces first, each with its tile, its context's server as host and port, its connection as the rail has it (the cluster's version alone while connected) and its ⌘ key; then the other contexts under the kubeconfig file that defines them (5.5).

### 4.3 Editor model

Inputs are typed URIs.
A resolver maps a URI pattern to an editor pane by priority, as VS Code's editor resolver does:

| URI                                                                 | Editor                                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k8s://<space>/<group>/<version>/<resource>[/<ns>]/<name>`          | Resource editor with views: Overview, YAML, Events, Related; Logs in its header opens the object's logs tab in the panel, and Shell for pods its shell tab             |
| `k8s-list://<space>/<gvr>?ns=…&q=…`                                 | Resource table as an editor, so one can pin "pods in payments where status≠Running" next to another list                                                               |
| `logs://<space>/<group>/<version>/<resource>/<ns>/<name>`           | Logs tab in the panel (4.6): a pod's, or a workload's pods' merged; the core group an empty segment, as in `k8s://`                                                    |
| `exec://<space>/<ns>/<pod>/<container>[?n=2][?attach=1]`            | Shell tab in the panel (4.6): xterm over an exec of the container, `n` for a second shell on it, `attach` for its main process                                         |
| `terminal://<space>/<n>`                                            | Terminal tab in the panel (4.6): xterm over a pty on this machine, pinned to the space's context, numbered within its space                                            |
| `pf://<space>/<forward-id>`                                         | Port-forward tab: state, target and resolved pod, local address, open connections, bytes, errors; Open in browser and Copy address (a quick HTTP request tester later) |
| `diff://edit/apply?editor=<uri>`, `diff://<space>/objects?…`        | Monaco diff: the apply dry-run of an editor's edit, its opened object against the server's now (`edit/server`), Compare with…, any two objects                         |
| `untitled://<space>/manifest-n`                                     | New manifest of a space, numbered within it; its first Apply asks for the target context and, once applied, opens the object it made                                   |
| `twigo://settings`, `twigo://keybindings`, `twigo://extension/<id>` | Settings UI, keybindings UI, extension details                                                                                                                         |

- **Details.**
  A click or Enter on a row opens its details, and Space shows or hides them, as Linear's peek; arrows move them along and Esc closes them.
  They are the quick look and hold no tab: a double-click on the row, or ⌘Enter on the selected one, opens the object in a tab of its own (below).
  - In an editor at least 960 px wide they stand beside the list as an inspector, and the list gives up columns by its width (4.4), so the selected row stays in view (WCAG 2.4.11); in a narrower one they slide over the list from the right, as Lens's drawer.
  - Their width is the person's, kept with the part sizes (4.8): a drag of their left edge stores it as it was clamped when the drag ended, within 320 px while docked and 85 % of the editor, and lying over the list the cap wins over the 320 px.
    Docked, they shrink, down to those 320 px, so that the list keeps the room its strip needs (4.4).
  - Their header is three lines, which an object editor draws too, the third only where there is something to say (below), and each that is drawn keeps its height while the selection moves along rows of one kind:
    - who it is: the kind's icon and word, then the name at 16 px in strong, its hash and last segment as the list draws them (4.4), then Copy Name, an icon that opens the object in an editor, and Close, of which an object editor has Copy Name alone;
    - where it is: the namespace, the controlling owner at the top of its owners, the node of a pod and the age, in content for its first ten minutes, between quiet dots; the owner and the node are links that open them, the owner a Deployment through its ReplicaSet and a CronJob through its Job, and the controller itself while the one above it is not listed;
    - how it is: the status as a pill, then one sentence from Rust, the first finding's title, else the vitals in words (`2/2 ready · no restarts`).
  - The pill's word is the one the list's health column prints for the object, a pod's or node's Status and a Deployment's Ready, from the cells the server printed for it (`header.printed`) once the object has come and from the selected row before, so the page and the list never say two things.
    Its tone is the list's rule for that word, else the tone of the core's findings where the rule calls the word healthy, as for a Deployment past its progress deadline, whose Ready still reads `4/4`.
  - The third line is drawn where the object has a word of the list's health column, where its strip has cells, or where it has a sentence (`useHeader`).
    After the object comes those are its own: its printed cell for a pod's or a node's Status or a Deployment's Ready, its vitals, and its sentence, which the core gives a pod, a node and a Deployment, and any other kind only as its first finding's title (`header.rs`).
    So a Job, a Service, an Ingress, a claim or a ConfigMap, which have no health column and no vitals, has the line only while the object has a finding, and it comes and goes with the sentence as the selection moves along rows of one kind.
    Before the object comes the details have the selected row's word, and the strip's places and whether there is a sentence are those of the last object of its kind that these details showed, kept in the header's own state (`useHeldPerKind`) until the details close.
    So a kind with vitals and no health column, a StatefulSet or a DaemonSet, draws the line once an object of its kind has come, and a Job's line stands through the dwell and the wait for its object only, and stays only if that object has a sentence.
    An object editor keeps nothing before its first batch: it has no row and no last object, so it has no word, no strip and no third line until its object comes.
  - Each of the first two lines takes the fullest of its stages that fits, from hidden copies of the stages, and comes back to a fuller one only with 16 px to spare ([decision](decisions/parts-give-way-by-width.md)):
    - the first line: the kind's word and the whole name; the name's generated part cut as a list row cuts it; the kind's word gone, its icon saying the kind in its tooltip; the name cut in the middle, down to a floor of 12 characters;
    - the second line: every part whole; the node cut in the middle; the owner's name cut too; the owner's kind word gone; the node gone; the namespace cut; the age never cuts and never leaves;
    - what a stage cuts or leaves out is in the tooltip of what stays.
  - Then the commands of `resource/details` as one row ([decision](decisions/parts-give-way-by-width.md)):
    - each kind pins up to three verbs, with their labels and keys, in the same places whatever the object's state: a pod Logs, Shell and Forward; a Deployment or StatefulSet Logs, Restart and Scale; a DaemonSet Logs and Restart; a CronJob Trigger, then Suspend or Resume; a node Cordon or Uncordon, then Drain; any other kind Forward where it has one, else nothing;
    - More comes last, always, with the rest in their groups, and Delete last in it, in a group of its own, in the error tone;
    - Show YAML and Open in Editor are not on the row: the YAML view shows the same, and the icon beside the name opens the object in a tab of its own;
    - a pinned verb that cannot run keeps its place, disabled, with the reason in its tooltip, as `No container runs` for Shell while the Overview lists containers and none runs, or `You may not restart it` where RBAC refuses (5.1), and an item of More that cannot run says why under its label;
    - a write or an exec that the context's mode will refuse stays clickable, dimmed, with a lock and `prod-eu is read-only`, and the gate refuses it as it runs, a Delete keeping its error tone (5.1, 6.4);
    - as the row narrows the keys go first, then the labels from the last pinned verb back, and a fuller stage comes back only with 16 px to spare;
    - the row is one tab stop, and the arrows, Home and End move along it, as along the views' tabs.
  - Below, the object's views as a row of plates (4.9), Overview, YAML, Events with its warnings counted, and Related, the same row the editor shows; the view shown stays as the selection moves.
    Over the Overview the row also holds the page's filter (below).
  - Under the views, on the Overview, a strip of up to four equal cells of 44 px holds the object's vitals, each a caption over a value that takes a tone only where it is abnormal, in the same places while the selection moves along rows of one kind: before the object comes, the places of the last object of its kind that these details showed stand as dashes, and an object editor has none; once it has come the cells are the object's own.
    - A pod has Ready and Restarts from Rust, the restarts' note saying when the last was, then CPU and Memory from its usage: the figure, a 2 px meter, and beside the figure as much as the cell holds with 16 px to spare, the share and its base in words (`17m 34% of request`), else the base's amount (`17m of 50m`), else the figure alone, the tooltip saying what is left out.
      Without a sample, or while the Metrics API does not answer, may not be read or is absent, a cell is a dash with the reason in its tooltip.
    - A Deployment has Ready, Updated and, where it carries the revision annotation, Revision; a StatefulSet and a DaemonSet Ready and Updated; a node Pods, CPU requested, Memory requested and Kubelet; any other kind has none, and no strip.
    - Rust tones a pod's Restarts only where a container crashes or failed, and the webview adds the warning tone for a restart within the hour as the list does (4.4), unless the verdict is toned, the pod finished or another vital is toned, since a row raises one alarm.
  - The Diagnostics section of step 9 comes first in the Overview when something is wrong: why, in words, with its exit code, restarts, next try and the last log line of the instance that ended, and Previous logs and Logs buttons that open the container's logs tab.
    After a 150 ms pause they hold the object's Object upstream and follow it, as an editor does ([research](research/details.md#following-the-object)).
    Until the object comes, the row's cells stand in for its page: every column of the list, the wide ones too, each drawn as the list draws it, its printed durations counted from the row's stamp (3.4) and its measures as the polls bring them, so that the stand-in and the row say the same.
    The upstreams it leaves behind linger as a list's do, and give way to any watch that waits for the budget (3.2).
- **Compare with….**
  The picker offers the editor's own kind first, from every namespace and not the ones the lists have selected, and asks Rust for it with the text typed, as the pod search of quick access does, so an object past the first rows is found by its name; the objects the space opened lately, of any kind, follow.
  Where the cluster refuses the list of all namespaces (a person who may not list namespaces, or may list the kind in none, 3.2), it falls back to the selected namespaces and the object's own, which give the rows of those that may be listed, and says so, naming the namespaces that may not.
  Forbidden in all of them, it says that.
- **A URI and its space.**
  Each space has its own docks, and an editor opens in the dock of the space its URI names.
  An open for the URI of a space other than the one shown waits for that space's dock and opens there when it is the next one mounted; if another space comes first, it is forgotten.
  A forgotten open is reported as closed, so what a feature kept for the URI goes, unless the space's saved layout holds the URI: its tab comes back with the layout, and a restart that answered late keeps its terminal for it.
  A close for such a URI waits for that space's dock too, whichever space is mounted first, so a tab whose edit ended while the person was elsewhere does not stay behind; opening the URI again, or closing one that waits to open, withdraws what waits.
  A provider says which space a URI is of, so an answer that arrives after a switch of spaces cannot open a tab in the wrong space.
  A new manifest's URI names the space it was written in, as an object's does, and its number counts within that space, so a number reused after a restart cannot show the text of one space in another's tab.
- **Object URIs.**
  The core group is an empty segment, `k8s://prod//v1/pods/payments/api-0`, so an object in a namespace has five path segments and a cluster-scoped one four.
- **Opening an object.**
  An object always opens in a tab of its own, pinned, and the tab it was opened from stays.
  - The ways are a double-click on a list's row, ⌘Enter on the selected one (`k8s.resource.openEditor`, which the row's menu shows as Open in Editor), the icon in the details' header, a link to the object in another object's page, a row of a list inside an Overview, and the target's and the pod's links in a port-forward's tab.
  - Opening from a list's tab or a port-forward's tab pins that tab, and a link followed in an object's page pins that page's tab, so the object opens beside the tab and never in its place.
  - A double-click opens a row only when both its presses were on that row, and not from its mark cell or a button, link or field in it.
  - Quick access keeps its own ⌘Enter, which opens to the side and only while it has the focus (4.5).
  - No object opens as a preview tab; a list does, by a single click on a kind in the explorer and by Go to Resource's pick of a pod (4.5), which opens the pods list filtered to that name with the row selected and its details shown, and so does a port-forward's tab by a click in the Port forwards view.
- **Views.**
  A resource editor's Overview, YAML, Events and Related are a row of plates under the object's header, in the editor as in the details: one definition and one `TabBar` for both, its tablist one tab stop, whose arrows, Home and End show the view they reach.
  The YAML view keeps its toolbar, and an object editor's tab strip holds no actions of its own: its verbs are in its header's row, said once.
  Rust follows the object's Overview whichever view is shown, so that the pill, the sentence, the verbs' state, `resource.noContainerRuns` and an editor's subject are right on every view and the keys that read the Overview hold (`useObject`); the vitals' strip is drawn on the Overview alone.
  It follows the manifest while the YAML view is shown or an edit is held, which only an editor has, the related objects only while the Related view is shown, and a pod's or a node's usage while the Overview is shown in a visible window.
  The object's events are watched while its Overview is followed, which is on every view, and the batch's own `events` part, which the Events view draws, goes only while that view is shown.
- **The full page.**
  An object editor draws the full page once it is 900 px wide, measured on the editor itself since the editor area can be split, and keeps it down to 884 px so that a width on the boundary does not flicker; narrower, it draws the inspector's layout and shares the inspector's folds.
  - It is one column under the same header and views: the space's name leads the second line in its context's colour, `prod-eu › auth › Deployment auth-api`; the row of actions holds every verb of the kind in its groups with Delete set apart at the far right, where the inspector keeps its pinned verbs and More; the vitals strip is the inspector's.
  - Every section is open but Metadata, until the person folds or opens one, and those choices are kept per kind apart from the inspector's; a section that holds a finding opens over what was kept, as in the inspector.
  - Property rows run in two columns, each a label of 112 px and its value, 12 px apart, a long or plural value taking both; a pod's containers sit as two cards side by side.
- **Closing a tab.**
  When an editor that opens, closes or moves, or a space that shows, drops the keyboard focus to the page, the active group takes it, and the active editor its own where it has something to hold it, a text editor or a list's grid, so a key such as ⌘S, ⌘Z or `j` still reaches an editor.
  A person's close is `Editors.dismiss`: a tab's X, a middle click, ⌘W and Close Editor, Delete or Backspace on a focused tab, which dockview 8.8.3 would otherwise close itself ([`_closeTab`](https://github.com/mathuo/dockview/blob/v8.8.3/packages/dockview-core/src/dockview/components/titlebar/tabs.ts#L782-L817)), the Close Terminal… and Close Shell… picks, and the Close button of a port-forward tab whose forward is gone.
  It keeps the editor for Reopen Closed Editor (below), and when it takes the panel's last tab the panel hides (4.1), and the focus, where the panel held it or it had fallen to the page, goes back to the last element outside the panel that held it, else to the editor area's active editor.
  Quick access, dialogs, menus and toasts give the focus back themselves, so none of them is that element; a dockview floating group, also a `role=dialog`, can be.
  Delete or Backspace on a focused tab with others beside it in its group focuses the tab dockview would have, the next, else the previous, so the next key stays in the strip; ⌘W leaves the focus to the editor that becomes active.
  The app's own close, `Editors.close`, as when an apply's diff gives way or a removed forward's tab goes, hides nothing: where the editor it closed held the focus, the area's active editor takes it, or the editor area's when the panel has none left, and while a maximized panel covers the editor area nobody does, and the focus stays on the page.
  An open that the person asked for, from quick access, a button or a command, gives the editor it opened the focus from whatever held it, an editor on screen in another group included, except a field outside the editors.
  One that arrives on its own, such as the diff of an answer or an object that a plan made, and the explorer's, whose tree goes on with its keys, take it only from the page and the dock's own elements, never from another editor or from anything outside the editors (`preserveFocus`).
  A hidden or covered part loses its height and not its elements, so it would keep the focus it held, answer Tab, and take back the focus that quick access or a dialog gives back, and the keys would go on to what nobody sees.
  Such a part, a hidden side bar among them, is `inert` from the moment the layout's state changes, and the focus held inside moves just before to the active editor of the area the person works in, the editor area or the panel while it covers it, or off the page when that area has none: a maximized panel with nothing open leaves the page without a focus, since the covered editor area is inert and refuses it (the mock in Chromium and WebKit, 2026-11-09).
  What quick access or a dialog took the focus from gets it back when it closes, or the editor area's active editor does when that cannot take it, or the panel's when the editor area is covered or has no editor, so a closed dialog or an Escape leaves the focus on the page only where no editor can take it.
  A space shown with a maximized panel gives the focus that fell to the page to the panel's active editor once its dock is attached, since the covered editor area refuses it; a shell tab whose terminal is not on the page yet takes it when its view puts the terminal there (the mock in Chromium and WebKit, 2026-11-09).
  A list that asked for the focus before its grid mounted, which is after its resources arrive, gets it when the grid mounts, unless the focus has moved on by then or the list closed (the mock in Chromium and WebKit, 2026-11-09).
  While a maximized panel covers the editor area, Close Editor and the other editor commands act on the panel's active editor whatever has the focus, so ⌘W never closes what nobody sees.
  A panel shown again gives the focus to its active shell tab, unless quick access is open, which stays on screen and keeps what is typed; a dialog needs no such rule: with the rule taken out, a confirm dialog kept the focus and the shell received nothing (the mock in Chromium and WebKit, 2026-11-09).
- **Clicking a tab.**
  A press of the left button on a tab, in the editor area and in the panel, shows its editor and gives it the keyboard focus through the editor's registered `focus`, whatever the editor is.
  VS Code's tab does that on mouse down: it [opens the editor with `activation: ACTIVATE` and without `preserveFocus`](https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts#L1085-L1144), the group [activates itself](https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/browser/parts/editor/editorGroupView.ts#L1241-L1298), and the [pane takes the focus](https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/browser/parts/editor/editorPanes.ts#L262-L269).
  A press on the empty part of the strip does not leave the focus where it was: the group's [title container](https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/browser/parts/editor/editorGroupView.ts#L511-L537) gives it to the group's active editor, a task after the press, since the browser moves the focus to what was pressed after the press's listeners ran.
  Where the editor of that group already held the focus, the focus stays; where it was elsewhere, it comes to the editor of the group pressed.
  A press on a button, such as a tab's X or an action, and one of another mouse button take none of this, and a preview tab stays a preview.
  Dockview activates a tab a frame after the press, and the press left the focus on the tab, so the keys of a terminal or a shell went nowhere (the mock in Chromium and Playwright's WebKit, 2026-11-11).
  An editor with no `focus` of its own leaves it on its group.
- **A tab's tooltip.**
  An editor's descriptor gives its tab a `tooltip`: where the editor's subject is, in one order, context › namespace › kind › object, as `prod-eu › payments › Pod › auth-api-7f9c8d6b5-h8lbx`.
  A list's reads its context, its namespaces or `All namespaces` unless its kind is cluster-scoped, then its title; an object's, a logs tab's and a shell's their object's path, a shell's then its container; a forward's its target's path, then its port; a diff's the path of its object or manifest, or both sides of a comparison with `↔` between; a terminal's and a new manifest's their space's context.
  The context is the one of the tab's own space, which its URI names, whichever space shows, and the tooltip is asked for each time it opens, so a scope changed meanwhile reads as it is.
  It stays shut while a button is down on the tab, since a press held past its delay starts a drag, takes no pointer, so that it never lies where the tab is dropped, and keeps its delay after such a press.
- **Reopen Closed Editor.**
  ⇧⌘T, in the palette and the File menu, brings back the last editor the person closed in the active space, of either area, that is not open again; the app remembers the last 20 editors a person closed, of every space, until it quits.
  An editor's descriptor says with `keep`, as it is closed, how it comes back: a logs tab with its pods and containers, its range, level, filter and search, wrap and timestamps, but not where it stood; a shell or a terminal, which cannot be restored, with a new session at its URI, started as a new one is (4.6); any other editor by opening its URI again.
  Reopen Logs, which the empty panel offers (4.1), brings back the space's last closed logs tab the same way.
- **An editor off screen has no Monaco view.**
  Behind another tab of its group or under a maximized panel, a YAML editor or a diff disposes its view.
  A YAML editor's model, cursor, scroll and undo stay in the working-copy service until it shows again; a diff's models go with its view, and `DiffView` keeps its view state (cursor and scroll) in a ref for the next one.
  [`CodeEditorWidget`](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts#L1954) sends a typed character through a command that goes to the [first view that says it has the text focus](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/editor/browser/services/abstractCodeEditorService.ts#L104), and WebKit, which has no `EditContext`, fires no blur on a focused element that leaves the page (measured with Playwright's WebKit on the mock, 2026-11-09), so a hidden view went on taking the keys typed into another.
- **Working copies.**
  A YAML editor that the user has changed holds a working copy based on the opened `resourceVersion`.
  - The service is keyed by the editor's URI and holds the object as opened (`base`), the `lock` an apply is held to, the object at that lock after "Keep mine" (`locked`) and the text.
    A text that is the object again ends the copy.
  - A dirty editor pins its tab and marks it, and the live object does not overwrite its text, so the object stays followed on the other views while the copy lives.
  - When the live object changes underneath, the editor shows "changed on server" with Compare, Reload and Keep mine.
    It compares the live object with `locked`, else `base`, without `resourceVersion` and `generation`, and without `status` where the resource has the `status` subresource, so a controller's status write raises nothing.
  - Keep mine sends the old `base`, the new `lock` and `locked` (`OpenedEdit`), since diffing against the new live object would revert the other writer's change.
  - Save runs the apply flow (6.5): the text is parsed with the `yaml` package at version 1.1, set to read what kubectl reads, which is the one dialect, and a text of several documents is refused, since the engine previews one object at a time.
    kubectl reads a manifest with sigs.k8s.io/yaml v1.6.0 over go.yaml.in/yaml/v2 v2.4.4, which Kubernetes v1.37.0 pins ([go.mod](https://github.com/kubernetes/kubernetes/blob/v1.37.0/go.mod)).
    The rule: every text reads as kubectl reads it or is a parse error at its line, and every value the writer writes reads back equal in the webview and in kubectl, so that an object the cluster holds always opens and reads back.
    A refusal costs a person a pair of quotes, and a wrong value costs a live object.
    Dates, sexagesimal numbers (`22:22`), sets, ordered maps and binary are no types there, so `2024-01-01` and `22:22` stay strings, as keys too, and `0o777` is `511`.
    Whether a plain scalar is a number is decided by the rules of `resolve` in go.yaml.in/yaml/v2 v2.4.4 (`resolve.go`), which `goNumber` follows.
    What JSON cannot carry through the IPC is a parse error at its line: `.inf`, `.nan`, an integer past 2^53, negative zero.
    An integer past 2^53 in a live object shows rounded in the editor, as it reaches the webview through JSON; an edit that would send it whole is refused (6.5).
    So is a key that is empty, not a single value, or a float, which kubectl names at 32 bits.
    So is what Twigo does not read: a tag (`!!set`, `!!omap`, `!!binary`, `!!float`, `!!int`, `!!timestamp`, a local tag), a directive, an anchor outside `[0-9A-Za-z_-]`, an alias with no anchor or inside its own anchor, a merge of something else than maps.
    A key JSON makes one of two (`1` and `"1"`, `y` and `true`) is refused, since kubectl takes the last of such keys or, over a Go map, a random one.
    Where the two scanners read a text apart it is refused too, each named at its line.
    A merge whose result depends on where it stands is one: a key set before the `<<` that also sets it, or a second `<<`.
    So is a tab that starts a line or follows a block indicator, a control character, and a BOM past the first character.
    So are U+0085, U+2028, U+2029 and a lone CR, which are line breaks to kubectl and text to the webview.
    In double quotes `\/`, a surrogate escape and an escaped line break are refused.
    So is a key that spans lines or whose `:` is not on its line, and a `?` whose `:` is not in its column.
    Inside `[ ]` or `{ }`, so is a plain scalar that spans lines, holds a `?` or starts with `:`, and a key whose `:` touches the next indicator.
    An empty document before the object is refused, as `YAMLToJSON` reads only the first.
    Lines of spaces are refused in a block scalar with an indentation indicator, or at the end of a text with no final line break.
    The writer quotes what would read as something else, a key named `<<` among it, uses double quotes where the block form cannot carry a string (a line that starts with a tab or holds only spaces, a string that starts with a line break), escapes U+0085, U+2028, U+2029, DEL, C1, U+FFFE, U+FFFF and a BOM, and writes an integer past 2^53 as an exponent.
    `packages/kube/test/k8s-yaml/` holds the check, recorded from Go (`node record.mjs` there): what Go made of 897 texts, and that it read back 9,781 written values equal, and a Vitest test fails on any difference and lists each refusal with its reason in `refused.json`.
    As recorded on 2026-11-08: no difference, 524 texts read alike, 218 refused by both, 155 refused here that Go reads (duplicate keys, float keys, integers past 2^53, the tags and the line breaks above).
  - When the plan of an apply is done the copy ends, but its text stays the editor's until the live object differs from the one the copy was based on, or locked to, compared as "changed on server" is, so that the editor never shows the object as it was while the new one comes by its watch.
    A status write does not end it, as it moves the `resourceVersion` without changing the object; the object equal to the `result` of the preview that was applied does, so that an apply that changes nothing in the object holds nothing for good; typing or closing the editor does, and it is never written to the state.
    A Secret's text is not held at all: its values are masked to their sizes, so a value rotated to one of the same size would leave the object looking as it was, and the typed plaintext on show.
  - Unsaved working copies survive a restart (backups per space, the `edits` key of the space's state), written a pause of 300 ms after the last change.
    A space's backups are taken up when the space appears and before the first copy is made in it, so one that was hidden when the app started (its context missing from the catalog for a while) keeps them.
    A Secret's never is: not an object of the `secrets` resource, not the text of any editor that mentions a Secret, since a Secret's manifest can be pasted into another object's editor, and not a new manifest that does not parse, or whose kind is empty or any prefix of `Secret` in any case, since the values may be typed before the kind, which is `Sec` on its way to `Secret`.
  - Closing an editor keeps its copy, which the tab shows again when the object opens anew.
  - An object that is deleted, or that the cluster cannot be asked for, leaves the YAML tab its editor while a copy exists, on the object the copy was based on, with a bar that says why the object is not there.
  - The diff against the server, like the diff of two objects, follows the object itself rather than what its editor last saw, so it holds after a restart and when the editor's tab is closed, and it tells the copy what it read, so that Keep mine from it locks to the version it shows; a diff of two objects says which of them it cannot read, and that a Secret's values are hidden as their sizes.
    A side that the object changes under updates in place and keeps the cursor and the selection of whoever is reading it.
  - The service also keeps each shown YAML editor's Monaco model, which holds its undo stack, and the cursor and scroll of its view, so they survive a switch between Overview and YAML.
    They go when the editor closes, the copy staying as text; a text that comes from outside, the live object once a copy has ended, replaces the model's and leaves the cursor and scroll where they were, and clears the undo stack.
- **Overview.**
  One document per object, described in Rust by `twigo-describe` and rendered alike by the drawer, the Overview tab and MCP's describe-style summaries (6.6) ([research](research/details.md)).
  - Its `header` holds what the page says around the name (above): `owner`, the controller at the top of the object's owners; `node`; `created`, which gives an object opened with no list row its age; `generated`, where the generated part of its name starts, as a list row's does; `printed`, the cells the server prints for it in a list, from which the page takes its pill's word; `sentence`; and the `vitals`.
    A pod's describer names its controlling ReplicaSet or Job as a need, for its owner to be the Deployment or CronJob above it.
  - Sections have ids and an order, the object's state first: Diagnostics when something is wrong, then what a triage of the kind reads, down to how it is configured and what it is, as data of the kind's layout in `twigo-describe`:
    - a pod: Containers, Events, Conditions, Placement, Storage, Configuration, Metadata;
    - a Deployment, StatefulSet and DaemonSet: Rollout, Pods, Events, Conditions, Pod template, a StatefulSet's Volume claims, Strategy and scaling, Metadata;
    - a node: Capacity, Conditions, Pods, Pod resources, Events, Taints and labels, System, Resource slices, Metadata;
    - any other kind: its first section, Conditions, its other sections, Events, Metadata; the first section of a Job, a CronJob, a Service, an Ingress and a claim is named after the kind, `Job`, `CronJob`, `Service`, `Ingress` and `Claim`.
  - A thing is said once: no section of a pod, a Deployment, a StatefulSet, a DaemonSet or a node is named after the kind, and a pod's node, addresses, class, priority and scheduling rows are in Placement, its volumes in Storage, its policies and service account in Configuration, and its phase and readiness, which the pill and the vitals hold, are not rows at all.
  - Each section says what it holds before it is opened, and whether it must be:
    - `summary`, a line of text and times that keep counting at its header's end, such as `3 of 5 ok`, `2 volumes · 1 claim` or `1 warning · BackOff ×5`, naming the finding where one is about the section;
    - `tone`, danger or warning where it holds what is wrong, which its header marks with an edge;
    - `fold`: `open` for the triage set, Diagnostics, a pod's Containers, a workload's Rollout and Pods, a node's Capacity, the first section of a kind whose layout names none, and Events while one is a warning; `finding` for a section that holds something wrong that the Diagnostics section does not explain, which opens over what the person last chose; `folded` for the rest.
  - Each section holds blocks from a closed set (fields, diagnostics, tables, conditions, containers, data keys, live lists, events, a tree), which the webview renders with a switch that lint holds exhaustive.
    - A field has `default` where its value is the cluster's own (a pod's Priority 0, its Service account `default`, Restart policy `Always`, DNS policy `ClusterFirst`, Termination grace 30 s, Scheduler `default-scheduler`, a container's image pull policy where it is the one the API server gives that image), and the section hides such fields behind their count.
    - A condition has `explained` where a finding already says why it is wrong, and then shows only as its chip.
    - An event list has `listed` once the events have been listed, so that an empty one means there are none, and the Events section's line says nothing until then.
    - A value of `spans` is text and times in one line that keeps counting, as `code 1 (Error) · 11d ago`.
  - The core says what is wrong, and the webview how it looks ([decision](decisions/object-page.md)).
  - A section's header is one toggle of 24 px: the chevron leading, the title strong at 13 px and weight 600, and its summary at the end in the support role, cut before the title is; the tone is a 3 px edge at its left, as a problem row of a list has; the header of the section whose content is at the top sticks under the views while that content scrolls; and ⌥-click folds or opens every section.
    There are 24 px above a section and 8 px under its header, and 4 px between two folded ones.
    A section opens as its `fold` says until the person folds or opens it, and that is kept per kind while the app runs, a `finding` over it; the person can still fold a finding's section for the object they folded it in.
    The fields a section hides behind `5 defaults` show, in the support role with a `default` tag, once the person reveals them, which is kept per kind too, and `Hide defaults` folds them again.
  - `/` while an Overview holds the focus opens a filter at the end of the views row, or on a line of its own where the row has no room, `Filter this Pod`, in the list's syntax (`!not`, `/regex/`), by the one matcher the list's text filter has, `parseText`, which the mock's tests and Rust's hold to `query-cases.json`.
    It matches section titles, labels, values and the rows of a container's groups, the hidden defaults too, since a filter shows what a fold hides: a section with a match opens, the others and the rows that do not match hide, and the row says `3 matches in 2 sections`.
    Enter moves the focus to the first match, Escape clears the text, and the folds the person had come back.
    The filter's text, and where the page was scrolled to, are kept by the editor's URI, the list editor's for the inspector, so that moving to another object of the kind leaves the text where it was and the section that was at the top at the top, at the same offset into it.
  - Values follow rules in one place (`stacking.ts`, `labels.ts`, `image.ts`):
    - the property lists of a page read one label column of 112 px, in which a label wraps, so values share one axis, except a container's environment and mounts: keys and paths in the monospace, they keep a column of their own up to 14 rem, which cuts what does not fit;
    - a value that is long or plural takes the page's width under its label: labels and annotations, lists, and text or code of more than 40 characters or with line ends;
    - labels draw as lines, `key=value`, the key's domain prefix quiet, three shown and then `Show all 9`, a value of more than two lines folded to two and the `last-applied-configuration` annotation folded from the start;
    - an image's registry and path are quiet before its name and tag and a digest is folded to its first four hex digits, the copy icon giving the whole reference;
    - an object's name is cut in the middle, with its whole text in its tooltip;
    - prose is at most 640 px wide, in the inspector as on the full page, three lines and then `more` (`Prose`, `max-w-160`);
    - a time is an age, its moment in the tooltip and in what copy gives, and an empty value is a dash in the quiet role;
    - a 12 px copy icon lies at the end of a row on hover or while the focus is within it, and is out of the Tab order.
  - Core kinds get describers (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, Node, PVC, ConfigMap, Secret): at least what `kubectl describe` prints, plus a Diagnostics section when something is wrong.
    A describer names the objects of other resources it reads, such as a Deployment its ReplicaSets, a pod its controlling ReplicaSet or Job, a Service its EndpointSlices or a node its pods, and `twigo-core` follows them through the hub while the object is open, on every view.
  - Conditions are chips, a mark in the condition's tone, its type and its age, with its status, reason and message in the tooltip; a wrong condition that no finding explains says why in a line below, once for the conditions that say the same.
    Events show the newest three, warnings first, then `All 23 events`, which opens the Events view; under the page's filter they show every event it keeps and no link.
  - A container's card shows its name, role, state and restarts, its ports and image, how it ended, and its CPU and Memory.
    - A container terminated now says `Exited` with its code and age, since its state already says why, and an earlier termination says `Last exit` with its reason, as `code 1 (Error) · 11d ago`.
    - Each of CPU and Memory is one line, the figure, a meter and its share, as high as a text row and in one form whatever it has to say, so that no answer moves what is below it.
    - What else `kubectl describe` prints of it, its environment and its mounts folds into one line of counts, `Details 4 · Env 5 · Mounts 1`, whose groups open in place; Details holds when it started, the last termination's message, requests and limits, command, arguments, working directory, pull policy, probes, security and the image and container IDs.
    - The state the IPC carries says in `running` whether the container's process runs, set where its status has `state.running`, which the details read for Shell and Attach (4.6).
  - A pod's and a node's Overview also show what the object uses, from the poller's sample (3.6).
    Usage is not part of the document but of the object's batch beside it, with a dirty flag of its own, so a new sample describes nothing again; the webview asks for it while the Overview is shown in a visible window, under the gate a list reads its metrics by (4.4).
    Each container that has a sample comes against its request and limit, the pod's own against the sums only where every container counted has them, and a node's against its allocatable.
    A pod's total is the CPU and Memory cells of its vitals (above), each container's the lines of its card, and a node's a Usage section after its Diagnostics, as meters against what it can allocate.
    A measure is held against what a node allocates, else a container's limit, else its request, whose mark its meter carries; the percent is kubectl's, truncated and past 100 where it passes, and from 10,000 % a share reads `>9999%` with the exact share in its tooltip.
    A node's meter is 11 rem wide at most, so a wide editor does not stretch it, and a quantity's unit is quiet beside its number.
    Against a limit or what a node allocates, 90 % is a warning and the limit an error, in the meter and in words.
    A row without a sample says no data yet, never zero, and a Metrics API that does not answer or may not be read says so in place.
    The usage comes with the Overview once the context's discovery is known, and in a later batch before that, which the usual order of events, resources first, makes rare, and a usage that has `waiting` draws its rows at their height: a node's meters, a container's line with an empty meter, a vitals cell as a dash that says it waits for the first sample, and the answer fills the same rows.
    A container has a line where the usage names it or its state says it runs, so a finished init container has none and a running one the usage lacks says no data yet; the webview guesses nothing from discovery, which lists no resource of a stale API.
    Without a usage in the batch a node has no section, a pod's containers no lines and its cells a dash.
    The webview remembers nothing of what the Metrics API said and draws the usage it is sent: the core says a refusal with the Overview where it remembers one for the scope (a namespace of pods, or the nodes), and keeps an object's last figures while its scope is asked anew, so a tab that returns or a document shown again does not blank what it shows (3.6).
    A usage that says `absent`, once the context stops serving the resource, withdraws the figures as if none had come, until a later batch brings one.
  - Any kind, CRDs included, gets a generic overview: the server's printer columns, a `status.conditions` table when present, spec and status as a tree with the descriptions of their schema, metadata, events.
  - A workload's pods, a CronJob's jobs and a node's pods are live resource tables inside the Overview, run by query views: a workload's by the uids of what controls them, a node's by a field selector.
    They draw as a list does (4.4): their columns of priority 0 give way by their measured width, and their rows come in the order the core gives; a click or Enter on a row opens its object in a tab of its own.
  - Extensions add declarative sections per GVK (5.4), and replace a core section only by naming its id.

### 4.4 Resource tables and the keyboard

- Columns come from the Table `columnDefinitions` (priority 0 by default, wide on toggle), plus Context, and Namespace unless the query names one namespace.
  Pod and node lists of a context that serves the Metrics API (3.6) also get CPU and Memory, of priority 0, just before the Age column, whose cells are numbers the webview prints as kubectl does.
  Each kind keeps a preset for every space: the columns the user showed or hid by name from the head of the actions column (a column nobody chose for follows its priority), the widths they dragged or fitted, and the column the rows are grouped by.
- What a column does is data in `packages/kube`, a rule by kind, then by name, then by `group/resource/column`: its cell, starting width, alignment, whether its text cells are secondary and read in support, whether rows group by it, which way its first click sorts, the tone of its abnormal values, where it goes as the list narrows, and whether a hovered row's icons may lie over it.
  Columns keep their widths, numbers and ratios aligned to the end; the name column takes the free width until the user sizes it; a double click on a header's edge fits the column to what it shows.
  As a list editor's grid narrows the name column first gives up the free width it takes, down to its starting width of 160 px; then columns leave one at a time, by their rule's drop order, until the rest fit ([decision](decisions/parts-give-way-by-width.md)).
  The pod list's order is Node, Memory, CPU, Age, Namespace and Context, Restarts, then Ready, which goes into Status and reads before its text, `0/1 CrashLoopBackOff`, in tabular figures as in its own column, giving it 24 px more, and Status last.
  A kind's health column always goes last, as a node's Status or a Deployment's Ready; among equals the right-hand one goes first, a column no rule ranks, as a DaemonSet's Ready, goes before every ranked one, and the name column never goes.
  What shows is worked out from the widths in effect, the user's or the rule's, against the grid's measured width, so a width shows the same columns whichever way the grid came to it, and a wider one brings back the last gone first.
  A column that leaves is only hidden: the preset keeps the user's choices and widths, and a sort by it holds, with a note on the Name header that the column has no room at this width.
  A list inside an Overview draws the name and the columns of priority 0 and gives way by the same rule, by its measured width: those columns leave in the list's drop order until the rest fit, the name column never, and every column shows until the width is measured.
  A grid's first column stays at its left edge while the grid scrolls sideways, and only where it leaves the actions column its room beside it, so that it never lies over a row's ⋯ or the choice of columns.
- Cells read by what matters, data near-monochrome, in the text roles of 4.9:
  - a name reads in three parts (3.4): what comes before its generated part in content, the hash quiet, and the last segment, after the generated part's last `-`, in support; one that does not fit gives up the hash first, to its first character and an ellipsis, its trailing `-` going with the rest (`auth-api-7…x2kq9`), then the end of its first part, and never the last segment, which tells siblings apart; in the row under the cursor and in a selected one the name is strong;
  - a status shows a tone dot, its text coloured and at weight 600 when abnormal, the dot pulsing while the state is in flight (ContainerCreating, Terminating); the pods' Status column starts at 168 px, since `Init:ImagePullBackOff`, the widest of the statuses that fitted its former 160 px at weight 400, takes 166.2 px at 600 with its dot (Chrome on the mock, 2026-11-16);
  - a healthy value of a kind's health column, and of a pod's Ready, reads in support, so that only an abnormal one stands out: a pod's Ready and Status, a node's Status and a Deployment's Ready, by their column rules' `recedes`; Name, CPU and Memory stay in content;
  - a ratio short of its total (Ready `0/1`) is pending, unless the row's status already carries a tone, so that a row raises one alarm; a pod that ran to completion, whose Status reads `Completed`, `Succeeded` or `ExitCode:0` as kubectl prints it, is short of nothing, since [`printPod`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/printers/internalversion/printers.go#L1086-L1089) counts a container ready only while it runs, so its Ready recedes as a healthy one does;
  - restarts read as a count in a column of its own and how long ago the last was, the age growing from the moment the server printed it (3.4); a restart within the hour draws the count and its age in the warning tone, unless the row raises its alarm already, by its tone or by a ratio that draws one, or its pod ran to completion; whether a row raises its alarm is decided once per row and render from its columns' rules, not by each cell (`decideRows`);
  - a CronJob's Last Schedule, an event's Last Seen and First Seen and a custom resource's `date` columns, the other columns that print a duration (3.3), grow from the same moment ([decision](decisions/printed-durations.md)), each cell drawn again only when its text or its tone changes, on the one timer of the page's ages; a cell with no moment to count back from, as a stamp that does not parse or a moment more than a second ahead of the clock, shows what the server printed, in the plain step;
  - Namespace and Context read in support, an age in content for its first ten minutes and in support after, and a zero count, an empty value and a quantity's unit (the `m` of `120m`) quiet;
  - figures line up in tabular numerals: a column of ratios, restarts, ages, CPU or memory, or one the server declares a number, and in any other column each cell whose text is figures or IPv4 addresses, since rows stream.
- Rows are 24 px with no line under them, under a 28 px header that keeps its line, as a group's header does.
- A failing or pending row is a band: a 3 px edge in its tone at its left and the tone over the row, 9 % for an error and 7 % for a warning, quiet reading as support on it.
  The pointer's hover lies over the band; under the cursor and on a marked row the selection's fill takes the band's place, since laid over the band it takes text in the tone below 4.5:1 in both themes, and support in the light one.
  The band carries over to the row's held first cell, its hover icons and a laid-over menu, as the selection's fill does.
  A list inside an Overview draws it too.
- Grouping by a column (Namespace, Node, a status) puts a header before each group with its rows and how many fail or wait; a click or Enter folds it, Left goes to it from a row, and folded groups are kept per list.
- The last column is the row's actions: a ⋯ button on hover and on the selected row, and the same menu on a right click, from `resource/context`.
  Once the pointer has rested on a row for 60 ms, the first two verbs its kind pins in `resource/details` (4.3) show as icons before the ⋯, read with the row's own state and its own RBAC answers (5.1): a verb that cannot run disabled with its reason, one the mode will refuse dimmed, with its lock in its tooltip.
  They lie only over the columns at the row's end that their rule lets them cover, as an age or a measure, never Name, Ready or Status, and only where those leave them room; their tooltips name no key, since a key acts on the selected row.
  Beside docked details the selected row shows none, since the details show its actions, and while the details lie over the list no row shows any.
  A press on an icon selects its row and runs the command there.
  A command on rows acts on the list its lookup names, `list.uri` (5.1), whichever editor is active, and on nothing where it names none.
- Marks: X marks the row under the cursor, ⇧↓ and ⇧↑ mark as they move, a click on a row's box marks it; Space shows the details (4.3).
  Marked rows get a bar at the bottom with the commands of `resource/marked`; Esc clears them.
  A change of the list's text, health or, for a namespaced kind, namespaces clears them too, as a new search clears a selection, so no command acts on rows the list no longer shows.
  Marks are row IDs (3.4).
- Focus model: arrows or `j`/`k` move, Enter shows the details, a double-click or ⌘Enter opens the object in a tab of its own (4.3), Left and Right fold, `/` or ⌘F filters, Esc clears.
  These are the workbench's `list.*` commands, which drive every list and tree.
- A list's filters sit at the right of its group's tab strip, as the editor's actions (`editor/title`): its health as one control of All, Failing, Pending and Healthy with their counts, for kinds with a health column, a pod's or a node's Status or a Deployment's Ready; the text field, which names its syntax and its key; the grouping; and a pin.
  They take no row of their own, so a table sits under three bars: title, tabs, header.
  Each open list keeps its own; a count in the status bar picks the same health.
  A list of a namespaced kind whose namespaces are narrowed leads its actions with a chip of them: the namespace glyph and the first name, `+2` after it for more, the names in its tooltip, on a 24 px plate filled as the shown view's plate is (`--row-active`, 4.9).
  A click opens the namespace picker and its close mark gives the space back all its namespaces, with the focus going to the list's grid, or to its editor where the list has no grid any more.
  No chip shows while the scope is all namespaces, nor on a list of a cluster-scoped kind.
  A list whose URI names namespaces of its own shows them as a label, one tab stop with no click and no close mark, its tooltip shown on focus as on hover, and an accessible name that says the list shows them whatever the space's scope is.
  The tabs come first: the actions take what the strip leaves beside its tabs, each at the width it asks for (4.9), less the 4 px before the first tab, the 2 px between tabs, the 28 px of dockview's overflow button with the space after it, and the 6 px after the actions.
  Where that is too little they give way one stage at a time ([decision](decisions/parts-give-way-by-width.md)): the field's key hint, the Group button's label, the field for an icon that opens it in a popover, which `/` opens too and whose first Escape clears the text and the next closes it, and the health control for a menu named by its choice.
  Then the scope chip gives way: it cuts its first name in the middle, down to a floor of 16 characters, then folds to its glyph and how many others follow, for several namespaces, then to its glyph alone, 24 px, its close mark leaving with the name and its click still opening the picker.
  Its forms are measured from hidden copies at their natural size, and it comes back to a fuller form only with a pixel to spare, since the room it reads is the row's width less the chip's, two widths each rounded to a pixel.
  Each health count keeps room for the most digits it had while the text was empty, with an invisible copy of that many figures, written in zeros and grouped as the count is (`data-reserve`), so a text that lowers the counts moves no stage.
  While the field or its Clear button has the focus no stage moves at all, since a list opened with a text in its URI has seen no count without one, and a stage that moved would shift the field under the caret or replace it; nor while the focus is in the scope chip, whose close mark a fold would take away with the focus; the actions settle once the focus leaves.
  While the popover is open the filter stays an icon, wherever the focus is in it.
  Beside docked details the actions end at the list's right edge, and the details shrink so that the list keeps what its strip needs at the last stage (`STRIP_KEPT`): the 4 px before the first tab, the active list's tab at 220 px, the overflow button's 28 px, and the actions at their last stage, the scope chip as its glyph, with the 6 px after them (4.3).
  The room the details take is read as they dock, before paint, so their first frame ends the actions at that edge too.
  A group's actions are keyed by their editor, so one list's stage does not carry over to the next, and as they settle the strip scrolls its own tab list, not the split views around it, to keep the active tab in view, as dockview 8.8.3 does only as a tab activates ([`_scrollTabIntoView`](https://github.com/mathuo/dockview/blob/v8.8.3/packages/dockview-core/src/dockview/components/titlebar/tabs.ts#L839-L888)).
- A pinned list keeps its namespaces, text and health in its URI and shows at the top of the explorer; a kind whose list is open shows its rows and its worst health there.
- An empty list names where it looked, the context, then the namespaces it is narrowed to: `No pods in prod-eu`, `No pods in prod-eu · payments`, and `No matching pods in dev · payments-x, auth-x` under a filter; so do a list inside an Overview and the Port forwards view, as the empty panel names its space (4.1).
  A list of all namespaces that leaves some out because the credentials may not list the kind there speaks of the ones it reads, `No pods in the 3 namespaces you may list`.
  The status bar's cluster entry says the same in numbers, `3 of 46 namespaces` in the quiet role, with how many are left out in its tooltip, unless a parts line that names unready parts (3.7) takes its place, and its rows entry says `1 deployment` where it has one row.
  A list of all namespaces that the cluster refuses says `These credentials may not list pods in every namespace at once.` and offers Choose namespaces, which opens the picker (4.5), where a refused selection or a cluster-scoped kind keeps `These credentials may not watch pods.` and its Retry.
  While parts of the list are not shown it can speak only of the namespaces that are: `No pods in the namespaces shown`, `No matching pods in the namespaces shown`, and the page says that the namespaces that are not ready are left out and the status bar says which (3.7).
- Single-key verbs work only when a table is focused (context key `listFocus`), or on an object editor's Overview outside a text field (5.1): `l` logs, `s` shell, `f` port-forward, which asks which port, even of one, `⌘⌫` delete (with confirmation), off a bare key since k9s users deleted the wrong object from one ([research](research/workbench-design.md)).
  `e` shows the YAML and `⌘↵` opens the object in an editor in a list only, since both need `list.uri`.
  Bare letters read; a write is ⇧ and a letter, with its friction (6.4): `⇧S` scale, `⇧R` restart, `⇧C` cordon, `⇧U` uncordon, `⇧D` drain, `⇧T` trigger, `⇧P` suspend, `⇧O` resume.
  `⌘⌫` deletes the marked rows while there are marks, else the selected one.
  These are ordinary commands with keybindings, so users can remap them.
- Changed cells flash briefly: the cell's background starts at the `--flash` tint and fades out over 1 s, as the opacity of a layer behind the text, which runs on the compositor and leaves the page asleep ([bench](bench.md#the-visible-window)).
  A batch that changes more than 8 rows flashes nothing, so a rollout does not strobe the table.
  The flash is a setting, on by default.
- CPU and Memory are measures, not states (3.6): end-aligned numbers as `kubectl top` prints them, CPU in whole millicores rounded up (`12m`) and memory in whole Mi rounded down (`34Mi`), and a quiet dash for a row without a sample, never zero.
  They never flash, and count for none of a batch's 8 rows, since a poll moves them every 15 s.
  The list says with its window that it reads them while its editor is on screen, behind no other tab and under no maximized panel, and the document is visible, and either it does not know yet which columns of its resource are measures, from its own columns or from a list of the resource opened earlier in the session in the same space, since one space's cluster may serve the Metrics API and another's not, so that a list sorted by one is held from its first rows, or it draws one or is sorted by one; a resource whose columns came with none says it reads nothing, and a list too narrow for its metric columns draws none and reads none unless it is sorted by one.
  While a new subscription has no columns yet, the list keeps the metric columns it last drew, so a narrow list does not read them meanwhile.
  A list inside an Overview follows the same rule and counts every column as drawn until its width is measured, which comes after its first window, so that one sorted by a measure is held from its first rows; once measured it reads only the measures that its width leaves drawn, or that it is sorted by.
  A new query, from a sort, a filter or a change of namespaces, opens its subscription before the old one closes, and the old one stays on screen and open until the new one's first batch, so a scope the old one read keeps its reader and its samples.
  A first click on their header sorts the largest first, as [`kubectl top --sort-by`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/metricsutil/metrics_sorter.go#L71-L83) orders, and the second ascends.
  A header whose Metrics API does not answer, or may not be read, carries a quiet mark with the reason in its tooltip, and its cells stay dashes.

### 4.5 Quick access (the command palette)

One input, with providers registered by prefix (VS Code `QuickAccessRegistry` mechanics, Kubernetes-oriented prefixes):

| Prefix        | Provider                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_ ⌘P   | Go to resource: names from the space's live upstreams, recently opened objects, and a metadata search per kind when asked                                      |
| `>` ⌘⇧P       | Commands. Shows only commands whose `commandPalette` menu `when` holds; recently used first (legacy `commandHistory`)                                          |
| `:`           | k9s grammar: `:deploy`, `:po payments /api app=web @prod-eu`, aliases (`:dp`, user-defined `fred: pod fred app=blee`). Opens or focuses a `k8s-list://` editor |
| `@`           | Symbols of the current editor (YAML outline, overview sections)                                                                                                |
| `ctx `, `ns ` | Switch or create a space; set the namespace scope                                                                                                              |
| `?`           | List the prefixes and the current keybindings                                                                                                                  |

Quick-access providers are core-only in v1, as in VS Code.
Extensions add commands, not prefixes.

- **The widget** drops from the title bar's search field, centred under the title bar and min(600 px, 62 vw) wide, as VS Code's quick input.
  It draws its own listbox and holds its own cursor: the input is a combobox whose `aria-activedescendant` names the row under the cursor, and a row is an option.
  A value typed puts the cursor on the first row, whatever the cursor did before, or on none where the provider takes ticked rows and the filter is empty, and Enter before the rows of that value have come waits for them and acts on the cursor's row once they do; typing again withdraws it.
  Where the person takes one row at a time `aria-selected` is on the cursor's row, selection following focus as the [APG's listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) describes it.
- **Rows are data** (`QuickPickItem`) that the widget draws alike for every provider: the kind's icon or a space's tile, the label with what matched the filter bold in the brand colour, a description such as the namespace in support, a state only when it is abnormal as its dot and its words in its tone, the kind at the end in quiet, and keys.
  A row that opens something in another space leads with that space's tile, as a `:` list does whose `@` names another space's context (4.2).
  Filters match as Sublime Text does (fuzzysort), so a row's highlight is what its score came from; the pods of the no-prefix provider are filtered in Rust by substring, and highlight that.
- **Recent first.**
  The no-prefix provider shows the space's recently opened editors that match under Recent, each with its kind and namespace, then the pods; `workbench.recent` keeps them per space (4.8).
- **A footer of keys**: ↑↓ move, ↵ the provider's verb (Open, Run, Switch), and ⌘↵ open to the side where the provider can, which opens the editor in a new group to the right of the active one.
  Each is the binding of a `quickInput.*` command, so a key the user binds shows there.
  On the empty prefix the footer adds the prefixes whose providers name themselves for it (`>` Commands, `:` Lists, `?` Help), so a new provider shows up by registering.
- **Rows with a box**, for a provider that takes several rows (`acceptChecked`): a row that carries `checked` draws a box (`Tick`) and says with `aria-selected` whether it is ticked, a row without one is an action and says nothing of selection, and the list says `aria-multiselectable`; a polite status says how many are ticked.
  The cursor is the input's `aria-activedescendant` alone, since the [APG's listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) keeps focus apart from the selected state and indicates the selection of each option with `aria-selected` or `aria-checked`, never both.
  No row is under the cursor at the opening, until the person moves or types a value, so Enter at once closes with nothing changed.
  Enter or a click takes one row alone, as every provider's rows do, until the first tick; Space (`quickInput.toggle`, 5.2), a click on a row's box or ⌘-click on the row ticks, and from then Enter applies the ticked set, the footer saying `Apply · 3 namespaces`, and a click ticks.
  Before the first tick the footer says `Only this` on a row with a box, the provider's own verb (`Select`) on an action row, and `Close` where no row is under the cursor, since Enter then closes.
  The widget keeps the ticks across the values typed, so a row the filter hides keeps its own, and selects the filter's text after a tick, so the next name replaces it.
- **`ns `** opens with `All namespaces` as an action row, described `current` while the scope is all and `new namespaces join` otherwise, then under Selected the space's namespaces, ticked, then the others as the cluster lists them, the order fixed for the opening, so a tick moves no row.
  Once text is typed the namespaces that match come ranked by their score, ticked or not and under no heading, and `All namespaces` goes after them when the text matches it too, so the cursor, which goes to the first row, lands on the best namespace.
  Enter or a click on `All namespaces` empties the scope whatever is ticked, and applying with nothing ticked empties it too.
  A person who may not list namespaces sees the space's namespaces ticked and the typed text as a row when it is a namespace's name, which Space adds and an untick removes.
  The picker asks `namespaces_list` once for each opening, and a scope is written sorted and with no name twice, here, by `:` and in a list's URI, so one set of namespaces is one list URI.
- **`:` takes several namespaces**: a namespace word splits on commas, each name must be a namespace's (an RFC 1123 label), `all` stands alone, and a word that is no list of namespaces gives no row; the row says `in payments, auth`.

### 4.6 Logs, terminal and editors

- **Logs.**
  A virtualized line list with ANSI parsing, not xterm.
  - A logs tab is a session in `twigo-sessions` over a pod, or over the pods a workload controls by their controller reference: a Deployment's through its ReplicaSets, a CronJob's through its Jobs, a ReplicaSet's, StatefulSet's, DaemonSet's or Job's directly.
    The hub follows them as Object upstreams, so their containers' states come with them; other kinds are refused.
    Each chosen container is a stream, ten at most per tab, every stream stopped among them until its task has ended, so one workload cannot take the cluster's 32 followed logs (3.2); the others wait as `OverLimit`, even one that waits only for such a stream to end, since `Queued` says that the cluster's followed logs are taken.
    A stream stops when its pod leaves, when the source changes, or when the source no longer chooses its container or it gives its place up; its task ends after its read, as a left pod's does, or once its abort has run, which an abort only schedules ([`JoinHandle::abort`](https://github.com/tokio-rs/tokio/blob/tokio-1.54.1/tokio/src/task/mod.rs#L146-L150)), and a stream that takes its place starts on the tick after.
    Containers with an instance to read come first, then the newest pods, and a stream with nothing to read, one that waits to start or has no previous instance to read, gives its place up to one that can be read, no more of them than the places the stopped streams will free leave short; one without a previous instance says so as its error.
    Pods that come after the first listing add a `Joined` entry with their controller, and those that go a `Left` entry.
    A pod that leaves lets its streams finish the reads under way, five seconds at most, so a container's `Ended` still comes: the kubelet ends a follow up to a second after the container exits ([`waitLogs`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/cri-client/pkg/logs/logs.go#L461-L489)), and its status manager deletes a finished pod right after it patches its status ([`syncPod`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/status/status_manager.go#L1276-L1310)).
    One that still reads at that bound is aborted, and keeps its place among the ten until its task has ended, as every stopped stream does.
    They make no new read, not even after a cut: the API server looks the pod up by its name before it asks the kubelet ([`LogLocation`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/core/pod/strategy.go#L631-L640)), so a new read would find none once the pod is deleted, or another made again under the name, and a pod the target no longer controls is not the tab's.
    A stream that read its instance's log, to its end or to a cut or a broken body, then still gives that instance's `Ended` after the lines read, from the status it has, once that says the instance ended, though a reread failed meanwhile; one whose reads all failed, as one queued until the pod was gone, gives none.
    Its `Left` entry waits for them and stands just after the last of the pod's entries that the buffer holds, or at the leave while it holds none, though not before its `Joined`.
    A `Joined` stands just before the pod's first entry, or at its creation while it has none, and moves there under its id once one comes: the first line comes seconds after the creation while the containers start, or before it from a node whose clock runs behind the API server's.
    While the pod is in view and has none, the buffer's bound keeps the `Joined`, first among the entries it counts, as through a long image pull in a busy tab or for an orphan that a controller adopts long after its creation ([`ClaimObject`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/controller/controller_ref_manager.go#L101-L125)), and it moves to the first entry before the bound makes room for that.
    The bound drops a `Joined` only along with its pod's entries at its time, the pod's first among them, and a `Left`, which stands after the pod's last, only after that one.
    So the two bound the pod's entries that the buffer holds whatever the clocks say, and a pod made again under the name of one that left, as a StatefulSet makes one, joins after that one's `Left` when it writes only after that one's last line.
    Their lines overlap when a grace period of 0, the request's or else the spec's ([`CheckGracefulDelete`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/core/pod/strategy.go#L175-L206)), deletes the old pod at once and frees the name ([store.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/registry/generic/registry/store.go#L1178-L1188)), while the kubelet still gives its containers a second at least ([`calculateEffectiveGracePeriod`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/pod_workers.go#L1009-L1040)) and may start the new pod meanwhile ([`allowPodStart`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/pod_workers.go#L1046-L1051)); then each pair still bounds its own pod's lines, and the marks interleave.
  - The backing store is a buffer in Rust that merges every stream's entries in time order, ties by arrival, each with an id it keeps while buffered.
    It keeps the last 50,000 entries and 16 MiB of their text, as the owner decided on 2026-11-03, and once it has dropped any, one `Dropped` entry comes first.
    50,000 lines of ten streams with 139 bytes of text on average take 12.5 MiB, 261 bytes a line, and lines of 700 bytes reach the bound of their text at 23,945 lines in 18.9 MiB (`cargo run --release -p twigo-sessions --example logs_memory`, and with `561`, on an Apple M4 Max, 2026-11-03).
  - A line's level comes from what it says, not from its colours: a JSON object's `level`, `lvl`, `severity`, `levelname` or `log.level`, pino's numbers included, and a JSON object's fields alone.
    Otherwise logfmt's `level=` or `lvl=`, else klog's `E1103`, else a level word among the first four words, alone, in brackets or before a colon, after the times, numbers and brackets before it.
    The first other word starts a message, which says no level, as in `No error found`; fatal, critical and panic count as errors.
  - Escapes leave their text; SGR runs come as styles in UTF-16 units, 256 and true colours as the nearest of the sixteen in the VGA palette.
  - The view's filter is the list's (3.4), its search marks its matches and lists the last 10,000 with an exact count, and its histogram counts the lines it keeps, its range aside, in 60 equal spans that reach back from the buffer's last line to its first, the shortest that do: one of those from 1 s to a day that divide a day, else 2, 4, 8 days and on, doubling.
  - Supported: follow, wrap, timestamps, previous container, download, and switching between containers.
  - A stream asks for `timestamps=true` and follows the instance the kubelet reads, the running one or else the one that ended last ([`validateContainerLogStatus`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/kubelet_pods.go#L1547)).
    When the server ends it while the container runs, its body breaks, or its connection is retired or abandoned, it reopens with `sinceTime` at its latest line's second, the precision the API server passes on ([`LogLocation`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/core/pod/strategy.go#L672)), and skips as many lines as it had at or after that second, which the kubelet sends again first, in the log's order; it counts rather than compares times, since containerd stamps stdout and stderr in goroutines of their own.
    A read of the last lines starts where they start ([`ReadLogs`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/cri-client/pkg/logs/logs.go#L303-L314)), which may be inside a second after lines of it the stream never got, and a reread from that second gets those first, so while its latest line is in that second it passes over them up to the first line it got, known by its time and bytes.
    The kubelet reads the instance its own status names, which the API server's may not yet, so a reopened read whose first line is later than every line it had, or whose log ends before them, got a later instance's log; so did a read once the status names another instance, as after a cut that a restart came during.
    Either way the stream reads the rest of the old instance as the kubelet's previous one, up to the later one's first line, then the later one's lines, which may come before the status says the old one ended.
    While the cluster cannot be reached it tries that rest again as long as the status names the old instance, and gives up on the kubelet's 400, that it has no previous instance.
    When the previous instance holds none of what came either, the reopened read got a rotated log, and it reads on as the same instance.
    Once the status says the instance ended, an `Ended` entry with its exit code and its reason follows the instance's last line, later lines that came first notwithstanding, and the stream reads the next instance from its resume, which reaches back before its start, until the restart policy runs the container no more.
    A stream that starts on a stale status takes the later instance's lines for the old one's; when the old one's log, read from their second, ends before it gives the latest of them, which a log holding them never does, the stream shows none of it, reads the later one on from those lines, and the old one's `Ended` stands at its finish.
    A rest it gives up on, or that the kubelet cannot read, says nothing of whose those lines were, so the `Ended` follows them.
    In a crash loop's back-off the entry gets its next start once the status says it: the kubelet publishes the status ([`SyncPod`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/kubelet.go#L2135)) before it caches the back-off's reason ([L2268](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/kubelet.go#L2268)) and syncs the pod again when the back-off ends, at most a minute later ([`completeWork`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/pod_workers.go#L1535-L1547)), so `waiting` showed only 60 ms before the restarts after back-offs of 10, 20 and 40 s, and 69 s after the crash before one of 80 s (a crash loop's pod watched on a kind cluster of `bench/cluster.sh up <name> 1.37`, 2026-11-03).
    The kubelet sends a log's headers before it reads ([`GetKubeletContainerLogs`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/kubelet_pods.go#L1660-L1665)), so a line without a time is the kubelet saying why it cannot read the instance, which the stream shows as its error.
  - A container's findings in Diagnostics say whether it has a previous instance and carry the last line of the one that ended last, read once per restart; in a quick crash loop the status may name as the previous instance one the kubelet has removed, so that line is read with `previous` only while a new instance runs.
  - Designed with the owner on 2026-11-03 ([research](research/workbench-design.md)), for step 10:
    - a logs tab follows an owner, not a pod: `deployment auth-api` merges its pods' lines and picks up the new pods of a rollout, since a tab tied to one pod dies with each rollout (lens#8163); watch the log budget (3.2);
    - one toolbar: the pods and container, a time range, follow, wrap and timestamps, a level filter, a filter that keeps only matching lines, and apart from it a search that steps through matches as `3 of 5`;
    - a volume histogram above the lines, warnings and errors in their tones, where a drag picks the time range;
    - a narrow pod column of each line's generated suffix, levels read from structured fields, and only warning and error lines tinted;
    - a container's end as a separator line with its exit code and when it restarts.
  - In the webview, as the owner chose on 2026-11-03 from a mockup of the viewer:
    - a logs tab lives in the panel (4.1), a `logs://` input; `l` on a row, in the details and in their context menu, Logs in an object editor's row of actions and a finding's buttons open it or focus the open one, so logs live in one place and a pod's editor has no Logs sub-tab;
    - a tab starts from the last 15 minutes; the range offers the last 1,000 lines per container, 5 min, 1 h, 6 h and each container's start, and a drag on the histogram narrows the view until the range's ✕;
    - the pod picker lists the workload's pods with their state, `Queued` and `Not followed` included, all of them with the new ones, or some, and the container: the default, one by name, or all;
    - the filter is the list's syntax; the search marks every match and steps back from the newest, `238 of 238`, on ↑↓ and Enter, a step asked before Rust applied the search waiting for its matches, and a match stepped to stays the current one when newer matches leave it out of the last 10,000, `≤ 2,000 of 12,000`, until a step goes on from the oldest listed or the window asked around it shows that the view no longer keeps its line;
    - the list follows the end until the person scrolls up, then counts what came since the pause, or since a later view Rust applied, on a button that follows again, and keeps its place by the entries' ids as entries enter and leave before it;
      the list writes its scroll itself and its virtualizer only lays out the rows, so a scroll to where the list's placing did not put it is the person's, a wheel's that the list scrolls by included, and after every change of the layout, rows that wrap measured included, the list puts the line it holds back at its offset, or as near as the end lets it, and holds it where it then stands;
      a row that left the loaded lines keeps the size it was measured at, so a new window moves no line below it: every such row while the list is paused, those near the loaded lines while it follows, and no other line keeps one, so the sizes never outnumber the view's lines;
      the list's keys are its own keymap, the same on every platform rather than a copy of one engine's, for which it moves itself, at once, since WebKit stops a key's animated scroll at the list's next write: PageUp, PageDown, Space, ⇧Space, ⌥↑, ⌥↓, ⌃↑, ⌃↓, ⌃⌥↑ and ⌃⌥↓ by a page, its height less two rows, or in a short list 7/8 of it, as Chromium pages, so a page is never less than a browser's nor less than a pixel, ⌘↑ and ⌃Home to the top, ⌘↓ and ⌃End to the end, as WebView2's Chromium scrolls on ⌃Home and ⌃End ([`MapKeyCodeForScroll`](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/input/keyboard_event_manager.cc#L110-L122)), besides ↑, ↓, Home and End, which the list commands send it, and it leaves ⇧ with ⌃ and an arrow to the browser, which scrolls on neither ([`scrollGranularityForKeyboardEvent`](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.2/Source/WebCore/platform/KeyboardScrollingAnimator.cpp#L122-L125), [Chromium](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/input/keyboard_event_manager.cc#L72-L74)); in a real WKWebView, macOS 27.0's, paused at a bound of 6,000 lines with 5 lines every 50 ms, three presses of each with wrap and without landed where the list sends them, ⇧⌃↑ and ⇧⌃↓ moving nothing (`listkeys2.swift`, 2026-11-04);
      a wheel up pauses at once, a scroll down while following does not, though lines came before it got to the end, and the person's scroll down to the end follows again, a wheel's or a key's at once;
      the list moves itself for the person's wheel too, as xterm.js ([`Viewport.handleWheel`](https://github.com/xtermjs/xterm.js/blob/5.5.0/src/browser/Viewport.ts#L238-L279)) and VS Code ([`ScrollableElement`](https://github.com/microsoft/vscode/blob/1.95.0/src/vs/base/browser/ui/scrollbar/scrollableElement.ts#L385-L488)) do, since WebKit drops a wheel's own scroll that comes as the list writes its scroll, as paused at the buffer's bound it does every batch to hold its line: by the wheel's `deltaX` and `deltaY`, in pixels, a row a line or a page a page, carrying to the next wheel what the browser's whole pixels drop, while the list can scroll that way; at an edge it leaves the wheel to the browser, as xterm.js does; on macOS, where WKWebView scrolls a wheel with ⌃, or with ⇧ and no `deltaX`, along its own axis (a ⌃ notch of three lines, a synthetic scroll event sent through `WKWebView.scrollWheel` on macOS 27.0, moved a plain scroller 120 px, 2026-11-04), the list takes those as any other, and elsewhere it leaves a ⌃ wheel to the engine, which on Windows may zoom ([`GetPlatformSpecificDefaultEventAction`](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/common/input/web_mouse_wheel_event.cc#L119-L129)), and turns a ⇧ wheel without `deltaX` sideways, as VS Code does off macOS ([`shiftConvert`](https://github.com/microsoft/vscode/blob/1.95.0/src/vs/base/browser/ui/scrollbar/scrollableElement.ts#L425-L431)), where AppKit and WebKitGTK ([`shouldInvertDirectionForScrollEvent`](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.2/Source/WebKit/UIProcess/API/gtk/WebKitWebViewBase.cpp#L1441-L1453)) send a mouse's as `deltaX` already; a mouse's notch scrolls at once, not animated, as WKWebView scrolls it natively in one step;
      in a real WKWebView, macOS 27.0's, paused at a bound of 6,000 lines with 5 lines every 50 ms, synthetic scroll events sent through `WKWebView.scrollWheel` to the list on a Vite page that feeds it as Rust does (`wheel2.swift`, 2026-11-04) moved the list by their whole delta: notches of 300 px down and up, with wrap and without, of 150 px sideways and of 7 lines, and trackpad-like gestures of ten events with phases and momentum, one wheel up with wrap landing 19 px off, a row measured under it, and so did notches without the bound and without lines coming; a delta below a pixel, which a synthetic event cannot carry, a physical mouse and trackpad, WebKitGTK and WebView2 were not measured;
      a window asked around a line says where that line stands, so an earlier window is not taken for the answer, and a paused list keeps its place across a new view and a remount, a line the view hides where its time puts it;
      a step reveals its line once, a remount included, and a reveal that comes while the list follows is no step's and moves nothing;
    - a line shows its text as the container wrote it, ANSI colours as tokens at 4.5:1 or more on the editor, warnings and errors tinted in their tone with a 2 px edge in it; markers say that a container ended, with its code and next start, that a pod joined from its ReplicaSet or left, and what the buffer dropped;
    - a line is the monospace at 13 / 20 (4.9): its source in support, or the brand for a pod that joined after the tab first listed its pods, as a rollout's new ones; its time quiet, the part that changed from the line above in support, in tabular figures; its message in content, and in support where it starts with whitespace, as a stack trace's continuation does; a wrapped line hangs under the start of its message;
    - F, W and T toggle follow, wrap and timestamps while the lines have the focus, ⌘F finds and `/` filters; below 1,100 px the toolbar drops the level counts, narrows its fields and shortens the range's label, and below 800 px, a split panel's group, the filter and the search go to a row of their own under it, which opens once their icons, `/` or ⌘F ask for a field, and while either is set, so a split panel keeps every control.
- **Exec and attach.**
  xterm.js 6.1.0-beta.337 with the WebGL addon 0.20.0-beta.330, the fit addon and Unicode 11: VS Code 1.145.2 locks 6.1.0-beta.304, whose `flushSync`, which every resize runs, parsed again the chunks its write queue had parsed and kept, repeating output and acks, until [#6201](https://github.com/xtermjs/xterm.js/pull/6201).
  No release has followed 6.0.0 (2025-12-22), which rebuilds a hidden terminal's rows on every scroll: 12,642 DOM mutations in 5 s of `yes` behind another tab, against 0 on 6.1.0-beta.337 (Chromium on the mock, 2026-11-09).
  It falls back to the DOM renderer on context loss, which happens on WebKitGTK.
  WebGL is disposed on hidden tabs.
  A shell or an attach is a plan of the command bus (5.1, 6.4): its run parks a session in `twigo-core` and connects nothing, and `shell_open` starts it with the terminal's size, so the first prompt is laid out right; a session is only reached through a plan that ran.
  kube-rs `AttachedProcess` (version 4.0 or later fixes the task leak and the join deadlock) carries it, one WebSocket per session on the sessions client (3.2).
  - **The shell** is one exec of `sh -c 'export TERM=xterm-256color; command -v bash >/dev/null && exec bash || exec sh'`, as k9s runs it ([`exec.go`](https://github.com/derailed/k9s/blob/v0.51.0/internal/view/exec.go#L37-L38)).
    A second exec after a failure would log a runtime error on every shell into an Alpine image, and could read a person's `exit 1` as a shell that failed.
    `TERM` has to be set: a tty exec leaves it unset, so `sh -c 'echo $TERM'` prints nothing on busybox and bash reports `dumb`, which breaks full-screen programs (kind 1.37, containerd, 2026-11-09).
  - **Attach** takes `tty` and `stdin` from the container's spec and `stderr` when there is no tty, with no wrapper; a container whose spec keeps no stdin attaches read-only.
    The run tells the tab both.
    A process with no terminal writes bare line feeds, which the tab draws with carriage returns, as a terminal's line discipline would add them.
    Once an attach runs, its tab says in the scrollback what it shows: what the process writes from then on, while what it wrote before is in its logs.
    It also says whether what is typed reaches the process; one that keeps no stdin takes no input and hides its cursor.
  - **Flow control** is in bytes, counted by what the terminal has parsed (`shell_ack`, clamped to what was sent).
    A frame is at most 64 KiB, as `twigo-sessions` names its constants; output goes out at once when the last frame left 16 ms ago or more, so an echo after a quiet moment never waits, and otherwise gathers until 16 ms after the last frame, about a display frame, or 64 KiB, since the webview pays per frame, each one a Tauri `eval`; at 256 KiB unacknowledged it stops reading, until it falls below 64 KiB.
    Stopping the reader blocks kube's message loop, stdin and resizes included, until acks come; input and resizes therefore queue apart from the reader, and a Ctrl-C during `yes` reaches the process as the terminal catches up.
  - **How a session ends** is `Exited { code }`, `Signaled { signal }`, `Detached`, `NoShell`, `Failed`, `ConnectionLost` or `Relocked`, and none can resume, since an exec cannot.
    `Signaled` is a terminal's shell that a signal ended (4.6), named as `kill -l` names it: `KILL`.
    `ended` comes last, after all the output of a process that ended; a session cut short by `Relocked`, or by a wake, a moved route of a live api connection (3.2) or replaced clients, sends only the output it had gathered, not what its pipe still held.
    The status decides.
    `Success` is exit 0 for a shell and `Detached` for an attach: the kubelet's [`ServeAttach`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/cri-streaming/pkg/streaming/remotecommand/attach.go#L46-L55) writes `Success` whenever the attach itself did not error, with no exit code.
    `NonZeroExitCode` is its code, unless a shell printed nothing and the code is 126 or 127, which is `NoShell`, as CRI-O would report a missing binary (by reading its source, not measured).
    containerd fails the exec itself: the upgrade succeeds, nothing prints, and the status is `InternalError` whose message says `executable file not found` (kind 1.37, kube 5.0.0, 2026-11-09), which is `NoShell` for a shell and `Failed` for an attach.
    A message is a missing shell when it holds both `executable file` and `not found`, which covers runc's words and crun's ([`container.c`](https://github.com/containers/crun/blob/1.20/src/libcrun/container.c#L1263) in 1.20); a bare `no such file or directory` is not, since a failure of the API server's own leg to a node says it too.
    Another `Failure` without an exit code, once the session has printed, is `ConnectionLost`: the API server's translator writes `InternalError` for any stream failure that is not an exit ([`streamtranslator.go`](https://github.com/kubernetes/kubernetes/blob/v1.35.0/staging/src/k8s.io/apiserver/pkg/util/proxy/streamtranslator.go#L120-L134)), as a kubelet restart is.
    A socket that closes without a status is `ConnectionLost` too, as is a wake from sleep or a moved route of a live api connection (3.2) while it connects or runs, and clients abandoned while it waits, connects or runs; none is read as a shell that failed.
    A network change that moves no route of a live api connection, or finds none, tells the session nothing (3.2): it ends when its socket fails, with no status, as `ConnectionLost`.
    A session ends on those and on no other retirement: its socket is on the sessions client, whose connections are not tracked, so a new certificate or a failed probe, which retire the api client's connections (3.2, 6.2), say nothing of it; `Connections::network` counts only the wakes and the moved routes of live api connections.
    A pod deleted under a session ended it as exit 137 (`shell_live` on kind 1.37 with containerd, 2026-11-09).
    A context that turns read-only, by a relock or an unlock running out, ends its shells as `Relocked`, those parked or queued as well as those connecting or running; `guarded` does not.
  - **A tab and its terminal.**
    A shell is a `exec://` editor of the panel, opened by `s` on a pod, by Shell in the row of actions of its details and of an object editor's header and in its context menu, and by Attach, which joins the container's main process.
    While the details or an object editor hold a pod's Overview, whichever view is shown, and it lists containers of which none runs, by each container's `running` (4.3), they set `resource.noContainerRuns`, and Shell and Attach there are disabled, saying `No container runs`; in the list, by its keys and in a palette opened outside them nothing knows, and `shell_containers` decides.
    `s` asks which container when several run, the default first, then plans `action: "shell"` through the command bus, which draws its friction (6.4); only a run that answers with a session opens the tab, so a cancel or a refusal opens nothing.
    The terminal and its element belong to a service keyed by the tab's URI, not to the view, which moves the element in when it mounts: moving a tab between groups or hiding the panel loses nothing, and the session goes on writing to the terminal meanwhile.
    The first size goes in `shell_open`, once the terminal is mounted and fitted, and `shell_resize` follows a layout change that has held still for 100 ms, when cols or rows changed.
    A tab restored after a restart has no session: it says its shell ended when Twigo closed and offers Start, and never runs anything on its own.
    A new session in a tab, Restart's or Start's, keeps the scrollback and resets the modes the old program left: the mouse, bracketed paste, focus reporting, the cursor and keypad keys, and wrapping, insert and origin.
    It starts on a line of its own when the cursor is not at the start of one, as when Restart replaces a session that still runs, since zsh marks a prompt that does not start a line with an inverse `%`.
    What a start and an ending decide from the screen, they decide in one queue, each step once the output so far and what the step before wrote are parsed: a start that comes straight after an ending reads the screen the ending left, and writes its leave of the alternate screen, its reset and its line feed after the ending's words, not among them.
    A step waits for a write of an empty array, not of an empty string: a resize flushes xterm's write queue at once, and the flush takes an empty string for the end of the queue and drops it with its callback and the writes behind it, so every later step would wait for ever.
    A start leaves the alternate screen first and only then resets, since a leave restores the colours that were set before the screen was entered and would undo a reset parsed on it; the session opens last, once the line feed is parsed, so none of its output comes before.
    A terminal that is mounted and fitted for the first time while a start waits leaves the opening to that queue, not to its first fit, as a shell may answer within `shell_open`.
    An ending turns the mouse, bracketed paste and focus reporting off as well, since xterm parses the new session's reset after the task that restarts, and a terminal focused in that task would report the focus to the new shell.
  - **Output.**
    Rust sends the bytes of the process's output and its events over one channel, in order.
    The bytes are written to xterm as `Uint8Array`, which is stream-aware across frames, and Rust is told how many the terminal has parsed from the callback of `write`, so flow control follows what xterm has really parsed: a frame of 64 KiB at most, nothing more read at 256 KiB unacknowledged, reading again below 64 KiB.
    A terminal keeps 5000 lines.
    What is typed goes one `shell_input` at a time, and what is typed while a call is in flight goes in the next, so keystrokes keep their order whatever the transport does.
    What is typed while the shell connects goes to Rust's queue and reaches the process once it runs, as a terminal keeps type-ahead.
    Rust's queue takes whatever it is sent from the session's start, 32 chunks at most with the call waiting while it is full, and checks no state, so what is typed in the round trip before `queued` reaches the webview is kept too, and reaches the process however long the place takes.
    Once the webview has heard `queued`, what is typed is dropped, since the wait can last minutes (read in `Session::input` and `run` of `crates/twigo-sessions/src/shell.rs`, not run against a full cluster).
  - **WebGL.**
    A terminal loads the addon while its tab is on screen, and gives it up in a task after the tab was hidden, behind another tab, under a maximized panel or in a hidden panel, so a tab hidden and shown again in one task keeps its context.
    WebKit keeps 16 live WebGL contexts per page: of 24 terminals, the first 8 lost theirs (a real WKWebView, macOS 27.2, 2026-11-09), and Monaco or anything else that draws with WebGL shares the limit.
    A failed load and a lost context leave that terminal on the DOM renderer.
    With an opaque background, 6.1.0-beta.304 draws colours, box drawing, Cyrillic, CJK and emoji in a real WKWebView after 5,000 lines, on WebGL and on the DOM renderer (macOS 27.2, kind 1.37, 2026-11-10), so [#5816](https://github.com/xtermjs/xterm.js/issues/5816) did not reproduce there.
    WebGL draws an emoji with a skin tone, or a flag, a cell per code point, which the DOM renderer joins.
    Its pattern glyphs, such as ░, throw on an `oklch` colour and leave the rows below undrawn, on 6.0.0 too, so the theme goes to xterm in sRGB hex.
  - **Keys, paste and links.**
    The terminal keeps every key except those the workbench takes, which `attachCustomKeyEventHandler` leaves to it, as VS Code does; single-letter list keys never fire in a terminal, since `listFocus` does not hold there.
    The workbench takes the next key of a chord that waits, on every platform.
    On macOS it takes a ⌘ chord that is a binding or starts one.
    On Linux and Windows `mod` is Ctrl, which a shell needs, so only quick access, the command palette, the toggle of the panel and the three zoom commands win over the shell, a short list as VS Code's `commandsToSkipShell` is, which holds its zoom commands too ([terminal.ts at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/contrib/terminal/common/terminal.ts#L652-L654)), and every other Ctrl chord stays with it.
    New Terminal and Toggle Terminal join that list on every platform, since their keys, ⌃⇧\` and ⌃\`, are Ctrl chords on macOS too.
    Copy and paste ride on the `copy` and `paste` events, which xterm answers with the selection and with `Terminal.paste`, so bracketed paste works; the Edit menu keeps its Copy and Paste for them.
    A `linkHandler` makes OSC 8 links do nothing unless ⌘-clicked, and opens only what the app's opener takes, `https` and `http` on localhost; xterm's `confirm` and `window.open` never run, and no addon detects URLs.
  - **Endings.**
    A session's ending has its words, which stand once in the scrollback, in a quiet colour, with its state and Restart at the right of the tab strip: `Session ended.`, `Session ended with exit code N.`, `Session ended by SIGKILL.` (`SIG` and the signal's name), `The attach ended.`, `This container has no shell.` with the runtime's message, the error's own message, `The connection was lost. A shell cannot be resumed.`, and `The context became read-only.`.
    A finished tab stays with its scrollback readable and selectable and its input off, until it is closed or restarted; Restart plans a new shell, so `guarded` asks again.
    A session that waits for a place among the cluster's 64 says so in its tab, and while the panel shows, the status bar lists open shells while there are any, to go to one or close it; while it is hidden, one entry counts every session instead (4.1).
  - The theme is the editor's surface and the logs' sixteen colours from the tokens, and follows the document's theme live.
  - The font is `--font-mono`, the bundled JetBrains Mono (4.9), at 12 px, and a terminal opens only once its regular and bold faces have loaded or failed: xterm measures its cell when it opens ([CoreBrowserTerminal.ts](https://github.com/xtermjs/xterm.js/blob/f70764dd3da05ebda0390605c6f9adbbea3f0e90/src/browser/CoreBrowserTerminal.ts#L648-L649), at the commit 6.1.0-beta.337 is built from), when `fontFamily` or `fontSize` change ([CharSizeService.ts](https://github.com/xtermjs/xterm.js/blob/f70764dd3da05ebda0390605c6f9adbbea3f0e90/src/browser/services/CharSizeService.ts#L34)) or the pixel ratio does ([RenderService.ts](https://github.com/xtermjs/xterm.js/blob/f70764dd3da05ebda0390605c6f9adbbea3f0e90/src/browser/services/RenderService.ts#L289-L293)), and after every resize of its buffer ([the listener](https://github.com/xtermjs/xterm.js/blob/f70764dd3da05ebda0390605c6f9adbbea3f0e90/src/browser/CoreBrowserTerminal.ts#L197), [`_afterResize`](https://github.com/xtermjs/xterm.js/blob/f70764dd3da05ebda0390605c6f9adbbea3f0e90/src/browser/CoreBrowserTerminal.ts#L1078-L1080)), but not when a face loads.
    A face that came later would leave the fallback's cell only until the next resize, and waiting for the faces is what keeps the first screen right.
- **Port-forward manager.**
  A target is a Pod, a Service or a Deployment, ReplicaSet, StatefulSet or DaemonSet, and a forward is one port of one target, named by the target the person chose; the pod it reaches is a detail of it.
  The data path is `twigo_sessions::forward`; the table, the policy and what is kept are `twigo_core::forward`.
  - **The listener.**
    The manager binds `127.0.0.1`, which must bind, and `::1` on the same port where this machine has it, as kubectl's `localhost` does, and keeps both for the life of the forward, whatever happens to pods, so no other process can take the port between check and bind.
    A port that either loopback cannot give is answered as data, in use or not permitted, with the next free port above it, from 1024 up, found by binding on those two addresses.
    A start of a port that has no forward binds only once it has read the target, so against a cluster that does not answer it gives the read's error first.
    A port that another process holds on `0.0.0.0` or `[::]` is in use too.
    `SO_REUSEADDR`, which [mio sets](https://github.com/tokio-rs/mio/blob/v1.2.4/src/net/tcp/listener.rs#L67-L82) and which a port needs to bind again while the connections it served wait out `TIME_WAIT`, makes macOS bind `127.0.0.1:P` beside such a listener and give the new socket that process's loopback clients, where Linux refuses with or without it (bind probes of macOS 27.2 and of Linux 6.12.54 in Docker Desktop, 2026-11-12).
    So Linux binds with the option, Windows without it, as mio does, since there it lets a socket in use be bound over, and macOS binds without it first; when that finds the port in use, the port is busy unless nothing accepts a connection on it, which leaves only the connections of a closed listener that are still open or wait out `TIME_WAIT`, and then binds with the option.
    A forward's listeners close when the forward is dropped or moved, so they are closed when a stop, a move or a shutdown returns.
    A child that Twigo starts at that moment (a credential plugin, a terminal's shell, the login shell) holds a copy of every descriptor until its program starts, so a bind straight after can find the port in use for that moment.
    On macOS a start or a resume that binds that fast gets `Busy` from the path of `bind` in `crates/twigo-sessions/src/forward/listen.rs` that tells a listener from leftovers, for up to about a millisecond ([`TODO.md`](../TODO.md)).
    The local port of a start is the one that port of that target had last, else the same number, else for a port below 1024 that number plus 8000.
    A free port offered in place of a busy one, a detour, is never taken silently.
  - **The pod.**
    - A Pod target is that pod by name while it exists and is `Running`, as kubectl wants ([`portforward.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/kubectl/pkg/cmd/portforward/portforward.go#L427-L428)); a pod made again under the name is the same target.
      One that does not run yet, or has finished, is no candidate, so a connection waits for it, 20 s at most, as behind a Service.
    - A Service's pods come from the EndpointSlices that carry its name: endpoints whose `serving` is not false and `terminating` not true, with a `targetRef` of kind Pod, one per pod uid whatever address families it has.
      The pod's port is the entry of the same slice that carries the Service port's name, so a named `targetPort` that pods resolve differently needs no pod spec.
      A Service with no such endpoint says why: it is an ExternalName, its endpoints are not pods, or no pod is ready.
    - A workload's pods are those it controls by controller reference, as the logs find them, a Deployment's through its ReplicaSets; they count when they are Ready by their conditions and not being deleted, and a workload's port that has a name is each pod's container port of that name.
    - The pod is sticky.
      Connections go to the forward's current pod while it is a candidate, so a client's connections do not spread over the replicas; another is picked when it leaves or a connection to it fails, and a pod that failed is avoided for a backoff unless it is the only one: 0.5 s at first, doubling to 30 s, each with a jitter of up to the delay again, so 0.5–1 s at first and 30–60 s at its longest ([`ExponentialBackoff::next`](https://github.com/Xuanwo/backon/blob/e24dc92742e201f7320868d46a12ff59eb82ef72/backon/src/backoff/exponential.rs#L210-L235), backon 1.6.0).
      A pod whose upgrade answered `404` is avoided for 30 s, the backoff's longest delay before its jitter, the only one too, and a failure meanwhile does not shorten that: a kubelet answers `404` for a pod that its pod manager does not hold, as around its restart ([`getPortForward`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/kubelet/server/server.go#L1251-L1255), [`GetPodByName`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/kubelet/kubelet_getters.go#L273-L275)), and kube-client 5.0.0 turns a `404` that a proxy answers in its own words into the same error ([`handle_api_errors`](https://github.com/kube-rs/kube/blob/5.0.0/kube-client/src/client/mod.rs#L579-L605)).
      A choice then takes another pod when there is one.
      When there is none, a person's proof fails at the end of its 20 s, before the pod is back, the space's and a sign-in's say `Reconnecting` at once, and a connection waits within its own 20 s, so only one whose wait reaches the avoidance's end goes to the pod: nothing tries it again and again.
      A person's start or resume forgets what was avoided, a pod that carries a connection is no longer avoided, and what was avoided of a pod goes once it is no candidate; each wakes the connections that wait for a pod, and a wait that ends chooses once more before it gives up.
      Connections already open keep their pod.
      The status names the pod and its port that the last choice took, and none while the pods listed leave no candidate to take; a cluster that does not answer leaves them as they were.
  - **A connection.**
    Each accepted TCP connection holds a place among the context's sessions (3.2) for its life, waiting in `queued` when the budget is full, then goes to the current pod, waiting 20 s at most for one to be a candidate.
    A pod behind a Service or a workload whose upgrade answers `404` has been sent nothing of the client's, so the connection chooses again while its 20 s last, and gives up when no pod is left by then.
    Once the 20 s have passed, a `404` ends the connection with that `404`'s words: a connection's preparing is bounded by its 20 s and one connect.
    It is its own kube-rs WebSocket on the sessions client, opened under a timeout of its own, since that stack has none.
    The text the pod's side gives on the error channel is the connection's failure, and a refused port closes that connection alone.
    - On the client's FIN the connection does not shut the stream down: kube-rs answers that by dropping what the pod still sends and closing the socket.
      It keeps copying from the pod and ends once the pod has sent nothing for 1 s, counted from what was last written to the client and never while the pod has something to read, the second containerd gives kubectl's clients ([`sandbox_portforward_linux.go`](https://github.com/containerd/containerd/blob/v2.3.4/internal/cri/server/sandbox_portforward_linux.go#L83-L126)); never ending would leak a session for each keep-alive connection a browser closes.
      A server that answers only after end of input gets no answer through a forward, as through kubectl on containerd, where a half-close reaches the runtime through kubectl 1.34.1's tunnel and stops there, the answer lost after 1 s (kind 1.37, containerd 2.3.4, 2026-11-11).
    - A connection that waits for a place or a pod ends when its client leaves without having sent anything; what the client sends while it waits goes to the pod once the stream is open.
    - When the pod gives its error on the error channel, the connection ends once what the pod sent before it is written.
    - It ends when the forward stops or fails, when the context's mode refuses forwards, when its clients are abandoned, and on a wake or a moved route, as a shell does.
    - A session's permit is held by the connection's task, not by the upgraded stream.
  - **States.**
    A proof finds a pod and opens a first stream to its port, which proves the credentials, the rights, the upgrade and, by the pod's silence for 250 ms, that something listens: the window starts when the upgrade returns, and a port that nothing listens on answered on the error channel within 1.51 ms of that (60 tries in 3 runs of `cargo test -p twigo-sessions --lib forward::live -- --ignored --nocapture` at a load average of 73.8 to 75.0, kind 1.37, containerd 2.3.4, 2026-11-12; the connect itself took 5.5 to 12.3 ms).
    No access review comes first, since from 1.35 the upgrade needs `get` and `create` on `pods/portforward` and before that `get` (6.3).
    What a proof may do depends on who asked for it.
    - A person asks only by a start or a resume of a forward that does not run or that failed.
      That proof says `Starting`, holds the forward's subscriptions with no connection, and ends `Ready` or `Failed` within 15 s for a place among the sessions and 20 s for a pod or for the hub to list anything; any failure fails the forward, one that may pass too, but a first stream lost to clients replaced or to a network that moved, which it tries again after a pause.
    - Every other proof is the system's: the first connection of a forward that waits, the space connecting, a sign-in, a connection to a forward whose target was gone, and the tries of a forward that cannot reach a pod while it has connections.
      It never says `Starting` and keeps the forward's words until it ends.
      What may pass makes the forward `Reconnecting` with the reason: no ready pod, a cluster that does not answer, a refused port, a `403`, which an API server answers for a while after it restarts (3.2), on a list, a watch and the upgrade alike, and any other error of the upgrade, the hub or the clients.
      It fails the forward only for the gate's refusal, a context that no source lists, a credential failure, or a target that is gone; a forward that rests costs nothing while it says why.
    - A credential failure is the hub's `unauthorized`, a `401` on the upgrade, a credential plugin that failed, or one not trusted yet.
      It fails the forward until the context's clients are built anew, which is its space connecting, or until a sign-in that the person starts gets a credential (below), and either proves it as the space proves a forward that waits: trying again at each connection would run the plugin again and again.
      A plugin that timed out is the one difference between the paths: the hub stops on it as on any plugin that failed, since it would run it again by itself (3.2), while on the upgrade it is a `Timeout`, as the error mapping that every command shares has it, which passes, and the plugin runs again only at a later connection, which a client makes.
    - Behind a Service or a workload a `404` on the upgrade says that one pod cannot be reached now: it is avoided, as above, and connections to the others stay.
      A connection's `404` is the forward's only when no other pod is left: with another, the forward stays as it is, its `pod` names where that connection and the next go, and only its `failure` says what happened.
      `Ready` once a proof worked, and, while the forward watches, only if a pod can still be reached when it does.
      A connection's first bytes from its pod prove a forward that is neither `Ready` nor `Failed`, whether a proof is under way or not, and bytes during a probe prove it too.
      A cluster that does not answer is said so: `the cluster does not answer` once the hub is stale and `the cluster has not answered yet` while it connects, in the forward's reason and in the failure of a connection that waited 20 s for a pod.
      A hub that has no stream slot to give is said so too, `waiting for a stream slot of this context`, in the same places; its subscription is queued for a watch while all the context's watches are taken and for a paged list while all its requests are, and either is a slot.
      A failed forward ends its connections, keeps listening and closes what it accepts at once, but for one whose target is gone, until a start or a resume, a lifted refusal, or, after a credential failure, its space connecting or a sign-in.
      A connection that ended before or as the forward failed changes neither its state nor its reason with what it reports later, and its `failure` follows its own rule.
      One whose target is gone looks at it again at its next connection, a system's proof, so a pod made again under its name goes on, and one that is still Pending or refuses makes it `Reconnecting` with the reason.
      Gone is what the target's own subscription says once it has listed, whatever the subscriptions of its pods, ReplicaSets or EndpointSlices say, whose refusals count only once it has found the target, or a `404` on the upgrade to the pod that is the target.
      No other error says that the target is gone, `NotFound` included, since the hub answers it for a context that no source lists and for a list the server does not have: from the hub it passes, and a context that no source lists fails the forward by the clients' answer and the manager's refusal.
      `Restored` is a forward that listens and has not been proven since a start of the app or since a refusal was lifted; its first connection or its space connecting makes it ask, and nothing else does.
      It stays `Restored` while its first connection's proof is under way and if that connection leaves before the proof ends, and its space connecting meanwhile makes that proof the space's.
      `Stopped` is one that does not listen and is kept.
      A connection that the pod's side refuses sets the forward's `failure` and changes nothing else; one that cannot reach a pod (none within 20 s, an upgrade that failed but for a `404` with another pod left, clients replaced or a network that moved) also makes the forward `Reconnecting` with the reason.
      The `failure` holds until a connection opened after it carries bytes from the pod, or the forward is ready again after not being so, so one refused connection does not show for the whole life of a forward that stays ready.
  - **Watching.**
    A forward is used while it has an open connection, as its status counts them, or a proof that a person, the space's connecting or a sign-in asked for, and it reads its target through the hub only then.
    After any step of the forward (a command, a socket, a report of a connection, a change the hub tells, a probe's end, a timer, the end of a connection), one that nobody uses, before the step or after it, as when the space's proof ends `Reconnecting`, holds no subscription, opens no stream and has no timer armed, in any state and with the state's words kept.
    A proof that outlives the last connection ends without starting another, and the result of a stream it had open still counts.
    So a listening forward that nobody uses costs none of the context's 24 watches.
    A forward that cannot reach a pod tries again with a backoff while it has connections; one that lost its last connection meanwhile keeps saying `Reconnecting` with its reason until a connection comes and proves it again.
    The space connecting and a sign-in are the proofs with no connection that the system asks for, the space's of a forward that waits or that failed for a credential and a sign-in's of one that failed for its credential: within a person's bounds each ends `Ready`, `Reconnecting` with the reason or `Failed` for what does not pass, and the forward then rests.
    The space connects when the core builds the context's clients, not when it hands out the ones it holds.
    So whatever asks the cluster first builds them: the first connection to one forward proves the context's other forwards that wait, and so does a `kubectl` through the policy proxy; a context the catalog lost and got back has its clients built anew.
    The run that the person starts through the context's plugin gives the clients it has a new credential and builds none, so the core waits for that run's outcome and, once it got a credential, has each forward that failed for its credential, of every context that shares the plugin, prove once, after the restore and after the forward's own check.
    Nothing else brings it back: not a run of the plugin that a request started, unattended or once the window had the focus, nor an OIDC refresh, each of which follows the `401` that rejected the credential and would loop; nor a change of the context's kubeconfig entries, the files they name or the proxy variables, which only drops its clients, built anew at the next ask of its cluster, which a failed forward never makes and which is then its space connecting.
  - **Keeping them.**
    A space keeps its forwards and the local port each target's port had last under a key that only Rust writes, as it does the modes, so the webview follows them and cannot overwrite them (4.8).
    Ids are unique in the app and never reused across restarts.
    Whether a forward's local port is a detour is kept with the forward, and a detour is never remembered, not by a stop and a resume either; a port shows the local port of its forward where it has one.
    A local port of 0 is refused.
    The bytes count since the app started, so a stop, a resume and a move keep them.
    A forward that ran listens on its port again at a start and waits, `Restored`; no credential plugin runs at a start.
    A port that another process holds, or that another forward of Twigo holds, makes it `Failed` with that.
    Until the catalog has loaded, which outside the explicit mode waits for the login shell's environment, the restore refuses nothing, since neither the context nor its mode is known (the mode of a context the catalog does not list reads as read-only): a forward restored then is `Restored`, and the check that follows the load refuses it in place if it must.
    Once the catalog has loaded, one that its context's mode refuses as it is restored, or whose context the catalog does not list, begins `Failed` with that and closes whatever it accepts.
    A target that is gone is found once the forward is asked, and fails with `NotFound` and its name.
    Every command that reads or changes the table (a port list, a start, a resume, a stop, a remove) waits until the saved forwards and ports are in it, so a start sees the local port its port last had and the forwards of its space, and what it saves replaces nothing.
    The clients of a context built meanwhile are its space connecting, which its forwards are told once the restore ends.
    A window that follows the forwards does not wait for it, and learns of each forward as it is restored.
    A port of a target has one forward: a start, a resume, a stop and a remove claim it around their bind and their insert, never across a call to the cluster, and another command of that port waits until the one under way has ended, then acts on the forward as it left it.
    A start reads its target before the claim, and only for a port that has no forward, or again once the forward it waited for was removed, so a double click answers with one forward, offers no detour, and neither click waits for the other's read; a start that names another `local` for a port that has a forward moves that forward there.
    The state is written in the order of the table's snapshots.
    The shutdown closes the table: a command after it, or one under way before its last check, answers that Twigo is quitting, and none saves, binds or starts, so what the state says ran stays.
    A command past its last check when the shutdown comes answers as usual and only its save is dropped, so the next launch finds the forward as the state had it before that command: a stop or a remove answered then comes back.
  - **The mode.**
    A forward changes nothing in the cluster, so it does not go through the command bus: the gate decides each connection's upgrade, and the manager asks the policy and the catalog again for each running forward's context, reading both under the table's lock, whenever either changes, when a start, a resume or a move puts a forward in, and when the context's clients are built.
    When the mode comes to refuse forwards (`read-only` with `readOnly.allowPortForward: false`), or the catalog loses the context, its connections end and it is `Failed` with the gate's words or the missing context's, still listening, until that passes.
    A start, a resume or a move that the mode refuses, or whose context no source lists, answers that error and changes nothing: no forward is made and no id is taken, no port is bound, a stopped forward stays stopped and a moved one stays on its port.
    A refusal by the mode leaves one `refused` line in the audit log (6.4), and one by a missing context none.
    It asks once the catalog has loaded, before it reads the target or binds, and again under the table's lock as it puts the forward in, so a refusal that comes while a start reads its target refuses that start too.
    Only a forward that exists and runs is refused in place; the refusal's words are those of its cause now, a missing context or the mode, as that changes.
    Once the refusal passes the forward waits, `Restored`, whatever it was before, and asks nothing by itself, also in a space that is connected.
    The manager decides nothing on the status, which lags its controls: it sends the data path a refusal, its lifting, the space's connecting, a sign-in and a person's start in order, and the data path acts on each by what the forward is when it arrives, so a start proves only a forward that failed, the space's connecting only one that waits or that failed for a credential, and a sign-in only one that failed for its credential.
    A command answers with the forward once the data path has handled what it sent, which the manager waits for outside the table's lock: a resume or a move of a failed forward answers `Starting`.
    A move hands a running forward its new port and closes the old one; its state, its connections and any proof under way stay.
  - **No SPDY tunnel.**
    Each TCP connection is its own WebSocket, and counts against the session budget.
    A browser takes about six of the 64 sessions per forwarded port: Chrome 157.0.8103.39, headless, loaded a page of 100 images, each answered after 2 s, in 37 s over 12 connections through a kube-rs forwarder on kind 1.37 (2026-11-11), five to six at a time.
    The SPDY-over-WebSocket tunnel that kubectl has used since 1.31 would multiplex them, but a half-close does not survive containerd through it either, so the tunnel is not built.
  - Later: defaults from annotations (k9s `k9scli.io/port-forwards`), and a `kubectl port-forward` fallback, run through the policy proxy, for proxies that refuse WebSocket upgrades.
- **Integrated terminal.**
  A local pty with the login-shell environment, in a tab of the panel run over the shell commands: `terminal_create` parks it for the space's context, and `shell_open` starts it with the terminal's size.
  - The terminal is pinned to the space's context without touching the user's kubeconfig: zsh, bash, fish and pwsh run their startup files first and set its `KUBECONFIG` after them, which what runs later can still undo (6.4); in any other shell a startup file that sets `KUBECONFIG` replaces it, and that terminal's tab warns of it.
  - Its kind is decided when it is created, once the login shell's environment is known, which at startup can take seconds, and the tab shows it; a later change of mode changes nothing in a running terminal, whose proxy follows the mode by itself.
  - **Terminals of `read-write` contexts from the user's kubeconfig** use the user's real credentials.
    `KUBECONFIG` is Twigo's file of the context, then the catalog's kubeconfig files in their order.
    Twigo's file is a whole kubeconfig, `apiVersion`, `kind`, `clusters: []`, `users: []`, a copy of the context's own entry and `current-context`, in `terminals/<n>/` under the app-data directory (0700, the file 0600), deleted with the terminal's tab, not when its shell ends, as a job the shell left would take the person's current context without it, and, should the app end first, at the next start.
    kubectl writes a changed entry back to the first file that names it ([`ModifyConfig`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/clientcmd/config.go#L235-L258)), so `config set-context --current --namespace` writes Twigo's copy and `config use-context` the current context of Twigo's file, and the user's files stay as they were.
    The empty lists keep `az`, which refuses a file without them, and `gcloud`, which moves one aside, working.
    Such a terminal reaches every context with real credentials, read-only ones included, as any terminal app would, and it keeps running when its context stops being `read-write`: ending it would protect little and lose local work, so its tab warns that it holds real credentials and offers a restart through the proxy.
  - **Terminals of every other context**, including one temporarily unlocked and one nobody marked, get only a generated policy-proxy kubeconfig (6.4), a process of the terminal's actor, label and window that ends when its shell does, so a job the shell left, its file and its tokens gone, reaches nothing.
    In a shell other than zsh, bash, fish and pwsh a startup file that sets `KUBECONFIG` replaces that file, and in those four what runs after their startup files still can (6.4).
    So do terminals of contexts that come from a provider, whatever their mode, because those have no kubeconfig entry to point at; no source lists such contexts yet.
    It holds one proxy entry per catalog context, each with its own token and that context's mode, and none of the user's files.
    Its own entries reach nothing but the proxy, so `--context`, k9s `:ctx` or `config use-context` to any of them cannot reach real credentials by accident; entries a tool writes into it can (6.4).
    The proxy follows the current mode, so a relock applies to terminals that are already open.
    A write from a `guarded` terminal raises a Twigo approval.
  - `terminal.usePolicyProxy` in the person's settings will turn the proxy on for `read-write` contexts too, once the settings files come (M3).
    The policy file's `terminal.usePolicyProxy` forces it on for the contexts its globs match (4.8), and settings cannot turn that off.
  - **The tab and its commands.**
    A terminal is a `terminal://<space>/<n>` editor of the panel, titled `Terminal <n>`, with `n` the first number no tab of the space has.
    New Terminal (⌃⇧\`) asks the core to create one for the space's context, and the tab opens its session as a shell tab does, with the terminal's size.
    A tab restored after a restart has no terminal: it says so and offers Restart, which creates a new one at the same URI, whose kind the core decides again.
    The kind is a chip at the right of the panel's tab strip, beside the state of the active terminal: `Proxy · <mode>`, with the mode the context has now, or `Your credentials`, and its tooltip says what the person gets and why, then each warning the chip has.
    A terminal with real credentials whose context has stopped being `read-write` turns the chip to the warning's tone, `Your credentials · guarded context`, and its tooltip says so; the tab then offers Restart, which starts it through the proxy.
    A proxy terminal whose file a tool wrote its own entries into says so in the same tone, `Proxy · guarded, prod-eu direct` or `Proxy · guarded, 2 contexts direct`: the window follows the core's `direct` event, keyed by the terminal's session, so a restarted terminal starts clean, and the tooltip says that those contexts reach their clusters with the person's credentials, not through the proxy, and that a `use-context` back to a proxy context goes through it again.
    A name of more than 24 characters is cut in the middle in the chip, at one of its own `:` and `/` where one is near enough, `Proxy · guarded, arn:aws:eks:…/prod-eu-2 direct`, and the tooltip holds it whole.
    The chip takes its words' own width and gives way before the tabs: a group's actions shrink first, down to what in them has a minimum width, and only the chip's words have none, so an ellipsis cuts them, down to the chip's icon, the tooltip holding them whole, while the state and the buttons beside it keep theirs.
    A move or a dismiss of an offer leaves them, since the entries stay in the terminal's file.
    A terminal in a shell that Twigo cannot set `KUBECONFIG` in again after its startup files (`kubeconfigKept` false: any but zsh, bash, fish and pwsh) says `KUBECONFIG not kept` in the chip, in the same tone: a startup file of that shell may replace the terminal's `KUBECONFIG`, so a proxy terminal could then reach clusters with the person's credentials, and a terminal with real credentials may no longer be pinned to its context.
    Toggle Terminal (⌃\`) shows the panel with the space's last terminal focused, starts one when the space has none, and hides the panel when a terminal has the focus.
    Go to Terminal… and Close Terminal… are in the palette; a terminal holds no cluster's place, so the status bar's list of open shells names none, and while the panel is hidden the count of sessions includes it (4.1).
  - **The shell** is the login shell from the password database: a login shell on macOS (`-l`, `-Login` for pwsh) and an interactive one on Linux, as VS Code's profiles start them, in `$HOME` of the login environment.
    Its environment is the login shell's (6.1), or the fallback a failure carries, without Twigo's own `TWIGO_*`, with `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Twigo`, `TERM_PROGRAM_VERSION` and `KUBECONFIG`.
  - **`KUBECONFIG` after the startup files.**
    An interactive shell reads its startup files after Twigo set `KUBECONFIG`, so one that exports it would replace the terminal's.
    zsh, bash, fish and pwsh run the person's startup files first, as their own terminal runs them, errors and all, and then set the terminal's again, as VS Code's shell integration runs its own after them ([`getShellIntegrationInjection`](https://github.com/microsoft/vscode/blob/1.145.2/src/vs/platform/terminal/node/terminalEnvironment.ts#L52-L277)); `terminal_create` answers `kubeconfigKept: true` for them.
    That holds once their startup files are done: an `/etc/zshenv` that sets `ZDOTDIR`, a startup file that `exec`s another shell or tmux, a prompt hook (zsh's `precmd`, bash's `PROMPT_COMMAND`, fish's events, direnv) and a `source ~/.zshrc` or `exec zsh` typed later can still set another (6.4).
    The person's zsh files run as their own terminal runs them but for `$0`: Twigo's files source them with `.`, which sets `$0` to the file's path while it runs ([`bin_dot`](https://github.com/zsh-users/zsh/blob/zsh-5.9/Src/builtin.c#L5917-L5921), with `FUNCTION_ARGZERO`, on by default), where zsh reading them itself leaves the shell's name, and VS Code's shell integration sources them the same way ([`shellIntegration-rc.zsh`](https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh#L31)); macOS 27.2's zsh 5.9 printed `/bin/zsh` as `$0` in `.zshenv` and `.zshrc` started plainly and their paths under Twigo's files, and bash 5.3.15 its own name in `.bashrc` under Twigo's (2026-11-11).
    What they read comes from files Twigo writes into the terminal's own `terminals/<n>/`, which every terminal has, deleted with its tab.
    - zsh starts with `ZDOTDIR` pointed at Twigo's files, which source the person's `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin` from their own `ZDOTDIR` or `$HOME` with `ZDOTDIR` theirs again while each runs, following a `.zshenv` that moves it, and set `KUBECONFIG` after each; the last that zsh reads leaves the shell the person's `ZDOTDIR`, set or unset, so history and completion find their files.
      Their `ZDOTDIR` at the start is Twigo's own, as a terminal app hands its shell its own, not the login shell's, which comes from after `~/.zshenv` ran: an `export ZDOTDIR=~/.config/zsh` there would otherwise have Twigo source `~/.config/zsh/.zshenv` and never `~/.zshenv`.
      macOS's `/etc/zshrc` runs while `ZDOTDIR` is Twigo's and puts `HISTFILE` there, so Twigo's `.zshrc` puts it back where `/etc/zshrc` would have put it.
      zsh reads `/etc/zshenv` before any `ZDOTDIR` ([`run_init_scripts`](https://github.com/zsh-users/zsh/blob/zsh-5.9/Src/init.c#L1296-L1370)), so one that sets `ZDOTDIR` takes the shell past Twigo's files.
    - bash starts with `--init-file`, whose file reads what bash itself would ([`execute_profile_file`](https://git.savannah.gnu.org/cgit/bash.git/tree/shell.c?h=bash-5.3#n1117)): as a login shell `/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile` that exists, else `~/.bashrc`.
      A login bash so runs as an interactive one that read the login files, as VS Code's does, where `logout` refuses and `~/.bash_logout` is not read.
    - fish runs `--init-command` after its configuration ([fish 4.2.1](https://github.com/fish-shell/fish-shell/blob/4.2.1/doc_src/cmds/fish.rst)), and pwsh `-NoExit -Command` after its profile, which a login pwsh reads after `/etc/profile` and `~/.profile`.
    - Any other shell starts as before, with `kubeconfigKept: false`, and its tab warns that a startup file may replace the terminal's `KUBECONFIG`.
      `crates/twigo-env/tests/terminal.rs`, which runs the first `zsh` and `bash` on `PATH`, holds it on macOS 27.2 with zsh 5.9 and bash 5.3.15, Homebrew's, first on that Mac's `PATH`, and again with `/bin` first for bash 3.2.57, and in Ubuntu 26.04 (zsh 5.9, bash 5.3.9, fish 4.2.1, pwsh 7.7.0), each a login and a plain interactive shell, with startup files that export `KUBECONFIG`, define an alias and a function, and fail (2026-11-11).
      Where none of `LC_ALL`, `LC_CTYPE` and `LANG` names UTF-8, `LANG` is the system locale in UTF-8 on macOS when `/usr/share/locale` has it, else `en_US.UTF-8`, and `C.UTF-8` on Linux.
      pty-process 0.5.4 spawns it as the leader of a session of its own with the pty as its controlling terminal; then Twigo's `pre_exec` clears the signal mask, which std no longer resets ([`do_exec`](https://github.com/rust-lang/rust/blob/1.99.1/library/std/src/sys/process/unix/unix.rs#L357-L358)), sets every catchable signal to its default and marks every descriptor above 2 close-on-exec, with only async-signal-safe calls.
  - **Output** goes out by the same flow as a pod's shell, in the same frames; the events are `Running` once it is spawned and `Failed`, in words, when it cannot start, with no `Queued` and no `Connecting`.
  - **The end** is the shell's exit, from tokio's `Child::wait`, not the pty's EOF: `Exited { code }`, or `Signaled { signal }` named as `kill -l` names it, `KILL`.
    Twigo holds a slave descriptor of its own: macOS 27.2 drops a pty's unread output 0.6 s after its last slave closes, and while another slave is open, the exit of the session's leader waits until the output is read (a probe with Python's `pty.openpty`, 2026-11-11).
    After the exit it reads on as flow control allows until a read would block, 1 s at most, so a background job's output after that is dropped, as VS Code drops it after 200 ms; then Twigo closes its side of the pty, so a job left writing meets a closed terminal rather than a full one, and the end comes.
  - **Closing** a terminal hangs up its shell's process group and the terminal's foreground group (`tcgetpgrp` on the master), closes the master and Twigo's slave, and 3 s later kills both groups if anything in them still runs; VS Code sends one `SIGHUP` to the shell's pid and nothing more.
    The pty's own hangup on close reaches only the shell, and the shell's end its foreground group, so a shell that ignores `SIGHUP` would leave its foreground job running without Twigo's.
    A job moved out of both groups, as `nohup … &` under job control moves it, survives, as in any terminal.
    Only a shell nobody has reaped is signalled, since another process may have the pid of one reaped: the wait that reaps the shell ends the hangup under the hangup's own lock, so closing a terminal whose shell has ended sends nothing, and the kill keeps the shell unreaped through the 3 s, so its pid and its group's id stay its own.
    The foreground job's leader is the shell's to reap, and goes at once, so its group's id can pass to another group within the 3 s: the kill signals a group only while it still belongs to the shell's session, `getsid` of its id answering the shell's pid, or answering that no process has that pid while `killpg` still finds members, as an id in use as a group's is never given to another process ([POSIX 4.17](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_17)).
    At quit nothing drops the terminals: after `RunEvent::Exit` Tauri 2.12.5 clears its resource tables, not the app's state, and ends the process ([`RuntimeRunEvent::Exit`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/app.rs#L1449-L1456), [`cleanup_before_exit`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/app.rs#L1128-L1140), [`run`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/app.rs#L1362-L1365)), so the `Exit` handler's `Core::shutdown` hangs up every terminal at once, `SIGHUP` to both groups, and kills nothing later, as the process ends before the kill would come.
    A terminal dropped once its runtime is gone hangs up at once too, and nothing kills later.
  - **Offers.** kubectl and most tools write new entries, as `aws eks update-kubeconfig` does, to the first file in `KUBECONFIG`: Twigo's, or a proxy terminal's own.
    Twigo watches the directory that holds it, since kubectl, aws and gcloud write in place, az replaces the file by a rename, gcloud may rename it to a backup and write a new one, and kubectl creates and removes `<file>.lock` beside it; a read that does not parse waits for the next event or 200 ms.
    Names in `clusters`, `users` and `contexts` that were not in the file as Twigo wrote it, and were never offered for this terminal, make an offer to move them into the user's kubeconfig: one live offer per terminal, sent again with its id as more come.
    It names the file a move writes to, the one of the user's files kubectl writes new entries to (the only one, else the first that exists, else the last), and what a move would leave out, by section.
    It is made anew whenever a read of the terminal's file or a change to the catalog's kubeconfig files changes what a move would do, so it says what a move does as the files are; while a move would move nothing, as after a re-run of `aws eks update-kubeconfig` whose entries the user's files hold already, it is not shown, and it comes back once a move would move something.
    Names match by section, as kubectl's do: a context moves only where the cluster and the user it names either move with it or are, in the user's files, the entries the terminal saw, the same as parsed once relative paths are resolved, so it means there what it meant in the terminal; a cluster or a user moves where its name is free in its section, unless only contexts that stay out name it.
    A move takes each offered entry as it was last seen while offered, so one that a later write dropped, as gcloud's move of the file to a backup drops all, still moves, makes the paths client-go reads relative to it absolute against its directory ([`GetAuthInfoFileReferences`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/clientcmd/loader.go#L606-L617)), and appends the entries under kubectl's `<file>.lock` and by a rename, deciding under the lock what it takes, so a name written into the target meanwhile is never written twice, which client-go refuses, the file's comments and layout kept, as Twigo writes oidc tokens back (6.2); a target that does not exist is created at 0600.
    Where the files changed after the offer was last made, so that a move would leave out more than it says, the move writes nothing: the offer is made anew, and the answer is refused as a conflict that names what a move would now also leave out.
    An offer carries its revision, how many times it was sent again with a change, and an answer names the one it answers: an answer to another, as a click that crossed a renewal on its way, moves or dismisses nothing and is refused as a conflict in words, and the offer waits on as the window now shows it, so a move never takes what the toast showed as left out, nor leaves out and forgets what it did not show.
    An offer waits on while it is answered, so a second answer is refused and what comes meanwhile joins it, one offer per terminal: a move or a dismiss withdraws the answered id, and what came meanwhile is offered under a new one, since the window drops the answered id once its answer is done, which can come after the event that offers the rest; a dismissed name is not offered again by that terminal, and a move that fails leaves the offer waiting, unless its window has gone meanwhile.
    An offer is a toast at the window's bottom right, led by the tile of the terminal's space (4.2), that stays until it is answered and has no close of its own.
    It says which terminal and context the entries came from, `Terminal 1 in dev added 2 contexts, 2 clusters and 2 users to its own kubeconfig.`, then one line per name with the kinds of entry it names, `arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu-2 · context, cluster, user`, since cloud CLIs give the three one name, and has Move to `<target>` and Dismiss.
    A name that a move leaves out says `left out` after the kinds it leaves out, and one sentence below gives the reason for every case the core has: the person's files have that name, what the context names is another entry there or missing, or only contexts that stay out name it.
    A long name breaks after its own `:` and `/`, and inside a part only where that part alone is longer than the line; the toast holds four names, then `and n more`, a button whose tooltip lists them all.
    The toaster keeps its toasts above the panel while it shows, as far up as the panel measures, so a toast covers neither the panel's tab strip nor the terminal's chip; with the panel hidden or maximized they sit at the status bar's edge.
    The toasts stay in the window whole, spread by a hover as well as closed, while they fit under the title bar: the toaster measures the heights of the toasts that show and the gaps between them, which is what sonner spreads, and where that stack does not fit above the panel it sits as low as it takes to stay under the title bar, over the panel's strip.
    A stack taller than the window under the title bar sits at the status bar's edge, so the front toast, the newest, stays in the window, and the top of the spread stack goes past the title bar.
    It sits so closed too, since moving it as the pointer arrives would move the toasts from under it.
    While the stack is closed a toast behind the front one is clipped to its box and the card's content hidden, as sonner does its styled toasts: it caps a back toast's box to the front toast's height but hides the children only of toasts it styles (2.0.8), so a taller custom card would hang below the front toast, over the panel, and a pointer there would open and close the stack; a hover shows it.
    The card itself stays, so its top edge shows above the front toast as a styled toast's does: a toast behind a newer one, a countdown or an offer among them, shows that it is there, not what it says, until a hover.
    The content is `visibility: hidden` as well, so the buttons of such a toast are out of the tab order and the accessibility tree while the stack is closed, and a hover gives them back; the box itself stays a tab stop, as sonner gives every toast `tabindex=0`, and focusing it shows the app's focus ring and nothing to press.
    A toast past the three that show, which sonner draws at no opacity even while the stack is open, is `visibility: hidden` whole, so neither it nor its buttons take the focus.
    A window of 600 px or less, where sonner reads other offsets and spreads the list across the window from its left offset, gets the same offsets and the same place, the toaster's own width at the right, so no list box reaches across the window.
    A card is 288 px wide at 12 px from the right edge and the window has no minimum width, so in a narrow one it covers what is at the right: below 518 px the Explorer's right edge, 38 px of it at 480 px, and below 348 px the space rail's (Chrome on the mock, 2026-11-11, with the Explorer at its minimum of 170 px).
    An offer sent again with its id changes the words of its toast, and a withdrawn one takes its toast down.
    The buttons answer with the revision their toast was drawn with, not the one the window holds, since sonner shows a replacement one timer tick after the window has it (2.0.8), and a click in that gap answers what the person read.
    Offers belong to the window: they outlive the terminal's tab and end with the window.
  - **Direct contexts.** A proxy terminal's file is also read for the contexts that reach their clusters past the proxy: those whose cluster, or the user they name, is not, as parsed, an entry Twigo wrote, as a tool's new context, or a catalog context's entry it replaced, as `aws eks update-kubeconfig --alias` with that name does.
    A namespace set on one of Twigo's contexts, or a new name for its entries, still goes through the proxy.
    The window is told the set, `direct` with the terminal's session, on the offers' channel whenever it changes, empty once none is left, and the tab says those contexts reach their clusters with the person's credentials.
    A later follower of the window gets the sets of its terminals that have any as it follows; a terminal whose tab closed sends nothing more, and a kubeconfig terminal, which has the person's credentials by design, never sends it.
    kubectl 1.34.1 writing into a proxy terminal's file, a namespace edit of the proxy's own context included, left the proxy's entries as they were parsed (`crates/twigo-core/tests/terminal_live.rs`, kind 1.37, 2026-11-11).
- **YAML editor and diff.**
  Monaco with monaco-yaml (yaml-language-server).
  - The schema per model URI comes from the cluster's OpenAPI (3.6), so validation, completion and hover work for CRDs too.
  - The diff editor is Monaco's DiffEditor.
  - Monaco has no read-only ranges, so where the resource has a `status` subresource the editor is read-only, with a message, while any of its selections touches the `status` block: a cursor in it or at either end, a selection that overlaps it or starts at its end.
    A selection of whole lines that ends at column 1 of `status:` may be deleted or cut, but typing or pasting over it would put the text onto `status:`, so the lock holds for those; one that starts in the middle of a line touches the block, since deleting it would join the rest of that line to it.
    The keys that would change the block from outside it set the lock for themselves, for every cursor and not the primary alone: Delete at the end of the line above `status:`, Backspace at column 1 of the line after the block, ⌥↓ on the line above `status:`, ⌥↑ on the line below the block, macOS's Ctrl+J on the line above `status:`, and macOS's Ctrl+D, Ctrl+K and Ctrl+H, which delete.
    Undo and redo lift the lock for themselves, since a read-only editor refuses them.
    Lines with nothing on them move, join and delete freely.
    What the palette can still run, with Find and Replace and a drop, the diff shows and the engine leaves out as `ignored`.
    The context menu's Paste can change the block too: Monaco's action reads the clipboard and inserts the text itself ([`clipboard.ts`](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/editor/contrib/clipboard/browser/clipboard.ts#L279-L336), the commit monaco-editor 0.57.0 is built from), so no DOM `paste` event reaches the lock, and over a selection of whole lines that ends at column 1 of `status:` the pasted text lands on `status:`.
    We accept that: the result is visible and can be undone, and the diff step says `.status` was left out of what is sent.
    Checked with a right-click on the mock in headless Chrome, 2026-11-09: no `paste` event, `GLUEDstatus:` where the line was, ⌘Z gave the two lines back, and ⌘S showed "Left out of what is sent: .status."
  - The YAML editor and the diff draw the app's monospace at 13 / 20 with ligatures off (4.9).
    Monaco measures a face when an editor is created and keeps what it read ([`readFontInfo`](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/editor/browser/config/fontMeasurements.ts#L130-L159)), so once the regular and the bold face have loaded or failed, `remeasureFonts` reads them again ([standaloneEditor.ts](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/editor/standalone/browser/standaloneEditor.ts#L423-L425)).
  - Monaco's light and dark themes are Twigo's, built from the tokens at run time and defined again when `.dark` changes on `<html>`.
    Monaco takes `#rrggbb` and the tokens are `oklch`, many with alpha or `color-mix`, so the browser paints each token's computed value into a one-pixel canvas and it is read back as sRGB hex (`srgbHex` in `ui`).
    Monaco keeps only the first six hex digits of a token rule's colour ([tokenization.ts](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/editor/common/languages/supports/tokenization.ts#L154-L176)), so the rules take opaque tokens only.
    The current Find match takes `--mark-current-foreground` on `--mark-current` through `editor.findMatchHighlightForeground`, which Monaco 0.57 applies to the current match although its description names the other matches ([findWidget.ts](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/editor/contrib/find/browser/findWidget.ts#L1489-L1496), [editorColors.ts](https://github.com/microsoft/vscode/blob/6a598d4a13031703d483d103c1d934a36ad27971/src/vs/platform/theme/common/colors/editorColors.ts#L152-L162)).
  - Top-level keys at weight 600 and a `managedFields` block that a person writes, in support, are decorations placed from the same `yaml` parse, with the editor's YAML 1.1 options, as the `status` lines above.
  - Above the text and outside its scroll, every YAML editor, the inspector's read-only one included, shows the path to the cursor's line in support at 12 px, `spec › template › spec › containers[0]`, with keys as written, such as `<<` and `no`, and a comment at the end of a block on that block's path; the last key stays whole when the path is cut.
  - Monaco is bundled locally (no CDN loader) and loaded lazily on the first YAML or diff editor.
    It is built from the tree-shakeable entry points of monaco-editor 0.57 (`monaco-editor/editor`, then each language and feature it needs), and its editor worker is a Vite `?worker` module served from the app.
  - monaco-yaml 5.5.1 runs on those entry points, since it takes the Monaco namespace as an argument, with `yamlVersion: "1.1"`; its worker is a Vite `?worker` too, whose build has no `eval` and no `new Function`, so `script-src 'self'` covers it: validation and completion ran in a Tauri build under this CSP on kind (2026-11-09).
    A model's schema comes from `schema_get` once its editor holds a copy, for a kind the cluster's discovery serves, so the kind of a new manifest is not asked for as it is typed, and its id names the space, since two clusters serve different ones for a kind; the editor works without one when that fails.
  - monaco-yaml asks monaco-worker-manager 2.0.1, the latest and from 2022, for its worker, and that does not fit Monaco 0.56 and later in two ways: it imports `monaco-editor/esm/vs/editor/editor.worker.js`, which the `exports` of 0.57 no longer map (`./*.js` is `./esm/vs/*.js`), and it calls `editor.createWebWorker({ moduleId, label, createData })`, which takes a `worker` now.
    The desktop's Vite config aliases the first path to `monaco-editor/editor/editor.worker`, and `packages/kube/src/edit/monaco.ts` hands monaco-yaml an `editor` whose `createWebWorker` makes the YAML worker and sends it `createData` as Monaco's own workers are sent theirs; both are marked `@todo` for the day monaco-worker-manager follows Monaco.
    The dev server also pre-bundles `path-browserify`, which only the YAML worker imports.
  - CodeMirror 6 was rejected: its YAML schema support is weaker, and two editors would be waste.

### 4.7 Notifications and progress

A notification centre with severity, actions and do-not-disturb, built on the toasts of `packages/ui`.
`notify` raises a toast from anywhere, and sonner, under the `<Toaster>` the workbench shell mounts, positions, stacks and times them.
A toast about a space or a context leads with that space's tile, which `notify` takes as a slot, since `ui` knows no space (4.2).
The toasts exist; the centre does not yet.
Every long operation reports progress from Rust: drain, apply, Helm, provider "Create cluster".
A command's run tells how it goes over the channel of `command_execute` (5.1).
The status bar shows a run that waits, as for a deleted namespace to go, until it ends, and a click stops the wait; a toast says how it ended, and an error waits to be read.
An action with an undo ends in a toast that offers it for as long as it lasts, a bar running down under it, and ⌘Z in the list does the same (6.4).
A toast has one button beside Dismiss, and `more` after it where a message comes with several ways to go on, as a problem of Twigo's own files does (4.10); `notify.dismiss(key)` takes a toast away by its key, as a kubeconfig file's warning goes when the file reads well again.

### 4.8 Settings and state

- **Layers**, lowest first, highest wins:
  1. defaults (from contributed schemas);
  2. user `settings.json` (JSONC);
  3. context overrides (`"[context:prod-*]": { … }`, VS Code's language overrides turned into context globs);
  4. policy.
- **Policy** is an admin-managed file, `/Library/Application Support/Twigo/policy.json` or `/etc/twigo/policy.json`, and later MDM.
  It locks values: for example "contexts matching `prod-*` are read-only", "extensions only from these registries", "MCP off".
  So far it sets modes by context glob, what `read-only` does with a port-forward, and by context glob the terminals that go through the policy proxy whatever their mode (4.6), `{"contexts": {"prod-*": "read-only"}, "readOnly": {"allowPortForward": false}, "terminal": {"usePolicyProxy": ["prod-*"]}}`, and it is read once, as the app starts.
  A key nothing reads would be a lock that does not hold, so an unknown key, like any file that cannot be read, locks every context `read-only` and says so (6.4), and has every terminal use the proxy.
- Settings are files the user can edit in the app (with a schema) or through the generated settings UI.
  Changes are picked up live.
  `keybindings.json` works the same way.
- **State** is what the UI leaves behind and nobody edits by hand: layouts, recent items, command history, column choices ([research](research/state.md)).
  - It has two scopes, as VS Code's storage has: the app's, and each space's.
    The app keeps the rail's spaces in order, the active space, part sizes, quick-access history, the columns chosen per kind, the colours chosen for contexts and the interface zoom (4.1).
    A space keeps its editors, which parts show and their containers, moved views, its namespace scope, the editors it opened recently and each view's own state.
    Until the person scopes it a space keeps no scope: it follows the namespace its first context names in the kubeconfig, else every namespace.
  - Part sizes are the app's, so switching spaces never moves the splits; VS Code keeps them per profile for the same reason.
    `parts/sizes` holds the side bars' widths, the panel's height and the width of a list's details (4.3), each once the person has resized it; the details' is stored as it was clamped when the drag ended.
  - Each value is a key that one module owns, such as `parts`, `namespaces`, `recent` or `view/<id>` in a space, and `parts/sizes`, `quickaccess/history` or `window/zoom` in the app.
    The module reads it back with a valibot schema, field by field, and what does not fit falls back to its default, so a bad value costs that value only.
    Extensions (M3) get keys in the same scopes.
  - The webview reads everything once as it starts (`state_load`), so its reads are synchronous.
    It sends each change at once (`state_set`), one call in flight, and the changes made meanwhile go together in the next, so a quit loses at most what changed during the last call's round trip.
  - `twigo-core` holds the state in memory and in `state.json` in the app-data directory, mode 0600.
    It rewrites the file atomically (temporary file, fsync, rename) a second after a change, and at once on `RunEvent::Exit`.
    macOS delivers ⌘Q, the Dock's Quit and logout as `terminate:`, which ends the app without `ExitRequested` but still with `Exit`, so nothing waits for the webview at quit.
  - A space is dropped with its state once the catalog, as noted at each start and at each change, has lacked one of its contexts for 90 days.
    Only those notings move that clock, so a context that is back by the first reading after a long break keeps its space.
    It goes as the app starts, before the webview reads any space; VS Code's per-workspace state grew without bound.
  - A file that cannot be read, or has another version, moves aside as `state.json.unreadable`, and the app starts with nothing remembered, which `problems_watch` lists as `state.set-aside` (4.10).
    Before users exist there are no migrations.
  - Secrets never go into the state: they stay in Rust and the keychain (6.2).
  - Until the settings files come in M3, the mode a person chooses for a context and the type they mark it as live here too, under a key `state_set` refuses, since only a confirmed plan of the command bus, or a type given in answer to a process's ask, changes them (6.4).
  - A space's port-forwards (4.6) live here under a key `state_set` refuses as well, with the id the last forward got in the app's scope, since only the manager changes them.
- **What is skipped from VS Code, and why:**
  - Workspace and folder layers: spaces take their place.
  - Profiles and settings sync: later, if users ask.
  - Workspace trust: becomes "kubeconfig trust" (6.2).

### 4.9 Design language (D8)

The legacy app had a deliberate design language.
It lives in `packages/ui`: the tokens, and primitives that draw every recurring pattern, so a feature says what to show and the primitives decide how it looks ([decision](decisions/frontend-architecture.md)).

- **Tokens (`theme.css`).**
  - An azure brand pair (`--brand` at oklch hue ≈245).
    Changing that pair re-skins the app.
  - Neutral greys of Twigo's own, an app's chrome and not a tinted dashboard: surfaces and text roles at chroma 0.008 and hue 250, beside the brand's.
    The shell and the side bars share one tone and the editor is the surface that stands out: white under a 0.975 shell on light; on dark the darkest, 0.185 under a 0.218 shell, as VS Code's Dark 2026, JetBrains Islands and Zed arrange them, with card 0.25 and popover 0.27 above both.
    Text stays below white on dark: content at 0.90, and strong, kept for titles and the row in hand, at 0.96.
  - Four text roles, by what the text is worth reading now ([decision](decisions/text-roles-and-type-scale.md), [research](research/typography.md)): strong for the object's title, section titles and the name in the row under the cursor; content for names, values, messages and log lines; support for property labels, table headers and secondary columns; quiet for timestamps, units, a zero count, placeholders and hints, but a field's placeholder, which lies on the field's fill, in support.
    Each is 4.5:1 or more on the shell, the editor, the side bar, a card, a popover, a selected row and a problem row's band (WCAG 1.4.3); the comment over the roles in `theme.css` states the WCAG ratio and APCA Lc of each on the shell and the editor in both themes (colorjs.io 0.7.1), and `roles.test.ts` holds it.
    Two adjacent texts in different roles differ by 25 Lc or by a second cue, a size step or the other weight.
    In the light theme the roles below content stand 20.5 and 8.8 Lc apart on the editor (colorjs.io 0.7.1 with the resolution of `roles.test.ts`, 2026-11-17), and no light values give both steps 25 Lc while quiet keeps 4.5:1 on the shell, so there the second cue carries the rule.
    On a selected row, under the cursor and on a problem row's band quiet takes support's colour, since the tint would take it below 4.5:1, as a field's fill would take a placeholder in quiet.
    Text in a tone reads at 4.5:1 on a selected row, its pill's tint and its own band, but for error text on a hovered error band over the side bar in the light theme, 4.46:1, a pair `roles.test.ts` pins; nothing draws text in a tone there.
  - Tones: error, warn, ok and idle; `--warn` fills dots and edges, and `--warn-foreground` is its readable text.
    A problem row's band is its tone at 9 % for an error and 7 % for a warning (`--band-error`, `--band-warn`, 4.4).
  - Hover and selection are alpha overlays, so they work on any surface, and so are a field's fill and its hover (`--well`, `--well-hover`), a segmented control's pressed plate (`--plate`), a keycap's fill (`--keycap`) and a problem row's band.
  - A two-layer focus ring: a solid brand line, 3:1 or more on any surface (WCAG 1.4.11), and a translucent halo.
  - Hairline borders in alpha tiers, `--border` and `--border-subtle` (below).
  - The status bar takes the shell's colour; colour there comes only from its entries' tones and the active space's context colour, a full-height block in the bar's corner, as VS Code's 2026 themes do, and from the whole bar's tint in a production context (6.4).
- **Type.**
  - The platform's UI font, SF on macOS, as VS Code, in the platform's own anti-aliasing: nothing sets `-webkit-font-smoothing`, whose `antialiased` takes about a quarter of the ink from light text on dark in WKWebView ([research](research/typography.md)).
  - Two weights, 400 and 600, as VS Code and JetBrains, and never 510, which Chrome draws heavier than 600 for the system font with `antialiased` and without it, so the mock would mislead; WKWebView drew it lighter than 600 with `antialiased`, which the app no longer sets, and without it that is not measured ([research](research/typography.md)); sentence case, no capitals.
  - A scale of steps in `theme.css`, each a size with its own whole-pixel line height:
    - `2xs` 11 / 16: key caps, count badges, the mode chip, menu key hints and the side bar's view titles;
    - `xs` 12 / 16: table headers, the kind before an object's title, menus, chips and the status bar;
    - `label` 12 / 18: property labels, beside values at 13 / 18;
    - `body` 13 / 18: body text, table cells, tree rows, property values, and section titles at 600;
    - `prose` 13 / 20: event and condition messages and descriptions, and logs and YAML in the monospace;
    - `sm` 14 / 20: buttons and empty states;
    - `title` 16 / 22: the object's title;
    - `base` 16 / 24: the device code of a sign-in, in the monospace;
    - `lg` 18 / 28: the name of a space over its Home.
  - A literal size stays only with a whole-pixel line height and a reason, each for one place that no step fits: the two letters of a small tile at 9 px, a histogram's axis at 10 px, the confirm dialog's question at 15 px and a stat tile's figure at 22 px.
  - The monospace is JetBrains Mono 2.304, bundled from its release as two WOFF2 faces, 400 and 600, with its licence beside them in `packages/ui/src/styles/fonts`, and first in `--font-mono`: logs and YAML at 13 / 20, the terminal at 12 px.
    The family token turns `liga` and `calt` off, since its code ligatures are contextual alternates.
  - Figures are tabular by column and value type, never on a whole row: counts, ratios, quantities, durations, clocks and addresses in lists (4.4), an Overview value that is a time or figures, and an Overview table's column whose every cell is, since Rust sends no column type.
  - On macOS identifiers in the UI font take SF's stylistic set 6, which the font calls high legibility, so that I, l and 1, and 0 and O, differ: names, namespaces and nodes in lists, the object's title, links to objects.
    `main.tsx` sets `data-platform` on `<html>` before the first render and the rule keys on it rather than on `@supports`, since Inter's set 6 squares its letters.
  - Dense rows: 22 px in trees, 24 px in tables under a 28 px header, whose rows carry more columns to read across; icons 16 px, Lucide's 1.5 stroke drawing 1 px lines.
- **Surfaces.**
  Flat parts split by hairlines (4.1), and tabs connect to their content: one shape and one set of rules in the editor area and the panel.
  Table columns resize from their header's edge.
  - The strip is 32 px, on the shell's surface, with a hairline at its bottom.
    A tab is 28 px tall and sits on that edge, 4 px after the strip's start and 2 px from the next tab, with a radius of 6 px at its top, 10 px of padding before its icon and 6 px after its close mark, and at least 72 px wide.
  - The active tab takes the editor's surface and a hairline at its left, top and right, none at its bottom, so it covers the strip's line and opens into its content; its title reads in content in the focused group and in support in another.
    Its fill reaches 2 px under the strip, beneath the content, so no trace of the strip's line shows under it where the strip's edge falls between device pixels, as it does at most interface zooms.
  - An inactive tab has no fill, its title in support and its icon at 70 %; under the pointer it takes the same shape in `--row-hover`.
    A preview tab's title is italic, a tab with changes not applied wears a dot where its close mark is, and a tab focused from the keyboard shows the focus ring inside its shape.
  - An editor tab asks for its title's width, the title capped at 157 px, so that a list's tab, cut at its end with only its close mark after it, comes to 220 px (`TAB_MAX`), the room a list's actions keep for it (4.4); a tab with a state mark grows past that by the mark, and a title cut in the middle never goes below its floor, so neither draws over what follows it.
    A tab in the panel has no cap, so a logs tab's title reads whole.
  - A title whose end tells tabs apart is cut in the middle, down to 16 characters, head and tail together, around a middle of at least 2em, and any other at its end: the editor's registration says which (`titleEndTells`), set by objects, diffs, logs, shells and port-forwards, whose titles end in a name or a port, and not by a list, whose kind is its title, a terminal or a new manifest.
  - A session's tab says how the session stands, from its registration's `session`: nothing while it runs, the status dot's pulse while it connects, `ended` after the title in quiet with the icon at half strength once it ended, and the error dot when it failed; logs, shells, terminals and port-forwards say it.
  - The close mark is a 20 px element of `role="button"` with a 4 px radius, not a native button: WebKit's accessibility press on an element of `role="tab"` acts on the first native control inside it ([`actionElement`](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/WebCore/accessibility/AccessibilityNodeObject.cpp#L1603-L1678)), so a native button there would take VoiceOver's press and close the tab, which the press selects instead.
    A press on the close mark never selects its tab first: dockview activates a tab on its left button's `pointerdown` unless that event's default is prevented ([tabs.ts](https://github.com/mathuo/dockview/blob/v8.8.3/packages/dockview-core/src/dockview/components/titlebar/tabs.ts#L1029-L1071)), and the close mark prevents it.
  - Where the tabs outgrow the strip, dockview's overflow button is a 24 px icon with a 6 px radius and `--row-hover` under the pointer, and its list is drawn as Twigo's menus are: a popover of 8 px radius and 4 px padding whose rows are a menu's, 28 px, 12 px text in content with a 14 px icon; the active tab's row has no mark, since a menu marks a current item with a check where the icon is.
    Dockview 8.8.3 places the list at the click, its inline `top` and `left` the click's `clientY` and `clientX` ([tabsContainer.ts](https://github.com/mathuo/dockview/blob/v8.8.3/packages/dockview-core/src/dockview/components/titlebar/tabsContainer.ts#L532-L537), [popupService.ts](https://github.com/mathuo/dockview/blob/v8.8.3/packages/dockview-core/src/dockview/components/popupService.ts#L65-L66)), which no CSS reaches, so a margin of 28 px, the button's 24 and the menu's 4, keeps it from covering the button wherever the button is clicked.
    It takes its natural width, and container queries on the dockview element hold it no wider than its area less 10 px on each side and no taller than what the area leaves under the strip less 10 px, past which it scrolls.
- **Shapes and fills** ([decision](decisions/shapes-and-fills.md)).
  - One edge per control: a fill or an outline, never both.
    A field rests on `--well`, a list's filter, the logs' fields, the title bar's search and the confirm dialog's typed name, and shows a ring only while it has the focus; the first three take `--well-hover` under the pointer.
    A toolbar picker that shows its choice (`TriggerButton`) takes the same fills, open as hovered, as the folded health filter and the logs' pod and range pickers do; the list's Group button and `TabBar`'s More are bare, in support, with `--row-hover` under the pointer and while their menu is open, and the scope chip sits on `--row-active`; a keycap is a fill of its own, `--keycap`, light enough that its text keeps 4.5:1 over a hovered field; the mode chip is its context's tint alone.
    `Segmented`, for options and filters, is a track on `--well` with 2 px of padding, its pressed choice a plate on `--plate` with its label in strong.
  - Radius follows height: 4 px up to 22 px (`rounded-sm`), 6 px from 24 to 32 px (`rounded-md`), and 8 px for cards, popovers, menus, toasts and dialogs (`rounded-lg`).
    An inner radius is the outer one less the gap between them, never under 2 px (`rounded-xs`): a segmented plate 4 px in its 6 px track, a keycap 3 px in a 24 px field and 2 px in a 26 px control, a menu's row 4 px in its menu.
    What a hover or an active state fills is rounded, but table rows and log lines, and the status bar's space entry, which fills the bar's corner.
  - Inside a part's edges a hover or a selection is a plate drawn in a hit box of the full size: a side bar tree's row takes clicks along the side bar's whole width and draws its plate 6 px in from both edges with a 4 px radius, and a status bar entry takes the bar's whole 24 px and draws its 18 px plate of 4 px radius inside it.
  - The views of a part are plates, told apart from the tabs that open into their content: an object's views in the details and in an editor, and a side bar's containers, are one `TabBar`, a 32 px row of 24 px plates with a 6 px radius, 8 px of padding at their sides and 2 px between them, at weight 400.
    The shown plate is filled with `--row-active`, its label in content; the others are bare, in support, with `--row-hover` under the pointer.
    A count follows its label in quiet as plain figures, and an object's warning events add a warning mark before their count, which takes the warning tone, so the cue does not rest on hue alone.
    Trailing plates fold into a More plate that opens them as a menu and is named for what it holds, `More views of the object`; the shown one never folds, and where it and More are too wide for the row its label is cut, down to 2em, its whole name in its tooltip ([decision](decisions/parts-give-way-by-width.md)).
    A side bar with one container shows its title instead.
  - Hairlines: `--border` on the sashes between the parts, under the tab strips and under a table's header and a group's, and `--border-subtle` under an object's views; the panel's top edge is its sash's line alone.
- **Giving way.**
  A part too narrow for itself gives way in a fixed order of stages, decided by widths its stages cannot change, and folds before it cuts: the title bar (4.1), the details' row of actions (4.3), a row of views (above), and a list editor's actions, its scope chip among them, and columns (4.4) ([decision](decisions/parts-give-way-by-width.md)).
  An object page's header gives way too, its two first lines cutting their texts first and dropping a fact only after its cut, and so do its vitals' cells and its filter's row, and the page itself from 900 px of editor (4.3).
  A text that is cut keeps its end where the end tells things apart, as a name keeps its last segment (4.4), a context's name its cluster (4.1), an object's tab its name and a forward's its port (above).
- **Motion.**
  An instant-in, gentle-out ladder (`--dur-instant` 100 ms to `--dur-slow` 300 ms).
  Anything bound to a key is instant.
- **Depth.**
  Shadows only on floating layers.
  Popovers, dialogs, menus and toasts are glass (popover at 90 % + backdrop blur + `--shadow-lg`).
- **Restraint, as a rule.**
  - Data stays near-monochrome.
  - Colour belongs to chrome accents and wayfinding: active tab, focus, selection.
  - Kubernetes status uses small semantic glyphs, and colour only for abnormal states (failed, pending, warning).
    A tone has a shape too, so no state rests on hue alone (WCAG 1.4.1): error a filled dot, warn a ring, and a pulse only while a state is in flight.
    Namespaces and labels are never coloured, and a row only when it fails or waits: a band, a 3 px edge and a faint wash in its tone, its status at weight 600 (4.4).
  - Syntax colour lives in Monaco only, from the tokens: keys in the brand, numbers, booleans and null in `--ansi-cyan`, comments in support, and strings and punctuation in content (4.6).
  - Big canvases stay plain.
  - About one primary action per panel.
  - The density target is the JetBrains/Fleet/Linear end, not an airy admin panel.
- **States are designed, not defaulted.**
  Every view state in 3.7 has its own empty, loading (skeleton) or error rendering, with a plain muted icon and one action.
- **How quality is kept.**
  - Tokens only: a lint rule rejects raw colour literals outside `packages/ui`.
  - `packages/ui/src/styles/roles.test.ts` resolves `theme.css` and holds every text role at 4.5:1 on each surface, and the figures the comment over the roles states.
  - The `packages/protocol` mock backend runs the whole workbench in a browser on fixtures: 5k-pod lists, every state.
    Every visual change is reviewed there with before and after screenshots.
- **Settled with the owner** on 2026-10-31, from variants on live tokens:
  - the flash on changed cells is the cell's background tint (4.4);
  - the context dot is a filled dot before the name (4.2), dropped on 2026-11-01: the colour now tints the rail tile and the title bar;
  - Kubernetes kinds use Lucide icons only, mapped by resource in `packages/kube`.
    Custom resources get one generic icon.
    In the explorer only the sections carry icons, since one per kind crowded the tree; tabs, details and quick access keep the kind's.
- **Settled with the owner** on 2026-11-01, after [research](research/workbench-chrome.md) into Kubernetes clients, IDEs and tools with many targets:
  - a rail of space tiles replaces the space tabs and the activity bar (4.2);
  - the title bar is a breadcrumb and a search;
  - flat parts split by hairlines, connected tabs, two weights and sentence case.
- **Settled with the owner** on 2026-11-03, from live mockups after [research](research/workbench-design.md) into Kubernetes clients, IDEs, operations tools and guidelines:
  - the resource list of 4.4 as a whole, grouping included: search in the middle of the title bar, connection dots on the rail, counts and pins in the explorer, a status bar in the shell's colour;
  - the editor darker than the shell in dark;
  - text tiers at 4.5:1, a solid focus ring, tones drawn by shape;
  - the space's home in an empty editor area (4.1), without the mockup's capacity and trend, for which Twigo has no data.
- **Settled with the owner** on 2026-11-03, from live variants of the Overview (4.3): the object's state before its metadata, and containers as cards whose less used fields fold.
- **Settled with the owner** on 2026-11-15, from live variants in the app's window after [research](research/typography.md) into contrast, type and rendering: the text roles at their lightness in `theme.css` (0.96, 0.90, 0.75 and 0.65 in dark) over the dimmer set the research measured (0.94, 0.87, 0.71 and 0.61), and the platform's own font smoothing over `antialiased` in the dark theme.
- **Settled with the owner** on 2026-11-17, from both versions shown to the owner on the running interface, in the mock and in the app's window:
  - neutrals of Twigo's own, chroma 0.008 at hue 250 on surfaces and text at the lightness they had, so the dark editor and shell are `#101316` and `#171A1E` and no longer the `#121314` and `#191A1B` of VS Code's Dark 2026 ([2026-dark.json](https://github.com/microsoft/vscode/blob/1.145.2/extensions/theme-defaults/themes/2026-dark.json#L82-L108));
  - list rows of 24 px under a 28 px header;
  - the sashes in the full hairline, `--border`;
  - no tint of the context on the tab strips, the title bar keeping its gradient;
  - the status bar's space entry as a full-height block of the context's colour in the bar's corner, not an inset plate.
- **Settled with the owner** on 2026-11-18 and 2026-11-19, on the object page (4.3):
  - one Forward, which always asks which port: `f` and the verb ask whatever the number of ports, and `⇧F` and Forward Port… are gone;
  - an object always opens in a tab of its own, and the tab it was opened from stays; a double-click or ⌘Enter on a list's row opens its object, and the docked details are the quick look;
  - the full page in one column of sections, with no summary column or index beside it;
  - the chevron leads a section's title, as it does in a side bar;
  - a list inside an Overview keeps the order the core gives, as every other list does;
  - copy buttons out of the Tab order;
  - a pill keeps the list's word and takes the core's finding tone where the list's rule calls that word healthy, as for a rollout past its deadline;
  - labels as lines, a pending pod's sentence as it is, shares from 10,000 % as `>9999%`, and no step of its own for the mock's fidelity.
- **Settled with the owner** on 2026-11-22, from live variants on the mock (3.7, 4.10): an error's code as a quiet line under its message with Copy details, the status bar's word for a list that failed by the code's family, a waiting list's cause beside "Connecting", the kubeconfig files that fail as a group of the space picker, a toast once per launch for a file that fails, Twigo's own failing files as a notification, and the report dialog with its facts and its log apart.

### 4.10 Diagnostics

What a person needs when something goes wrong, and what a bug report holds, starts with a file Twigo writes for itself.

#### The log

- **Where.**
  `twigo.log` in Tauri's log directory: `~/Library/Logs/io.twigo.ide/` on macOS, `$XDG_DATA_HOME/io.twigo.ide/logs/` (else `~/.local/share/io.twigo.ide/logs/`) on Linux, `%LOCALAPPDATA%\io.twigo.ide\logs\` on Windows ([`app_log_dir`](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/path/desktop.rs#L296-L310)).
  It is not the app-data directory, where the audit log lives (6.4), since that one is a record the person keeps and this one is disposable.
- **How it rotates.**
  Each launch starts a new `twigo.log` and moves the previous run's to `twigo.1.log`, the older ones up by one as far as `twigo.5.log`, so the run that crashed stays whole.
  Within a run a file past 4 MiB moves the same way, so the log takes 24 MiB at most.
  Every file is mode 0600.
  A second launch hands over to the running app before the log opens, so it never moves the first one's file.
- **What a line is.**
  JSON, one line per event: `timestamp`, `level`, `target` (the module path, so `TWIGO_LOG=warn,twigo=info,twigo_kube::credentials=debug` adds the debug lines of one module to the default) and `fields`, whose `message` is words.
  Identifying values travel as fields of fixed names, `context`, `space`, `cluster`, `server`, `user`, `namespace`, `object`, `path` and `url`, never inside the message, so a report can alias a value by the field that carries it.
  The first line of each run holds its facts: Twigo's version, the commit (`local build` for a build that was not given one), the OS and its version, the architecture, the web engine and its version, and the filter in force.
  The `log` records of Tauri and the libraries arrive as events through `tracing-log`, and so do the `tracing` events of kube-client, hyper-util and h2, each once.
- **Written when it happens.**
  Each line is one append under a lock, so a line is on disk when the call returns, and a panic's record is there before the hook returns.
  A failure to open, move or write the file is said once on stderr, and again only after a write succeeded in between; it never stops the app.
  The audit log (6.4) is written by the same code, but its failures are logged here at error instead, since a launched app's stderr reaches nobody.
  A process that launchd starts has `/dev/null` for stderr (`lsof` on Finder's pid, macOS 27.2.1, 2026-11-21; not run for Twigo from the Dock), so the file is the record of a run there.
  Twigo logs a change of state, not each repeat: a listener that keeps failing logs its first failure and, when it works again or ends, how many followed, and what happens per event goes to `trace`.
- **How much.**
  The filter is `warn,twigo=info`: warnings of any library, and Twigo's own crates from info.
  `TWIGO_LOG` sets it at start, in `EnvFilter`'s syntax ([tracing-subscriber](https://docs.rs/tracing-subscriber/0.3.23/tracing_subscriber/filter/struct.EnvFilter.html)); it replaces the whole default, so `TWIGO_LOG=warn` is warnings only, Twigo's own crates included, and the first line of the run, which holds its facts, is written whatever it says.
  A value that is not a filter is said in the log and the default applies.
  **Set Log Level…** raises Twigo's own crates to info, debug or trace while the libraries stay at warn, until Twigo quits; it swaps the filter at run time and logs the change.
  Set Log Level… (category Help in the palette, and macOS's Help menu) is a quick pick of the three, which says that the choice lasts until Twigo quits, and sends the one picked through `log_level_set`.
- **Reveal Log File.**
  `log_reveal` shows the current file in the system's file manager; Reveal Log File (Help) and the report dialog call it.
  Rust calls the opener plugin, so the webview holds no permission of the plugin's own, as with `url_open`.
- **The webview.**
  Its errors reach the log through one command, `diagnostics_log`, with the window's label, as events of the target `twigo::webview`.
  `apps/desktop/src/main.tsx` sends what the page's `error` and `unhandledrejection` events and the React root's `onCaughtError`, `onUncaughtError` and `onRecoverableError` report, and a failure to start, each with the message, the stack and what caught it.
  An `IpcError` goes by its code alone, since its message can quote what the API server said of a request; the same message and stack are sent once, and the count reaches the log each time it doubles.
- **The panic hook.**
  `twigo-log` installs it first in `main`, after the `--dump-env` copy has returned, since that copy never opens the log.
  A panic writes one record in the log's own shape: the time, the thread's name, the tokio task's id where the panic is in one, the location, the message, a backtrace and Twigo's version.
  The log opens first thing in `setup`, so the record goes to stderr only for a panic before it.
  A debug build also calls the hook it replaced, so the terminal of `pnpm tauri dev` still prints.
  The hook never panics, which would abort the process, and waits only a moment for the log's lock, since the panicking thread may hold it.
- **What never reaches it.**
  A token, a client key, an exec plugin's output, a Secret's data, a terminal's input or output, the login shell's environment, a kubeconfig's text and a frame, a batch or an object's values.
  `ShellEnv`, the login shell's failure and the oidc refresh's failure print names and statuses only, since an event may carry them.
  The error of a kubeconfig that does not parse quotes the lines around the fault, a token or a client key among them, so no event carries it: the catalog reports a failed file by its path and the line and column of the fault (5.5).
  A server's message for a failed request can quote a value the person typed, so the log carries no such message, and the audit log's `ended` line carries a failed command's code in its place (6.4).
- **A failure's event.**
  Where a failure enters a view, a session, a forward or a command's answer, the log gets one event with `code`, the error's wire name, as a field, and no message: a command answers an error or a plan ends in one, or stops with requests that failed (info), a list or object's upstream is refused, an all-namespaces list cannot get its context's clients, a log stream's state becomes an error, a shell or a terminal ends `failed`, a forward becomes `reconnecting` or `failed`, or is `failed` as it is restored, and a metrics answer cannot be decoded (`answer.undecodable`, at error).
  Each is said once while it holds, since each is logged where its state changes, and a sync command's error is not logged.

#### Twigo's own files that fail

- `twigo_log::problems` lists, once per code for the run, what a file of Twigo's own could not do that leaves the person with less than they set up: `state.set-aside` (the modes and locks they set are gone), `state.unsaved` (until a save works), `trust.set-aside`, `audit.off` and `audit.unwritten` (nothing is recorded, or a line was lost), and `tokens.unsaved` (the next start asks to sign in again).
  Each is reported where it is logged, with Twigo's words and no path or value; a report of a code replaces its last.
  `audit.unwritten` is raised only by a write that failed, not by a log that could not move aside or open anew, which loses no line, and it goes with the next line that lands; `tokens.unsaved` stays while any user's refreshed tokens are in memory only, the registry holding those users by their oidc key, and goes when the last of them is written back by a later refresh, as `state.unsaved` goes with the next save that works.
- `problems_watch` answers the list and sends it again on every change.
  The list is the run's, not a window's: the files are read before any core exists, and the crates that fail do not know one.
  The window follows it from the start, and raises one notification when a code joins the list, in Rust's words, which say what it means for the person, with Reveal Log File and Report… beside Dismiss (4.7).
  A code listed again with other words raises none, and a code that leaves the list takes its notification with it, so a problem that comes back is told again.
- The policy file that cannot be read locks every context `read-only` (4.8) and says so in the access popover with its reason, which is where it does not parse (`it is not JSON at line 3, column 1`) or what failed to read it (`permission denied`), never a word of the file.

#### Report a Problem

What a bug report holds, and how it leaves the machine, is Rust's to decide, since only Rust has the log as it was written.
`report_problem`, `report_open_issue` and `report_save` are its commands, in `twigo-core`'s `report` module; Report a Problem… (Help) opens the dialog that calls them.

- **What it holds.**
  - Facts, each with an id, a label and a value: Twigo's version and commit, the OS and its version, the architecture, the web engine and its version, the Kubernetes versions of the clusters this run asked, without their names, and the place (`file:line`) of the newest panic of this run or the previous one.
    The person can untick the last two.
  - The log: the last 200 records or 32 KiB of `twigo.log` and `twigo.1.log`, whichever is less, as text lines of time, level, target, message and `field=value` pairs, with a field of several lines, such as a panic's backtrace, below its line.
    A record counts for at most 8 KiB of the window, so four fit however long they are, and its text is cut at that size, at a line and a panic's backtrace before its message, with the bytes it left out said, so one long record never leaves the log empty.
    A line that is not a record, which a full disk or a kill leaves torn, shows as `<a line that is not a record>`, never as its text.
  - How many names, paths, tokens, addresses and quoted values the redaction hid, and how many lines it showed as a placeholder.
  - Nothing else: never a kubeconfig, `state.json`, `trust.json`, the policy file or the audit log.
- **The redaction**, in Rust, so the webview never holds the log as written, in three layers:
  - A field of a fixed name (`context`, `space`, `cluster`, `server`, `user`, `namespace`, `object`) becomes an alias numbered by first appearance in the report, `<context-1>`, `<namespace-2>`, and a `url` or `path` field becomes `<url>` or `<path>`.
    A space is its context, so its alias is the context's.
  - Every name the catalog and the state know, and every value a field carried in this report, is aliased with the same alias where it stands in free text as a whole token, the longest first and in one pass, so an alias is never read again.
    The catalog's are each context's name, cluster, user, namespace and server (as a URL, as host and port, and as host, except that a loopback server is not known by its bare host, which is also every forward's address), and the state's are every space, the namespaces each space is on, and the namespaces and names of its saved forwards' targets and of its recent editors' objects and lists, a comparison's two objects and an edit's diffed object among them.
    A server is its scheme, host and port wherever a field or the text writes it, so a URL with a trailing `/` or a path (Rancher's `/k8s/clusters/<id>`) is the same server as the kubeconfig's, and what follows its alias in a URL goes with it.
    A name shorter than three characters is aliased where a field carries it and stays in free text, where it would garble the words around it.
    The rows of a list are not among them, nor are objects that no saved forward or recent editor (a space keeps 20) names: a name that no field carries and no list holds reaches the report only by the fixed patterns.
  - Fixed patterns: the home folder of the process and of the login shell becomes `~` and the account's name `<account>`, JWTs and the credentials after `Bearer` and `Basic` `<token>` (a word of lowercase letters only after them is prose, as in `Basic information`, and stays), emails `<email>`, URLs `<url>`, addresses other than loopback `<address>`, and every double-quoted string `"…"`, unless it holds nothing but aliases.
    An address is found bare, with a port, in brackets, in a list, after a word and a colon (`node:10.0.0.21`) or a dot, and as a prefix (`fd00:10:96::/112`).
    What a letter, a digit or `_` joins to a word (`pod10.0.0.16`) stays, and so do the tail of a longer dotted number (`2.8.11.9` of WebKit's `22625.2.8.11.9`), a time, a port and a version of three parts; a four-part number up to 255 (`1.0.0.1`) and a serial of eight hex groups go as addresses.
  - No hashing: a hash of `prod` or `default` is reversed by trying names, while an alias says nothing outside its report.
- **The Kubernetes versions** are what `cluster_version` last got from each context's clients, which the window asks for the open space's context, kept with those clients, so a context whose kubeconfig changed forgets its version.
  The report sends no request, and a context nobody opened has no version in it.
- **What leaves the machine, and how.**
  Twigo itself sends nothing: the person chooses a way out, and every one is theirs to press.
  - Open Issue on GitHub: `report_open_issue` takes the ids of the facts left ticked, states them again from this run, and has the opener plugin open `…/issues/new?template=bug_report.yml` with them as its `environment` field.
    The link stays under 6,000 characters: past that it opens the bare template, which takes some 170 distinct Kubernetes versions in one run to reach (measured on 2026-11-22 with five facts and a 100-character panic place).
    A request without a GitHub session got `302` at 7,001 characters, `500` at 7,051 and 8,001 and `414` at 8,201 (`curl -s -o /dev/null -w "%{http_code}"` on `github.com/cli/cli/issues/new?title=t&body=<n × a>`, 2026-11-22); the limit for a signed-in person was not measured.
    The log never goes in the link: opening a link sends it to github.com and keeps it in the browser's history, so the dialog's click handler writes the log to the clipboard, where `report_open_issue` could not, and the person pastes it into the form's Logs field.
  - Save…: `report_save` asks where, through the same dialog as a logs tab's download, and writes the text the person sees as `twigo-report-<date>.txt`, which the form's upload field takes.
  - Copy: the text as it is, in the webview.
- **The form.**
  `.github/ISSUE_TEMPLATE/bug_report.yml` has one `environment` textarea, which the link fills, a `logs` textarea that says to paste what Twigo copied, an optional `upload` field for a saved report, and never asks for a kubeconfig.
  A Rust test fails if the `environment` field is gone or renamed.
  An issue is public, so the dialog tells the person to read the text first.
- **The dialog.**
  A window-level dialog beside the trust dialog and the approvals (`packages/workbench/src/parts/Shell.tsx`), not an editor, so it opens with no space.
  `ProblemReport` asks Rust for the report when it opens, and the dialog shows it until it closes.
  - The issue's facts are read-only, with a tick on those the person may leave out.
  - The log is one editable monospace field, with a line that says how much the redaction hid (`Twigo hid 6 names, 2 paths and 1 token; read it before you paste`) and Reveal Log File beside it.
  - It says that the issue is public, that nothing leaves the computer until the person chooses and that Twigo itself sends nothing, and links GitHub's private reporting of a vulnerability for a security problem (`SECURITY.md`).
  - Open Issue on GitHub writes the log as the person sees it to the clipboard in its click handler, before `report_open_issue`, since WKWebView may not allow the write after an IPC round trip (not verified); then the dialog closes with a toast that says where to paste the log.
    Save… sends `report_save` the text of the facts left ticked above the log, and Copy puts the same text on the clipboard.
  - A failure of any of them shows its error in the dialog with its code, as every error does (3.7).

#### When Twigo's own code stops an item

A list, an object page, a logs tab, a shell, a terminal or a forward whose task panicked ends with `internal.panic` (2.1), and its view says so in one wording, which `INTERNAL_ERROR` in `packages/workbench/src/internalError.ts` keeps: "Twigo hit an internal error" and what stopped (`This view stopped.`; a shell's or terminal's scrollback says that this shell stopped).
It shows the code as every error does, keeps Rust's own message (`Twigo stopped this list on an internal error`) in Copy details, and offers Report…, which opens the report dialog.
Reopen is offered where the view can open again:

- a list, an object page, a home tile and a comparison of objects subscribe anew, a tile reopening the home's four counts together;
- a logs tab drops its session and opens another, keeping what it reads and how it shows it;
- a shell or a terminal starts a new session, which it cannot resume, and its banner carries the code and Rust's message as every error does;
- a forward is started again by Start.

A view that keeps something of the item says so over it: the YAML tab keeps a held edit under a bar with the same words and offers, and a comparison of an object that stopped after its manifest came keeps its last text under one.

## 5. Commands, keybindings and extensions

### 5.1 Commands, menus and context keys

```ts
interface CommandDescriptor {
  id: string; // "k8s.resource.delete", "segla.cluster.create"
  title: string;
  category: string; // palette group: "Kubernetes", "View", "Segla"
  icon?: string;
  enablement?: string; // when-expression, evaluated against context keys
  args?: JSONSchema; // typed arguments: palette prompts for missing ones
  handler: "frontend" | "backend" | { extension: string };
}
```

- **One namespace for commands**, as VS Code's CommandsRegistry.
  Every UI action is a command, including the single-key table verbs.
- **Backend commands.**
  - All Kubernetes operations: apply, delete, scale, restart, drain, cordon, trigger, suspend, Helm, a shell or an attach in a pod (4.6), and a Reveal of secret-grade data (3.6).
  - A change of a context's protection: the person's mode, the type they mark it as, and an unlock (6.4), which send nothing to a cluster.
  - Each is an action of the command bus in `twigo-core`, planned first through `command_plan`.
    Rust finds what it acts on, refuses what the policy blocks before anything is asked, and answers with what it will do, in words and as the equivalent kubectl command, and the friction its blast radius asks for in the context's mode (6.4).
  - The webview draws the friction and runs the plan by its id through `command_execute`, with what proves the friction was met: the name typed, the countdown passed.
    Rust checks the proof, runs a plan once, only from the window it was made for and on the cluster it was planned for, refuses it when the mode now asks for more, and decides on the policy again; the gate checks each request as it goes out.
  - `command_cancel` drops a plan, or stops a run where stopping leaves what it sent standing, as the wait for a deleted object to go.
  - Args are resource references (`ResourceRef`), never full objects.
    What a command still needs is asked in quick access, as VS Code's input box: scale's replicas, prefilled with what the row says.
- **A command says what it needs and what it sends**, beside its enablement:
  - `requires`, conditions that each give the words for why the command cannot run while they fail, as `resource.capability.patch` with `You may not restart it`; the command is disabled with the first that fails, which the details' row shows on a pinned verb kept in its place (4.3), while a resource command's other menus hold its requirements in their `when` and leave the item out;
  - `danger`, that it destroys what it acts on, which menus draw in the error tone;
  - `sends`, the class of request it asks the gate for, `write` or `exec`.

  While the active space's context is `read-only` (`context.readOnly`), a command that sends, whose enablement and requirements hold, is drawn locked in menus and rows of actions: dimmed, with a lock and `prod-eu is read-only`, a destructive one keeping its error tone.
  A failing requirement draws it disabled with its words instead.
  The palette draws no lock: it lists a command that can run as any other.
  A locked command still runs, so that the gate refuses it and offers the unlock where the person may lift it (6.4); a space of several contexts has no one mode, so nothing shows a lock there, and the gate decides alone.

- **Menus are data that point at commands**, with `group`, `order` and `when`, as VS Code's MenuRegistry, and `pin`, a when-expression where the item keeps its place on a row of actions, before More (4.3).
  The menu IDs:
  - `commandPalette`
  - `resource/context` (row context menu)
  - `resource/details` (the row of actions in the header of the details and of an object editor, 4.3, whose first two pinned verbs a hovered row shows, 4.4)
  - `resource/marked` (marked rows' bar, 4.4)
  - `view/title`, `view/item`
  - `editor/title`
  - `panel/title`, `panel/empty` (the panel's strip and what an empty panel offers, 4.1)
  - `edit/toolbar`, `edit/changed`, `edit/conflicts`, `edit/immutable`, `edit/diff`, `edit/answer` (the YAML editor's toolbar and the bars of what an apply answered, 4.3, 6.5)
  - `space/context`
  - `statusBar`
  - `explorer/kind`

  The native macOS menu is generated from the registry, replacing legacy `menu.ts`'s hand-written list.

- **Commands on an object** take their subject from their argument, else from `object.subject` where an object editor runs them, else from the list's selected row (`list.uri`).
  - Their keys work while `listFocus`, and while an object editor's Overview holds the focus outside a text field, where `pageFocus && !inputFocus && object.subject` stands for the list's focus, so a key typed into the page's filter is the field's.
  - Show YAML, Open Details and Open in Editor need `list.uri`, so an object editor does not offer them.
  - Forward is one command, `k8s.resource.forward`, on `f`: it asks which of the target's ports, the default first, and goes to the forward a port already has rather than start a second; there is no `⇧F` and no Forward Port….
  - `k8s.resource.openEditor`, Open in Editor, is on ⌘Enter, and a double-click on a list's row runs it.

- **Context keys** are typed values scoped to the focused element.
  A `when` expression evaluates them, using a subset of the VS Code grammar: `==`, `!=`, `&&`, `||`, `!`, `=~`, `in`, `<`, `>`.
  Core keys:
  - `space.id`, `space.contexts`, `space.multiContext`
  - `context.name`, `context.readOnly`, `context.mode`, `context.unlocked`, `context.provider`
  - `listFocus`, `treeFocus` (a tree, which is also a list: left and right close and open), `editorFocus`, `inputFocus`
  - `pageFocus`: the focus is in the details or an object editor while their Overview view is shown, which the bare keys of 5.2 and the filter's `/` and Escape read
  - `object.uri`: the URI of the editor whose Overview holds the focus, the list editor's for the details, which the page's own commands act on, and unset while another view is shown
  - `object.filtered`: that page's filter holds text
  - `object.subject`: the object an object editor shows, as `resource/details` names it, once discovery has named its resource; the commands of a resource take it as their subject where they are given none, and the details set none, their verbs acting on the list's selected row
  - `inQuickOpen`, `quickOpenToSide` (the open provider opens rows to the side), `quickOpenCanPickMany` (it takes ticked rows)
  - `resource.group`, `resource.kind`, `resource.namespaced`, `resource.namespace`, `resource.scalable` (discovery lists its `scale` subresource)
  - `resource.selected`: a command of a resource has an object to act on, the list's selected row, or an object editor's once discovery names its resource, and false in a list inside an Overview
  - `resource.cordoned`, `resource.suspended`, `resource.ended`: what the selected row's cells say, or an object editor's printed cells (`header.printed`) once its Overview has come, so a menu offers Uncordon only on a cordoned node, Resume only on a suspended Job or CronJob, and neither Suspend nor Resume on a Job that ended
  - `resource.noContainerRuns`: on the scope of the details and of an object editor, true only while the object's Overview lists containers and none of them runs, on every view (4.6)
  - `list.uri`: the list editor's URI on its scope, so a command on rows acts on that list's selected row or marks, and on nothing where no list is named (4.4)
  - `selection.count`
  - `editor.open`, `editor.dirty`, `editor.type`
  - `panelHasEditor`: the panel holds an editor, which Maximize Panel Size needs (4.1)
  - `logsReopenable`: the active space has a closed logs tab to bring back, for Reopen Logs (4.3)
  - `capability.<verb>.<resource>[/<subresource>]`, the resource by kubectl's name (`capability.create.jobs.batch`), and `resource.capability.<verb>[/<subresource>]` for the list's own resource, which a command of every resource, as delete, cannot name.
    A list asks `access_review` for the keys some command's enablement or requirements read, in the selected row's namespace and, for the list's own resource, by the row's name, which a rule that lists `resourceNames` needs, and so for a hovered row while its icons show (4.4), until they go; Rust answers each with a SelfSubjectAccessReview kept with the context's clients, for the whole resource first and by name only when that says no, and asks about a namespace in that namespace, as kube-apiserver authorizes it.
    The Delete of the marked rows reads `marked.capability.delete` instead, the list's delete asked for each marked row, and true only where every answer is.
    A key holds until its answer says no, and one the cluster cannot answer holds, so only what RBAC refuses is disabled and the server still decides.
    A refusal is asked again every 30 s while its row is still asked about, and an access review that fails drops its entry, so the next ask sends it again.
    Until a hovered row's own answers come, its icons read the last answers in its namespace of the keys asked without a name, `capability.*`, which hold for every object there; an answer by name, `resource.capability.*`, never stands in for another object, and a key nobody has answered holds.
    A review of the selected or the hovered row that fails drops, with that object's own answers, its namespace's answers of the keys they held, so the row's icons, and those of its namespace's rows with no answers of their own, read those keys as held again, as the details do.
  - `operationUndo`: the spaces whose last action an undo puts back now
  - `platform`

  Extensions may define keys under their own prefix.

### 5.2 Keybindings

- **Resolution as in VS Code's `keybindingResolver`.**
  - Rules carry a weight: core < built-in extension < extension < user.
    The last matching rule whose `when` holds wins.
  - A command's key hint, in menus, tooltips and the palette, is its winning binding that no later rule of another command takes: one on the same presses, or on chords that start or continue its own, whose `when` holds wherever the binding's does.
    Where the layout maps two rules to one press, as Ctrl+\` and Ctrl+Shift+\` on a layout that types the backtick with Shift, the earlier command has no hint.
    Whether the later command is enabled is not weighed.
  - In the user's `keybindings.json`, `"-command"` removes a binding.
  - Chords are supported (⌘K ⌘S), as are per-platform variants (`mac`, `linux`, `win`).
- **Dispatch** happens on `KeyboardEvent.code`, mapped through the active keyboard layout.
  - WebKit has no Keyboard Map API, so `twigo-keyboard` supplies what each writing-system key types, plain, with Shift, AltGr (Option on macOS) and both, and `keyboard_layout_watch` sends every change.
    - macOS: TIS names the layout and `UCKeyTranslate` reads its keys; the distributed notification `kTISNotifySelectedKeyboardInputSourceChanged` reports a switch.
    - Linux: xkbcommon reads the keys of the active layout, the XKB group.
      GDK 3 shows the group only on key events, and on X11 signals nothing when only the group changes.
      So on X11 the keymap comes from the X server through xkbcommon-x11 and XKB events on a connection of the crate's own, since the server keeps one keyboard state for all clients.
      On Wayland only the focused client hears the group, so a `wl_keyboard` of GDK's own connection receives the keymap and the group, as Firefox keeps one.
    - Windows: `ToUnicodeEx` reads the keys of the UI thread's layout, and a TSF profile activation sink reports a switch, as VS Code's native-keymap does.
    - TIS, GDK and Windows' per-thread input language answer only on the UI thread, so the watch starts there and keeps the latest layout for any thread to read.
    - A dead key maps to the character it shows alone: `^` for French `BracketLeft`.
  - The keybinding service maps bindings as VS Code's keyboard mappers do.
    Letter shortcuts follow the character on Latin layouts (QWERTZ, AZERTY, Dvorak) and fall back to the US key position on non-Latin layouts such as Ukrainian.
  - Labels show what is printed on the key.
- **Bare keys** fire only in `listFocus` or `pageFocus` and never inside inputs or Monaco.
  This keeps legacy `isTypingTarget`.
  Quick access's input is the one exception, for ↑, ↓ and Enter under `inQuickOpen`: they edit no line of text, and drive its list as in VS Code's quick input.
  On macOS ⌃N and ⌃P move the cursor down and up too, as VS Code binds them under the same `inQuickOpen` ([`quickOpenSelectNext` and `quickOpenSelectPrevious`](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/browser/actions/quickAccessActions.ts#L245-L279)); the footer names ↑ and ↓.
  Space is the same under `inQuickOpen && quickOpenCanPickMany`, where the open provider takes ticked rows: what is picked is never a name that holds a space, so Space ticks the row under the cursor and types nothing, while the space that ends the `ns ` prefix is still typed, since the input resolves to the provider with no prefix until it is.
- **The keybindings editor** shows conflicts and the source of every binding.
- **Keymaps** ship as contributions: Default (VS Code-like) and k9s (vim movement, `:` mode on bare `:` in `listFocus`).
- **macOS native menu accelerators** come from the same table.
  The OS consumes them before the webview does, as legacy's menu already relied on.
- **Shortcuts the webview reserves** (for example ⌘Q, ⌘H, ⌘M, and some ⌘⌥ combinations on WebKitGTK) are documented and refused in the editor.

### 5.3 Extension runtime (D3, D4)

Four tiers.
An extension uses only the tiers it needs.
Every tier is declared in the manifest and granted at install time.

| Tier                   | What                                                                                                                                         | Isolation                                                                                                                                                                                                      | Ships                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **0: manifest**        | Contributions as data: commands, menus, keybindings, settings schema, themes, keymaps, CRD schemas and snippets, declarative views and forms | Nothing executes.                                                                                                                                                                                              | Last in 7.2 (D14), private at first |
| **1: WASM component**  | Logic: cluster and credential providers, command handlers, data providers for trees and tables, form submit handlers, resource actions       | wasmtime, one store per extension. No ambient authority. Fuel or epoch limits for CPU and a `ResourceLimiter` for memory. Every import is checked against grants.                                              | Last in 7.2 (D14), private at first |
| **2: sandboxed frame** | Views that cannot be declared (charts, wizards with custom widgets)                                                                          | `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) served from `twigo-ext://<id>/` with a deny-by-default CSP. postMessage only to the host frame, which relays to that extension's tier-1 component. | After tiers 0 and 1                 |
| **3: native process**  | k9s-style actions (shell, kubectl), MCP or LSP servers, helpers that must be native                                                          | None beyond the user's rights: shown as such and started only after explicit consent. Binaries are declared per OS with URL and SHA-256. Their cluster access goes through the policy proxy (6.4).             | After tiers 0 and 1                 |

Why WASM in the core rather than a Node host or a worker in the webview:

- Credentials and cluster access stay in Rust.
- Extension tools serve the MCP server even while the webview reloads.
- Port-forward and provider tasks do not depend on the UI's lifecycle.
- A Node host "has the same permissions as VS Code itself": that is how plugin stores get malware.

Costs, and how they are handled:

- Authoring: Rust is first-class.
  TypeScript works through jco/componentize-js (larger components).
  Go works through TinyGo.
  HTTP and kube calls are host imports, so a weak guest `net` stack does not matter.
- Debugging: a dev mode with hot reload, host-side logging per extension, and a fixture cluster.
- WASI 0.3 async is new.
  The API is shaped so the host drives async I/O through imports: the guest calls `kube.request` and the host awaits it.

**API stability, from Zed.**

- The WIT package is `twigo:extension@<major.minor>`, with one directory per API version.
  The host keeps every old binding, and an extension binds to the version named in its manifest.
- Until 1.0 the whole API is `0.x` and unstable.
  Release builds load an unstable-API extension only when settings or the policy file allowlist it, and each entry is bound to a publisher key that the package signature must match.
  The core names no extension; the fixture is built in.
  After 1.0, new APIs start as proposals enabled only in dev builds, as VS Code's `enabledApiProposals`.
- Host UI libraries (React, Radix) are never part of the API.
- A fixture extension in `extensions/` exercises every contribution point in CI.

Illustrative WIT (shape, not final):

```wit
package twigo:extension@0.1.0;

interface types {
  record cluster { id: string, name: string, server: string, ca-data: option<list<u8>>,
                   labels: list<tuple<string, string>>, read-only: option<bool> }
  record token-cred { token: string, expires-at: option<u64> }
  record cert-cred { cert-pem: string, key-pem: string, expires-at: option<u64> }
  variant credential { token(token-cred), client-cert(cert-cred) }   // stays in Rust
  record http-request { method: string, url: string, headers: list<tuple<string, string>>, body: option<list<u8>> }
  record http-response { status: u16, headers: list<tuple<string, string>>, body: list<u8> }
}

interface host-http    { fetch: func(req: http-request) -> result<http-response, string>; }        // hosts grant; never a catalog API server
interface host-kube    { request: func(context: string, req: http-request) -> result<http-response, string>; } // contexts + resources + verbs grant; passes the policy layer
interface host-auth    { oauth-loopback: func(cfg: string) -> result<string, string>; }             // host runs RFC 8252 flow, keeps refresh token in keychain
interface host-secrets { get: func(key: string) -> option<string>; set: func(key: string, v: string); }  // own namespace
interface host-ui      { notify: func(level: string, msg: string); quick-pick: func(items: list<string>) -> option<u32>; progress: func(id: string, pct: u8, msg: string); }

interface cluster-provider {
  list-clusters: func() -> result<list<cluster>, string>;
  resolve-credential: func(cluster-id: string) -> result<credential, string>;
}
interface handlers {
  execute-command: func(id: string, args-json: string) -> result<string, string>;
  provide-rows: func(view: string, parent: option<string>) -> result<string, string>;    // tree/table data
  submit-form: func(form: string, values-json: string) -> result<string, string>;
}

world extension {
  import host-http; import host-kube; import host-auth; import host-secrets; import host-ui;
  export cluster-provider; export handlers;     // SDK supplies "unsupported" defaults
}
```

### 5.4 Manifest and contribution points

```jsonc
// extension.json (Segla example; the extension itself lives outside this repository)
{
  "id": "segla.segla",
  "version": "0.1.0",
  "engines": { "twigo": "^0.1.0", "api": "0.1" },
  "component": "segla.wasm",
  "capabilities": {
    "http": ["https://api.segla.io"],
    "auth": { "oauth": { "issuer": "https://auth.segla.io" } },
    "kube": { "contexts": "provided", "resources": ["nodes", "pods"], "verbs": ["get", "list", "watch"] },
    "secrets": true, // the extension's own keychain namespace, not Kubernetes Secrets
  },
  "contributes": {
    "clusterProviders": [{ "id": "segla", "title": "Segla", "icon": "segla.svg", "create": "segla.createCluster" }],
    "commands": [{ "id": "segla.createCluster", "title": "Create cluster", "category": "Segla" }],
    "forms": [{ "id": "segla.createCluster", "schema": "forms/create-cluster.schema.json" }],
    "configuration": { "segla.organization": { "type": "string" } },
    "mcpServers": [{ "id": "segla", "url": "https://api.segla.io/mcp", "auth": "provider:segla" }], // v1.x
  },
}
```

Contribution points, with the activation each implies.
Contributions imply their activation events, as VS Code ≥ 1.74 does; `*` is forbidden.

| Point                                         | Purpose                                                                                           | Activates on                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| `commands`, `menus`, `keybindings`, `keymaps` | Actions anywhere in the UI                                                                        | `onCommand:<id>`            |
| `configuration`                               | Settings schema, rendered in the settings UI                                                      | —                           |
| `viewsContainers`, `views`                    | Declarative trees, tables and forms in any part; tier-2 frames                                    | `onView:<id>`               |
| `resourceSections`                            | Declarative sections on a GVK's Overview (fields, table, conditions, links; 4.3)                  | `onResource:<group>/<kind>` |
| `columns`                                     | JSONPath columns for a GVK (turns on projection, 3.3)                                             | —                           |
| `actions`                                     | k9s-style shell or kubectl actions with `scopes`, `confirm`, `dangerous`, `inputs` (tier 3, v1.x) | —                           |
| `clusterProviders`                            | Catalog source, credential minting, lifecycle (create, delete, upgrade)                           | `onClusterProvider:<id>`    |
| `mcpServers`                                  | MCP servers re-exposed through Twigo's MCP gateway, auth kept in Rust (6.6, v1.x)                 | first `tools/list`          |
| `crdSchemas`, `snippets`                      | YAML editor help for CRDs the cluster's OpenAPI describes poorly                                  | —                           |
| `themes`, `iconThemes`                        | Look                                                                                              | —                           |
| `uriHandlers`                                 | `twigo://ext/<id>/…` deep links (for example SSO callbacks)                                       | `onUri`                     |

**Resource sections** are evaluated in Rust by the JSONPath evaluator of custom columns (3.3), so they reach the drawer, the Overview and MCP alike.
A section takes over a core one only by naming its id in `replaces`, and its header names the extension; two extensions replacing one section is an error shown on both.

**Actions** keep k9s's format and fix its injection flaw:

- Values pass as positional arguments (`sh -c '<script>' sh "$1" "$2"`).
  kubectl templates are split into arguments before rendering.
- They run as tier-3 processes after consent.
  Their `KUBECONFIG` is the policy proxy's, so their cluster access obeys the context's mode.
  `mutates: true` hides an action in read-only contexts.
- An importer reads an existing k9s `plugins.yaml` and maps its variables onto safe arguments (v1.x).

### 5.5 Catalog and the "Create cluster" provider

- **Catalog entities** (Lens's model): an ID, a name, a source, labels and tags, an icon or colour, a status (phase, reason), and a connection.
- **Sources.**
  - The core ships one: kubeconfig files, as kubectl reads them, and folders the user adds (M3).
    - The files `KUBECONFIG` lists, as the login shell sets it (6.1), else `~/.kube/config`, merged by kubectl's rules: the first file to define a name wins ([research](research/state.md)).
    - A listed file that does not exist is skipped, as client-go skips it; one that cannot be read, parsed or merged is skipped, and the other files still count.
      `contexts_watch` answers `{ contexts, failures }`, each failure the file as a person names it, from `~`, and an `IpcError`: `kubeconfig.unreadable` with the `io::ErrorKind`, `kubeconfig.unparsable` with the line and column of the fault and no other word of serde-saphyr's, and `kubeconfig.unmergeable`.
      The rendered parse error quotes the lines around the fault, a token among them, and even without them its message names the value it met where it expected a variant (`interactiveMode: <token>`), so only the location leaves the core.
      A watch that cannot start is a `kubeconfig.unwatched` failure of each file, and so is a directory the OS will not watch (inotify's `fs.inotify.max_user_watches` used up) of each file that needs it, since their edits go unseen; the reason is the OS's own, with none of the paths it names.
      The catalog logs a failure when it appears or changes and when none of a file's failures is left, by `path` and `code`, and not at every read.
    - A context whose entries are missing says so in `problem`: `context.empty`, `context.missing-cluster` or `context.missing-user`.
    - A notify debouncer watches the closest existing directory above each file, because writers replace files by rename and `~/.kube` may not exist yet, and the directory of a symlink's target, where writes through it land.
      Reads do not count, since inotify reports every open, Twigo's own loads among them, and a change that leaves the catalog as it was reports nothing.
    - The explicit mode keeps development, tests and the bench off real clusters: in debug and bench builds `TWIGO_KUBECONFIG` replaces every source, and only its `kind-*` and `kwok-*` contexts count.
  - The webview follows the catalog through `contexts_watch`, which answers once the sources have been read, after the login shell's environment.
    Each context says the file that defines it, from `~` under the home directory, and its cluster's URL with only scheme, host and port, so no credential written into the URL reaches the webview.
  - Each extension's `clusterProviders` is a further source.
  - Later: Cluster Inventory `ClusterProfile` (SIG Multicluster, alpha).
- **Connection** is either
  - `KubeconfigRef { file, context }`, or
  - `Provider { provider, clusterId, server, caData }`, whose credentials come from the provider's `resolve-credential`.
    The token or certificate stays in Rust, is cached until 60 s before it expires, and is refreshed on 401.
  - Unlike Lens and Headlamp, **providers never write kubeconfig files**.
    "Export to kubeconfig" is an explicit command; for Segla it writes an exec entry for `sgl cluster credentials <label>`.
- **Metadata from kubeconfig** `extensions` (name `twigo`): `color`, `tags`, `readOnly`, `environment`, `order`.
  Twigo reads it and never writes it.
  Each field is read on its own, so a value Twigo does not know drops only that field; `readOnly` alone reads anything but `false` as a lock, and `environment` counts only as Production or Staging, which tighten (6.4).
  Contexts with an `order` come first, lowest first, then the rest, each group by name.
  `tags` comes with the catalog's views.
- **The generic "Add cluster…" command.**
  Its picker lists "Import kubeconfig…" plus every provider's `create` command.
  The form is a declarative JSON-Schema form.
  Submit goes to the provider's handler, which reports progress, and the new cluster appears in the catalog once the provider lists it.
  The core knows nothing about any provider.

**Segla, end to end, as a test of the model:**

1. Sign-in uses the host's `oauth-loopback` (RFC 8252).
   The refresh token goes to the keychain under the extension's namespace.
2. `list-clusters` calls Segla's GraphQL API, which is in its `http` grant.
3. `resolve-credential` mints a short-lived cluster token, using the same RFC 8693 exchange that `sgl` uses.
4. "Segla: Create cluster" is a tier-0 form whose submit is handled in tier 1.
5. Segla's remote MCP server is declared in the manifest and re-exposed through Twigo's MCP gateway (v1.x).
   The provider's auth stays in Rust.
6. Nothing Segla-specific lives in this repository.

### 5.6 Distribution and trust

- **The registry** is an index repository.
  CI builds every package from its tagged source, as `zed-industries/extensions` does.
- Packages are signed (minisign or Sigstore) and verified against their SHA-256 at install.
- Users and policy can add registries (Segla's, for example) and allowlists.
  The core ships no proprietary registry.
- **Install** shows the requested capabilities in plain words, for example "talk to api.segla.io" or "read nodes and pods in contexts it provides".
  Kubernetes `secrets` are never covered by a wildcard: reading them is a separately named grant.
  The user grants them, and they can be narrowed or revoked later in the extension's page.
- **Updates** keep the grants.
  A new capability triggers a new prompt.
- **Built-in first-party extensions** live in `extensions/`: the fixture extension, and later Flux, Argo CD, cert-manager and NATS.
  They use the public API only, so the API is proven before third parties rely on it.

## 6. Auth, security and read-only enforcement

### 6.1 Login-shell environment (`twigo-env`)

GUI apps on macOS start with launchd's minimal `PATH`.
That is why `aws`, `gke-gcloud-auth-plugin` and `kubelogin` "are not found" in Lens, Headlamp and Podman Desktop.

- **At startup, in the background**, Twigo runs `<shell from getpwuid> -i -l -c "'<twigo exe>' --dump-env <head> <tail>"`, where `<head><tail>` is a random marker.
  This is VS Code's `resolveShellEnv` technique.
  - stdin is null, the child gets its own process group, and a 10 s timeout kills the group.
    The timeout covers rc files that run `exec tmux` or prompt.
  - `-i` is required, because gcloud's `path.zsh.inc` lives in `.zshrc`.
  - The binary prints its environment between two copies of the joined marker, entries ending in NUL as `env -0` prints them, so multi-line values survive and whatever rc files print around it is dropped.
    The marker reaches the shell only in halves, so a shell that traces its commands (`set -x`) never prints it whole.
    A background job an rc file leaves running shares the pipe, so a line it prints at the wrong moment can still land inside the frame and corrupt one entry: the binary passes the whole frame to one `write_all`, which splits only when the pipe is full, while the fallback's frame comes from three processes.
  - fish, nushell, xonsh and pwsh need their own invocation forms: fish and xonsh escape `\` and `'` in single quotes, nushell runs a raw string with `^`, xonsh wraps the call in `![…]`, and pwsh takes `-Login -Command "& '…'"`, doubling every quote PowerShell reads as a single quote, `‘’‚‛` included.
    Each form was run on fish 4.9.3, nushell 0.116.1, xonsh 0.25.0 and pwsh 7.6.9 (Docker, 2026-11-01), with tracing on where the shell has it.
  - If the shell runs but the binary prints nothing, the shell runs `/bin/sh -c 'set +x; printf %s%s "$1" "$2"; /usr/bin/env -0; printf %s%s "$1" "$2"' sh <head> <tail>` instead, `set +x` because bash as `/bin/sh` traces when an exported `SHELLOPTS` holds `xtrace`.
    Both runs share the one 10 s timeout.
- **The result** is an `Arc<ShellEnv>` applied to every child process: exec plugins, terminals, tier-3 processes, agents.
  Twigo never calls `set_var` on its own process; that is unsafe once threads exist.
- **The core reads `KUBECONFIG` and the proxy variables from `ShellEnv` explicitly**, in the catalog and in the connector.
  kube-rs reads them from the process environment, which on a Dock launch is launchd's.
- **`--dump-env` and `twigo mcp` are handled in `main()` before the Tauri builder**, so the single-instance plugin does not swallow them.
- **Ordering.**
  Connecting to a cluster waits for the environment.
  On a timeout or any other failure, Twigo proceeds with the process environment and shows a status-bar warning, whose popover offers "Retry" and "Show details": what the shell printed before the frame, never the environment itself.
- **Linux** uses the same mechanism.
  **Windows** (D2) reads `HKCU\Environment` and the system environment from the registry, because Explorer's environment goes stale after installs.
- `fix-path-env-rs` is not used: no timeout, line-based parsing that breaks on multi-line values, and `set_var`.

### 6.2 Credentials (`twigo-kube`)

kube-rs's built-in exec auth does not suit a GUI.
kube-client 4.2.0 runs the plugin with a blocking `Command::output()` and no timeout, three times for each client it builds, with the terminal's stdin and stderr, so device codes disappear ([research](research/credentials.md)).
Twigo therefore owns credentials, and follows client-go's rules where the plugin sees them:

- **Clients.**
  Each context has two shared hyper-util clients: an HTTP/2 one for requests, watches and logs, and an HTTP/1.1 one for exec, attach and port-forward (3.2).
  Every actor's kube clients are built over them with kube's base URI and header layers and Twigo's auth layer.
  The exec block is stripped from the config first, and the `gcp` and `azure` auth providers are refused with client-go's messages, since kube would run gcp's `cmd-path`.
  A token, basic auth or a client certificate in the user entry wins over its plugin, as in client-go, which reads an empty one as none.
- **The credential runner.**
  - Uses `tokio::process` with the shell environment, then the entry's `env`, then `KUBERNETES_EXEC_INFO`; null stdin, its own process group, killed whole on a timeout, a cancel or the app's quit, and stdout capped at 1 MiB.
    It waits for stdout to close but not stderr, which a helper the plugin left running may hold, and reads stderr to its end in the background so that helper never meets a broken pipe; client-go hands stderr to the terminal.
    The panel gets the first and the last 8 KiB of stderr: device codes and URLs come first, errors last.
  - `KUBERNETES_EXEC_INFO` says `interactive: false`, since Twigo never passes a terminal, and carries the cluster when `provideClusterInfo` is set.
    A plugin set to `interactiveMode: Always` is refused, as client-go refuses it without a terminal.
  - Reads the output by client-go's rules: the configured apiVersion, a token, a PEM certificate and key, or both, as JSON or YAML, the last of a repeated key winning.
    An error names no output, since the parser would quote the token.
  - Contexts whose entries name the same plugin share it, keyed as client-go keys its authenticators: the exec config, and the cluster when it is passed.
    Concurrent requests share one run, and its failure too.
    An unattended plugin that failed runs again for the next request, as in client-go, but its status keeps the failure until that run ends, so the sign-in panel keeps the fix on screen; asking to run it shows the run under way.
  - Caches the credential until 60 s before it expires; without an expiry, until the server rejects it.
    One that comes with less left, as a plugin's own cached token does near its end, is kept until it expires, since another run would only return it again.
    A 401 drops it, runs the plugin once more and retries the request once, its body rebuilt from the bytes kube holds; client-go only refreshes for the next request.
  - A certificate from the plugin is offered at each TLS handshake, and a new one retires the api client's connections, whichever client got it first, as client-go closes them; the sessions client keeps no idle connection, since each session upgrades its own.
    TLS resumption is off for these clients, since a resumed session keeps the certificate of the handshake it resumes.
- **Plugins that may ask the person to sign in.**
  A cold cache makes them open a browser or print a device code, and none can be told to fail instead; `interactiveMode` does not tell them apart.
  - Only plugins known never to ask run unattended: `aws eks get-token`, aws-iam-authenticator, gke-gcloud-auth-plugin, doctl without SSO, `oci`, `pinniped login static`, int128/kubelogin's client-credentials grant and its password grant given both the username and the password, and Azure/kubelogin's non-interactive logins, with `AAD_LOGIN_METHOD` read from the login shell's environment and the entry's, as kubelogin gets it.
    Every other plugin, an unknown command included, may ask.
  - One that may ask runs only while a Twigo window has the focus, so that its browser or code finds the person (the owner's choice, 2026-11-01).
    With a warm cache it answers at once and nobody notices; while the window is in the background, the request waits for it to come back.
  - After a sign-in fails or is cancelled, it runs again only when the person asks, since retrying by itself would open browser after browser.
    A 401 still runs it once more, as any plugin; with its cache warm that run is silent.
  - The sign-in panel opens above the status bar's credentials item (the owner's choice among a dialog and a corner card, 2026-11-01).
    It opens once the plugin prints, after 2 s without a credential, since a browser flow often prints nothing, or when a sign-in fails while its space is active.
    It is no popover: a popover's dismissable layer takes Escape, either from the app's keybindings or from the code the person still needs.
    So it takes no focus, ignores Escape and clicks elsewhere, and closes from its close button, the item, or a run that succeeds.
    A run the person closed it on keeps it closed, in any space that shares the plugin, until they open it again or see that run fail, since a failure seen in the space opens it again.
    It shows the device code and the link, the plugin's output, its elapsed time and Cancel; a failure shows the fix the plugin's message names, such as `aws sso login`.
    Rust opens the link through tauri-plugin-opener, only for https and the plugin's own server on localhost or 127.0.0.1, and never one with a user part.
  - Unattended runs time out at 120 s; sign-ins at 10 min, past int128/kubelogin's and tsh's own 180 s, since a tsh killed mid-login leaves a lock that breaks the cluster until `tsh login`.
- **Lazy.**
  Credentials are resolved only when a request needs one, which a space's activation is, never for all contexts at startup.
  Headlamp #7879 is the failure this avoids.
- **Kubeconfig trust**, adapted from VS Code's workspace trust.
  - An exec plugin is a command chosen by whoever wrote the kubeconfig.
  - On the first start, Twigo lists every exec plugin the kubeconfigs name, with the contexts that use each, and the person trusts them once.
  - A new or changed entry (a different digest of command, args and env) asks when its space activates, before it runs.
  - The digests live in `trust.json` beside the state store, which only Rust writes; an unreadable file trusts nothing, and is listed as the problem `trust.set-aside` (4.10).
- **The deprecated `auth-provider: oidc`.**
  - Twigo refreshes it as client-go does: the id-token until 10 s before its `exp`, then discovery and a `refresh_token` grant, with the IdP's CA and the login shell's proxy.
  - It writes the new id-token and refresh-token back to the user's file, as kubectl does, since the file is the token store every client shares and Dex rotates the refresh token on every refresh (the owner's choice, 2026-11-01).
    Only the two values change, through `yaml-edit`, under kubectl's `<file>.lock`, by a rename over the resolved file, so its hard links and ACLs do not carry over; kubectl writes in place.
  - One refresh runs at a time, and the file is read again first: tokens someone else wrote since, as kubectl does, are taken, never the ones it still holds after a failed write or a rejection.
    The new tokens go to memory before the file, so a failed write never loses the only valid refresh token.
  - After a 401 the next request takes a newer token from the user's file, else refreshes once if a refresh can replace the rejected token: one from the file with a refresh token, not one a refresh just got or one whose refresh failed.
    The other requests that carried it are rejected too, so a refresh starts only while the rejected token is still the current one.
    The rejected token stays until something replaces it, since client-go never refreshes on a 401 and every refresh rewrites the file.
    A request whose provider has no other credential goes unretried.
  - A token or basic auth in the entry wins over the provider, as in client-go.
  - The oidc tokens do not count in the fingerprint (6.3), so a refresh rebuilds no client.
- **Client certificates and token files** work through kube.

### 6.3 Transport

- TLS is rustls with ring by default, using the OS trust store when the kubeconfig has no CA.
  An optional per-context openssl stack covers legacy clusters that rustls rejects: TLS < 1.2, X.509 v1, CN-only certificates.
- Proxies are picked as kubectl picks them, so a kubeconfig that works there works here.
  - The cluster's `proxy-url` carries every request, to loopback too; client-go accepts http, https and socks5.
  - Without it, the login shell's `HTTPS_PROXY` (or `HTTP_PROXY` for an http server) does, by the rules of Go's `golang.org/x/net/http/httpproxy`: never for `localhost` or a loopback address, and never for a server `NO_PROXY` lists, where `.x` and `*.x` match subdomains only, `x` the domain too, an entry may carry a port, and a CIDR matches servers given by IP.
    kube-client 4.2.0 instead reads `HTTPS_PROXY` from the process environment and has no `NO_PROXY` (`kube-client/src/config/file_loader.rs`), and hyper-util's matcher follows curl's rules, which proxy loopback and read `.x`, `*.x` and ports otherwise.
  - The OS proxy settings are not read: kubectl never reads them, so they would send through a proxy what kubectl reaches directly (the owner's choice, 2026-11-01).
  - socks5 and socks5h both leave names to the proxy, as Go does.
  - An https proxy's certificate is checked against the OS trust store, and the proxy gets no client certificate.
    client-go checks it against the cluster's CA and would give it the cluster's client certificate, since Go's transport reuses its TLS config for the proxy.
- A request that gets no answer says why, as kubectl prints `Unable to connect to the server: <inner>`.
  `twigo_kube::errors::request` walks the chain of the failure, through the error an `io::Error` wraps, which `io::Error::source` steps over and where hyper-rustls hands over a failed handshake's, and takes the first cause that names a condition, in Twigo's sentence with the innermost cause after it:
  - `connect.refused` from `io::ErrorKind::ConnectionRefused`, `connect.timeout` from `Elapsed` and `io::ErrorKind::TimedOut`, whose sentence has no inner cause to add;
  - `connect.certificate` from `rustls::Error::InvalidCertificate`, with the verifier's own words (the platform's, or rustls's name such as `UnknownIssuer`), and `connect.tls` from any other `rustls::Error`;
  - `connect.proxy` for the tunnel's and SOCKS5's errors, which hyper-util keeps unnameable, so the dialer connects to the proxy first and wraps what each step answers:
    - "Twigo could not reach the proxy" where that connection is refused, does not resolve or is not trusted, or is not made in time.
      The hop through the proxy has the connect timeout, counted from before its name resolves, and the connector's own deadline through a proxy is twice that, so the hop's ends first; a proxy that took the connection and has not opened the tunnel when the hop's time runs out "did not open the connection to the cluster: timed out", since a proxy answers a CONNECT or a SOCKS request only once it has tried the cluster (RFC 9110 9.3.6, RFC 1928 6), so the cluster may be what does not answer.
    - "The proxy did not open the connection to the cluster" where it answers the tunnel with a 407 or any other status, or the SOCKS handshake with refused credentials or any reply but success, with hyper-util's words after it, which name the SOCKS reply (`host unreachable`, `connection not allowed`); its tunnel keeps no status but 407, so a 403 and a 502 read alike (TODO.md).
  - `connect.unresolved` from a resolver of Twigo's own over the `GaiResolver` that `HttpConnector` uses, since its `ConnectError` is private;
  - `connect.other` with the innermost text otherwise.
  - A WebSocket upgrade takes the transport's code, or a `server.*` code by the status of an answer that was no upgrade.
  - A body that is no `Status`, a proxy's HTML, an API path that does not exist or a gateway's `{"message": …}`, has no `server` status: kube-client's placeholder reason is no reason of the server's.
    Where Twigo reads the response itself, as a list and an apply do, only a body whose `kind` is `Status`, or that has a code, is read as one, and any other takes the code of the response's status, so a gateway's `503` is `server.unavailable` and a list waits for it; kube's own client reads any JSON object as a `Status` of code 0, and the requests that go through it keep that.
  - An exec's end `Status` is read as a request's refusal is, so it takes a `server.*` code too.
- When the kubeconfig changes, Twigo fingerprints each context from its context, cluster and user entries plus the files they reference, the user's oidc tokens left out (6.2).
  It rebuilds only the clients whose fingerprint changed, for every actor at once, since each actor's kube clients hold the context's shared pools (6.4), and restarts their upstreams.
  New proxy variables in the login shell rebuild every context's clients the same way.
- Exec, attach and port-forward use kube-rs WebSockets (`v5.channel.k8s.io`, falling back to `v4`; there is no SPDY) over the HTTP/1.1 client; requests, watches and logs share the HTTP/2 connection (3.2).
  RBAC needs `create` on `pods/exec`, `pods/attach` and `pods/portforward` for WebSocket upgrades from 1.35.
  The action is offered only after a cached access review.

### 6.4 Read-only enforcement (`twigo-policy`)

**One gate, in Rust, below every caller.**

- The policy check is a tower layer at the top of every actor's kube clients (3.2), above their credential and the stream counter, so a request it stops runs no plugin and takes no stream.
  A second check sits just above the socket, below all a request waits for: a mode can change meanwhile, and a relock has to reach a request already waiting.
  The UI, extensions (via `host-kube`) and the MCP server have no other way to reach a cluster, so they cannot get around it.
  `host-http` refuses any host and port that belongs to a catalog API server.
- `authorize(context, attributes, actor)` runs before the request leaves the process.
  The attributes are a verb, resource, subresource, namespace, name and class, read from a request as the API server reads it ([`NewRequestInfo`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/request/requestinfo.go#L127-L274)), `%2F` decoded, or from what a command says it will do.
- The frontend only displays the lock.
  Legacy kept the lock in a frontend store synced to Rust, and that model is reversed.
- **What the layer sees, and what commands add.**
  The layer classifies each request before it is sent, by HTTP method, resource, subresource, the `dryRun` and `includeObject` parameters, and the `Accept` header:
  - read: GET, LIST, WATCH, plus the POSTs that only ask questions (`authorization.k8s.io` self-subject access and rules reviews, `authentication.k8s.io` self-subject reviews);
  - dry-run: a POST, PUT or PATCH of a resource itself, outside the groups of `authorization.k8s.io` and `authentication.k8s.io`, whose reviews answer whatever it says, with `dryRun=All` and no other value.
    A DELETE is no dry run, as kube-apiserver reads a body's options and never the query when there is a body ([`DeleteResource`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/delete.go#L95-L127)), and the layer reads no body.
    A subresource is none either: `serviceaccounts/token` mints a token whatever the query says ([`TokenREST`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/core/serviceaccount/storage/token.go#L295)).
    Nor is one to a group-version kube-apiserver does not serve itself, since the server its APIService names may ignore `dryRun` and perform the write: a dry run is one in kube-apiserver's own groups, with no read, and in any other only once a read of its APIService (`<version>.<group>`) as the actor says it names no `spec.service`; one to a group-version whose APIService names one, or cannot be read, is a write, for every actor.
    Its own groups are the core group and those it serves from its own storage in any release Twigo supports (`BUILT_IN` in `twigo-policy`'s `served.rs`): the groups of the REST storage providers it registers ([`StorageProviders`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/controlplane/instance.go#L423-L451), `lifecycle.k8s.io` from 1.37 on), and those of apiextensions and of the aggregator, which it chains with them ([`CreateServerChain`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/cmd/kube-apiserver/app/server.go#L185-L206)), a group served only once `--runtime-config` or a feature gate enables it included.
    An admin can still point the APIService of one of them at a service, as kube-apiserver registers them to sync once at its start ([`apiServicesToRegister`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/controlplane/apiserver/aggregator.go#L355-L384)) and its controller leaves one that it synced, or one without its label, as an admin left it ([`checkAPIService`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/kube-aggregator/pkg/controllers/autoregister/autoregister_controller.go#L241-L264)); that is a deliberate act, and the policy, as the proxy, guards against accidents, not against deliberate acts.
    Reading them instead would cost a person whose RBAC cannot read APIServices the preview of every edit of a Deployment, a Job or an Ingress in `read-only`.
    What a read says is kept 5 minutes of the wall clock by context, the connection the reading clients were built for, and group-version, in the policy (`twigo_policy::Served`), where the gate and the approval broker find the same answer.
    The gate decides synchronously and reads only what is kept: whatever sends a dry run outside kube-apiserver's own groups, the apply preview, the broker and the proxy, has the actor's clients read the APIService first (`ActorClients::attributes`), with a `GET`, a read that waits on nothing, so no request leaves as a dry run before the answer is known and no read goes round through itself; one whose answer lapsed meanwhile goes as a write.
    In `read-write`, and for the UI in `guarded`, the apply preview's dry run to a group another server serves goes out all the same, as the write the mode lets through, so a server that ignored `dryRun` would apply the edit at the preview.
  - write: every other POST, PUT, PATCH, DELETE;
  - secret-read: GET, LIST or WATCH of `secrets`, and a dry run of a write to them, which is answered with what it would store.
    Only a Table with `includeObject=None` and no plain JSON fallback escapes it, and only every range of `Accept` read as `goautoneg` reads it.
    Metadata does not, as `kubectl apply`'s last-applied annotation holds the values in clear (3.6).
    `includeObject=Object` (kubectl `--sort-by` sends it) counts.
    This is deliberately conservative: a plain `kubectl get secrets` through the proxy counts too.
    The class is decided by actor, not by mode:
    - the UI, which masks values until the user reveals them;
    - terminals, which read Secrets without a Reveal confirmation on purpose, since they are the user's own shell;
    - `helm`, whose release storage is Secrets;
    - Twigo's MCP tools, which read inside the core only to return keys and sizes;
    - extensions, only with the named `secrets` grant;
    - agents through the proxy, only with an approval scoped to the session and namespace, and a fresh one per call after untrusted content (6.6).
  - forward: `pods/portforward`, and GET without `Upgrade` on `pods/*/proxy` and `services/*/proxy`;
  - exec: `pods/exec`, `pods/attach`, every `nodes/*/proxy` request (it reaches the kubelet, including its exec), and any other request that carries an `Upgrade` header or uses a proxy subresource.
    A `CONNECT` counts too, and so does a path with an empty, `.` or `..` segment, which a server or a proxy in front of it may clean into another.

  A write to `secrets` also needs what reading one needs, since its answer is the stored Secret and an empty patch changes nothing.

  The mode allows or blocks every other class.
  In `guarded` the UI's writes and exec pass, since its commands confirm above the layer and the command bus checks that they did (5.1); anyone else's pass only with an approval the broker attached to the request (below).
  Confirmations, typed context names and diffs belong to the commands above the layer, because at the HTTP level a scale is one PATCH and a drain is many requests.

- **Actors.**
  Each actor (the UI, an extension, an MCP client, an agent session) gets its own two kube clients, which carry its policy layer over the context's two shared hyper-util clients and the context's stream counter (3.2).
  The hub, commands and discovery use the UI's.
  A hyper-util client clone shares its pool, so every actor uses the same HTTP/2 connection, and the layer knows who is asking without per-call plumbing.
  Each request of an actor's clients carries `User-Agent: twigo/<version> (<actor>)`, the actor as the audit log names it, so the cluster's own audit log tells Twigo's requests, and whose they are, from another client's: neither kube nor hyper sets one (kube-client 5.1.0, hyper 1.12.0, hyper-util 0.1.21).
- **Child processes go through a policy proxy.**
  `helm` for release actions, kubectl in actions, the `kubectl port-forward` fallback, agent sessions and terminals of every context that is not `read-write` get a generated kubeconfig.
  Provider contexts always use it in terminals, and so do the contexts the policy file's `terminal.usePolicyProxy` matches (4.6, 4.8).
  - It points at a loopback endpoint in the core (`crates/twigo-core/src/proxy`): HTTP/1.1 over TLS on `127.0.0.1`, on a port the OS picks when the core gives its first process a token, kept for the app's life.
    TLS guards nothing the token does not, but clientcmd reads a user's credentials only for an https server ([`ClientConfig`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/clientcmd/client_config.go#L230-L249)), so kubectl sends no token to `http://`; a CA made in memory per run signs the endpoint's certificate for `127.0.0.1`, and each kubeconfig trusts that CA alone.
  - Each process gets a kubeconfig of its own in `proxy/` under the app-data directory (0700, the file 0600), deleted with the process's handle and, should the app end first, at the next start.
    It holds a context per context the catalog lists, named as the catalog names it, with its namespace, whose server is `https://127.0.0.1:<port>/<id>` and whose user holds only a token.
    `<id>` is `[a-z0-9]+`, from the context's name and its connection, so kubectl's discovery cache, a directory per server URL, never answers for another context or for another cluster the name moves to ([`computeDiscoverCacheDir`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/cli-runtime/pkg/genericclioptions/config_flags.go#L514-L522)).
  - A token is 32 random bytes, one per process and context, kept only by its SHA-256 digest.
    It maps to the process, its context and the context's connection when it was given, an actor, the window that may ask, and the process's label; nothing writes it to stderr or the audit log.
    The actor is a terminal, `helm` or an agent, and the core gives no other a kubeconfig: the gate lets the UI's writes through `guarded` unasked, Twigo's MCP tools read Secrets on the premise that they return only keys and sizes, and an extension reaches clusters through `host-kube`.
  - What a request meets, in order: a `Host` other than the endpoint's or any `Origin`, `403`, as kubectl proxy guards against DNS rebinding; no token, an unknown one or another context's path prefix, `401`; an empty, `.` or `..` segment, `400`; a context that names another cluster than when the token was given, `403`, so a token never reaches the new one; an `Upgrade` header on anything but an upgrade (below), `400`; then the gate's decision.
    Every refusal is a Kubernetes `Status` whose message starts with `Twigo: `, in the gate's words where the gate refused, which kubectl prints.
    Nothing goes out once the process's handle has dropped: every send races the process's end, the read of the APIService that says whether a dry run is one and the reads an ask makes to show what a request would do included, so a request accepted before it, its body still coming or its ask answered at that moment, gets a `403` instead of the server's answer, and no ask is shown for a process that has ended.
  - `Impersonate-*` goes on unless the context's kubeconfig acts as someone already, which gets a `400`: kube appends its own impersonation headers to the request's, and a request of two identities is not what the person asked for.
  - `Authorization`, `Host` and hop-by-hop headers stop at the proxy, `Upgrade` and `Connection: Upgrade` excepted on an upgrade; `Kubectl-Command` and the WebSocket and SPDY headers pass as they came.
    `User-Agent` keeps the products it came with and gets ` twigo/<version> (<actor>)` after them, as it is a list of products ([RFC 9110 10.1.5](https://www.rfc-editor.org/rfc/rfc9110#section-10.1.5)), or Twigo's alone where none came: the actor's clients add it, as to their own requests, in one header.
  - Ordinary requests and watches go through the actor's clients over the context's shared connections, stream counter and policy layer, so auth, the 401 refresh, the proxy connector and the gate stay one path.
    The body is read whole, as kube's request body cannot stream, and above the API server's own 3 MiB gets a `413`.
    The answer passes back frame by frame, hop-by-hop headers aside.
    A relock leaves a read's answer, and a write's, which comes once the write is done, but ends one of the exec or forward class, such as a `proxy` subresource's without `Upgrade` (`GET nodes/<n>/proxy/…`, `POST pods/<p>/proxy/…`), by the rule that ends a splice (below): its context's mode now refuses its class whatever any approval says; such an answer also ends when its context names another cluster.
    The connection that carries an answer ends when the answer's process's handle drops or a relock ends the answer, whatever its client reads: hyper polls a body only while it can buffer what the body gives ([`poll_write`](https://github.com/hyperium/hyper/blob/v1.12.0/src/proto/h1/dispatch.rs#L384-L401)), so a watch whose client stopped reading would otherwise keep its stream and its upstream.
  - An upgrade is a `GET` or a `POST` that carries `Upgrade` to a pod's `exec`, `attach` or `portforward`, or to the `proxy` of a pod, a service or a node, in the core group.
    It takes a session of the context's budget (3.2), goes on the actor's HTTP/1.1 client with an empty body, and on a `101` is spliced with `hyper::upgrade::on`, which is all kube's own `connect` does ([`connect`](https://github.com/kube-rs/kube/blob/5.0.0/kube-client/src/client/mod.rs#L240-L275)).
    Any other answer passes through, holds the session until its body ends, and ends with what ends a splice.
    The raw upgraded stream passes through whatever the protocol: WebSocket, SPDY, or SPDY over WebSocket.
    Either direction's end ends both, as kube-apiserver's own proxy does, and so do the process's handle dropping, its context naming another cluster, and a mode that now refuses its class whatever any approval says: a terminal's `kubectl exec` ends when its context turns `read-only` (within 3 ms of the relock in two runs of `crates/twigo-core/tests/proxy_live.rs` on kind 1.37, 2026-11-10), while `guarded` ends none.
  - **Pre-approved tokens** for a process started by a confirmed command (a Helm release action, an action with `confirm`), for exactly the verbs and objects the command listed, come with their first callers (7.2); a request outside that set would go to the approval broker.
  - **Other processes in `guarded` contexts** (terminals, unconfirmed actions, agents): writes and exec-class requests go to the approval broker (`crates/twigo-core/src/approvals.rs`).
    - The proxy asks the gate first with no approval, only to know whether to ask; the request then meets the gate with the approval the broker attached, a `twigo_policy::Approval` request extension, which the gate reads with the attributes at the top and keeps for the recheck above the socket, so a relock still stops an approved request that waited.
      It asks only when an approval of exactly that request would let it through: anything else the gate refuses for want of an approval, such as an agent's read of a Secret or its write to one in any mode, is a `403` at once, with no ask.
    - An approval names its context and actor and covers either exactly the verb, decoded path and class the person saw ("once", a pod's exec, attach or port-forward by its `get` or its `create` alike), or every write and exec of that process on that context until a wall-clock time, deletes and a pod's evictions excepted ("for 15 minutes").
      `read-only` refuses whatever approval a request carries, and `read-write` needs none.
    - The ask goes to the window the token names, which follows asks with `approvals_watch`; with no such window the answer is deny.
      It shows the verb, the target, the client's `Kubectl-Command`, whom `--as` acts as, and what the request would do: a dry run of the same request through the same actor's clients against the live object for a write of a resource itself, a Secret's values masked and none of the server's words about it shown, as a refusal of a patch quotes the patched Secret whole, but only where the gate takes it for a dry run, in a group-version kube-apiserver serves itself, as an aggregated server that ignored `dryRun` would perform the write before the person answers; elsewhere the ask says that another server serves the group, or that Twigo could not read whether one does.
    - Every `DELETE`, whatever RBAC calls it, and every eviction of a pod, which deletes the pod, asks for the typed context name and shows the propagation its options ask for, and "for 15 minutes" never covers one.
      "For 15 minutes" holds only while the context's mode, where it comes from, its connection and all else the catalog says of it stay, a change that went back included, and ends with the process's handle.
      Given, it also lets through the process's other asks on the context that are still waiting, each withdrawn from the window and noted `lasting`, and its requests whose ask is still reading what to show, but a delete's, which waits on.
    - One answer covers a request's repeats for 15 s of the wall clock, by token, method, path, query, body, every `Impersonate-*` header and `Content-Type`, and whether it upgrades: kubectl repeats a write after each `429`, and a refused exec, attach or port-forward of a pod, its WebSocket `GET`, over SPDY as a `POST`, so for those alone a `GET` and a `POST` are one.
      The same bytes acting as someone else, or read as another kind of patch, are another request, which asks again.
      A denial covers every repeat; "once" covers only a repeat of the verb, decoded path and class it was answered for, the `GET` and `POST` of a pod's stream as one, and one request at a time.
      A request takes it as it is sent and gives it back only when it reached no server: after the proxy's own `429`, or a pod's stream answered other than `101`, as nothing of it runs before the kubelet's `101` ([`ServeExec`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/cri-streaming/pkg/streaming/remotecommand/exec.go#L40-L48)); a proxy's answer came from its backend, and a request whose client went may have reached the server, so neither gives it back.
    - An ask is withdrawn when its request goes, as when kubectl is killed, when the process's handle drops, when the window goes, and when the context's access changes so that the ask no longer fits the request, which then meets the gate anew: it goes, is refused, or asks again.
    - The audit log notes how each ask ended in an `approval` line: `once`, `lasting`, `denied`, `nobody` when no window could ask, or `withdrawn`.
      An unmarked ask answered with a type has no `approval` line, only the `protection` line of the change it made (below), and one denied is noted `denied` as any other.
      An answer counts only when its waiting request takes it: one that comes after the request went, or after its process ended, is refused and grants nothing, and the window gets the withdrawal.
    - Agents may use the scope "this process" for the rest of one run, except for deletes, which comes with them (M3).
      Terminals get only "once" and "for 15 minutes", because a terminal's token lives as long as the shell, and only terminals are offered "for 15 minutes": until their own scopes come, an agent's and `helm`'s asks are answered once.
  - For agents, the Rule of Two (6.6) also applies in `read-write` contexts: after untrusted content, their writes, exec-class requests and Secret reads go to the broker one call at a time.
  - The proxy has its own cap on concurrent streams per context (default 16, 3.2).
    Over the cap it answers `429` with `Retry-After: 1`, because client-go retries a 429 only when that header holds whole seconds, ten times at most.
    An upgrade while the session budget is full gets a `429` too, but client-go never waits for an upgrade: `kubectl exec`, `attach` and `port-forward` fail with it, and `kubectl run -it` and `debug -it` fall back to printing logs.
    The proxy never queues requests and never evicts the UI's upstreams (3.2).
- **What the proxy does not cover.**
  It guards against accidents, not against a determined process.
  - Any process running as the user can still read `~/.kube/config` or pass `--kubeconfig`.
    That includes tier-3 processes, agents and terminals.
  - The terminal of a `read-write` context from the user's kubeconfig uses real credentials by design: it is the user's own shell, like any terminal app (4.6).
  - A user's kuberc, `$KUBERC` or else `~/.kube/kuberc`, can default any flag of a kubectl command, `--kubeconfig`, `--context` and `--server` included, as kubectl checks only a flag's form there ([`applyOverrides`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/kubectl/pkg/kuberc/kuberc.go#L166-L223)), so kubectl in a proxy terminal can go to a cluster with the user's own credentials; `KUBERC=off` or `KUBECTL_KUBERC=false` turns kuberc off.
  - A startup file that sets `KUBECONFIG` replaces the terminal's in a shell other than zsh, bash, fish and pwsh, since an interactive shell reads it after Twigo set the variable, and that terminal's tab warns of it: a proxy terminal then reaches clusters with the person's own credentials, and a kubeconfig terminal is no longer pinned (without Twigo's files, macOS 27.2's `/bin/zsh -l -i` and `/bin/bash -i` with such a startup file and `KUBECONFIG` set printed the startup file's value, 2026-11-11).
    In those four Twigo sets it again once their startup files are done (4.6), and what runs after that can still set another, with the same outcome and no warning (with Twigo's files, macOS 27.2's zsh 5.9 as `/bin/zsh -i` under a `precmd`, a `.zshrc` that `exec`s bash or tmux 3.7c, and a typed `exec zsh` or `source ~/.zshrc`, and bash 3.2.57 and 5.3.15 under a `PROMPT_COMMAND`, each printed the person's value, 2026-11-11):
    - a startup file of zsh when an `/etc/zshenv` sets `ZDOTDIR`, which zsh reads before any `ZDOTDIR`, so the person's files run without Twigo's;
    - a startup file that `exec`s another shell or tmux, whose shell reads the person's files without Twigo's;
    - a prompt hook: zsh's `precmd`, bash's `PROMPT_COMMAND`, a function on fish's `fish_prompt` event ([event handlers](https://github.com/fish-shell/fish-shell/blob/4.2.1/doc_src/language.rst?plain=1#L2066-L2086)), and direnv's hook, which is one of those ([`shell_zsh.go`](https://github.com/direnv/direnv/blob/v2.38.2/internal/cmd/shell_zsh.go#L26-L29), [`shell_bash.go`](https://github.com/direnv/direnv/blob/v2.38.2/internal/cmd/shell_bash.go#L25-L31), [`shell_fish.go`](https://github.com/direnv/direnv/blob/v2.38.2/internal/cmd/shell_fish.go#L14)), when an `.envrc` exports `KUBECONFIG`;
    - a `source ~/.zshrc`, an `exec zsh` or an `export KUBECONFIG=…` typed later.
  - A tool that writes entries of its own into a proxy terminal's file gives that terminal the person's credentials for them, as running it in any terminal would: `aws eks update-kubeconfig` and `az aks get-credentials` write a cluster, a user and a context, and make it current, in the first file of `KUBECONFIG`, which there is the proxy's ([`choose_kubeconfig`](https://github.com/aws/aws-cli/blob/2.40.0/awscli/customizations/eks/update_kubeconfig.py#L232-L259), [`insert_cluster_user_pair`](https://github.com/aws/aws-cli/blob/2.40.0/awscli/customizations/eks/kubeconfig.py#L270-L299), [`aks_get_credentials`](https://github.com/Azure/azure-cli/blob/azure-cli-2.92.0/src/azure-cli/azure/cli/command_modules/acs/custom.py#L2044-L2056), [`merge_kubernetes_configurations`](https://github.com/Azure/azure-cli/blob/azure-cli-2.92.0/src/azure-cli/azure/cli/command_modules/acs/custom.py#L2203-L2209)), and `gcloud container clusters get-credentials` writes its entries to that file too ([reference](https://docs.cloud.google.com/sdk/gcloud/reference/container/clusters/get-credentials)).
    The terminal's tab names those contexts (4.6).

| Operation                                                                     | `read-write`                            | `guarded`                             | `read-only`                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| get, list, watch, logs, events, discovery                                     | ✓                                       | ✓                                     | ✓                                                                                                   |
| Reveal secret-grade data (3.6)                                                | ✓                                       | confirm                               | confirm                                                                                             |
| Port-forward                                                                  | ✓                                       | ✓                                     | ✓ unless `readOnly.allowPortForward: false`                                                         |
| exec, attach, ephemeral debug container                                       | ✓                                       | confirm                               | ✗                                                                                                   |
| create, apply, patch, update (dry-run diff always shown)                      | ✓                                       | confirm with the diff                 | ✗ (dry-run still allowed where kube-apiserver serves the group itself, so a change can be prepared) |
| delete, scale, rollout restart, cordon, drain, evict, Helm rollback/uninstall | ✓ with friction by blast radius (below) | typed confirmation (the context name) | ✗                                                                                                   |

- **Where the mode comes from**, highest first:
  1. a policy file entry, which the UI cannot change or unlock; of several that match, the strictest;
  2. no source lists the context now: `read-only`, since clients built before it went may still run and nothing says what it lets through;
  3. the person's choice for the context, which wins both ways: where it is less strict than the strictest lock below, its source names that lock as set aside (`user` with `overrides`);
  4. the strictest of the locks, each of which can only tighten, and of equal ones the first listed:
     - kubeconfig metadata, `twigo.readOnly` there and anything but `false`: `read-only`, while `false` says nothing;
     - the provider (Segla can mark production clusters), whose lock is `guarded` or `read-only`, never `read-write`;
     - the default of its environment type, the person's, else its kubeconfig's (`twigo.environment`) where that tightens: `read-only` for Production, `guarded` for Staging and `read-write` for Development and Local, which a kubeconfig cannot give, so Development or Local there is no lock and no mark;
  5. nothing marks it: `guarded`, source `unmarked`, until someone says what it is.

  The mode is read for every request, so a change reaches clients already built.
  The person's "no type" holds whatever the kubeconfig says, and with no other lock leaves the context unmarked again.

- **A context nobody marked** lets through what `guarded` does, reads, dry runs, Secret reads and port-forwards, and no actor's write or exec, the UI's included, whatever approval it carries: the gate refuses it as `unmarked`, and so a dry run to a group-version kube-apiserver may not serve itself, which the classification above takes for a write.
  Every unmarked context asks, local-looking ones included, as a server on `127.0.0.1` is often a tunnel to a remote cluster (Teleport's local proxy, SSH forwards), and so does one whose kubeconfig alone says Development or Local, which only a person can say.
  - A process's write or exec through the policy proxy raises an ask marked `unmarked`, which the person answers with a type or denies.
    A type marks the context, kept with the person's choices and recorded with the process, and the request meets the gate anew: it goes, asks again as `guarded` asks, or is refused in the gate's words.
    A denial leaves the context unmarked, so the next write asks again; "once" and "for 15 minutes" answer no unmarked ask, and a type answers no other.
    The ask is withdrawn, and its request decided again, when the context is marked another way meanwhile, as every ask is when its context's access changes, and so are the context's other unmarked asks once an answer marks it; a denial settles its own request alone.
  - Its terminals go through the policy proxy, as those of every context that is not `read-write` do; marking it Development leaves a running one there until it is opened again (4.6).

- **Changes of protection** are plans of the command bus (5.1): the person's mode, the type they mark a context as, and an unlock.
  They send nothing to a cluster, so a plan has no writes and no kubectl command, and each is refused at plan time where no source lists the context.
  Where the policy file sets the context's mode, a mode and an unlock are refused at plan time, and a type plans.
  The person's mode and type outlive every lock that can go: the policy file's entry, a kubeconfig's `readOnly`, a kubeconfig's type and a provider's lock, each of which an edit or the provider can take away on its own.
  So a lasting change is weighed under every set of those locks taken away, the person's choices kept and the empty set being the change as it is, a context unmarked under a set counting as `guarded` there.
  No lock then hides a lowering from the friction: neither a kubeconfig's type beneath its `readOnly` nor the person's mode cleared beneath a kubeconfig's type.
  The plan says what the change gives once locks go.
  Where it asks for the name though it lowers nothing as it is, it names, of the sets under which it lowers the context, the one that leaves the context least strict, and of those the smallest, so it says why it asks even where that set leaves the context as it is now, as an admin's `read-write` entry over a context nobody marked does.
  Otherwise it names, of the sets under which the change gives other than it does now, the one that leaves the context least strict, and of those the smallest.
  Rust names the friction from the context's access before and after, under each set:
  - a lasting change that leaves the context less strict under any set asks for the context's name typed, weighed against the mode it keeps, so an unlocked context counts as `read-only`;
  - a change that leaves the context unmarked weighs as one to `read-write`, since from there any change runs at once: from `read-only` or `guarded` it asks for the name typed;
  - an unlock asks in a dialog, as it ends by itself and leaves every write asking for the context's name;
  - a change that tightens or keeps the mode, and any change of a context nobody marked, runs at once: the question an unmarked context answers is its friction.

  A plan holds only while the context's access stays as it was planned: a choice, an unlock or its end, or a change of what the catalog says of the context meanwhile refuses it as a conflict and changes nothing.
  A relock (`context_relock`) only tightens and runs at once, and a plugin's trust (`exec_trust`) has its review for confirmation; both stay commands of their own.

- **Unlock for 15 minutes.**
  A plan switches a `read-only` context to `guarded` for a limited time, and a command that such a lock refused offers it in the toast that says so; a policy file's lock offers nothing.
  A banner shows the countdown, and the context relocks by itself.
  The gate reads the wall clock, as timers stop while the machine sleeps, and nothing stores an unlock, so a restart relocks.
  An unlock holds only while the context's fingerprint stays, so one given on a cluster never reaches another its name moves to, and a new choice or type ends it.
- **Clients keep to what they were built for.**
  Clients of a context that now names another cluster still reach the old one until their owner re-opens, so their gate reads them as `read-only` from the moment the fingerprint changes, whatever the new one's mode is.
- **Every blocked request** returns a typed `permissions` error with the mode and its source, and the UI shows which rule blocked it.
- **The audit log** is `audit.jsonl` in the app-data directory, mode 0600, a JSON line per event, which its `event` names:
  - `request`: a request the gate sends, just above the socket, or stops, with the actor, the context, its mode, the request's class and why it was stopped; a retry below the gate is noted again.
    Of an actor other than the UI it notes every class but a read: dry runs, writes, reads of a Secret, forwards and execs; of the UI, its writes, since the command bus notes what a person confirmed.
    The policy proxy notes, as the gate would, a request it stops itself on the policy's word before the request meets the gate: one its mode refuses or no answer can allow, one the person denied or no window could ask about (`noApproval`, or `unmarked` where the ask was what its context is, beside the ask's `approval` line), and one whose context names another cluster now (`read-only`, `mode`).
    A request whose unmarked ask a type answered meets the gate anew: the gate notes it as it goes, the proxy as the new mode refuses it, and an ask that `guarded` raises for it ends as any other.
    A request the proxy lets on meets the gate, which notes it, and one it refuses for another reason, a token, a `Host`, a path or a body's size, is no request the policy stopped and has no line.
  - `confirmed` and `ended`: a command a person confirmed through the command bus, through which friction, and how it ended: `done` or `stopped` with Twigo's own sentence as `message`, `failed` with the `codes` of the error and no message, since the server's message for a failed request can quote a value the person typed; a `stopped` command that had failed requests carries their `codes` too, and the window is told their words after the sentence.
  - `refused`: a command of a person's that the policy refused before anything was sent, at `command_plan` or at `command_execute`, or a port-forward's start or resume: its context, the command and target as `confirmed` names them, the mode and source the policy read, and why.
    That is the gate's reason for one of the command's writes, or the reason a change of protection was refused: the admin's policy file sets the mode, there is nothing to unlock, no source lists it, or it changed since the plan.
    A plan whose context asks for more friction now than the person went through is refused too, and its line carries both frictions, the plan's and the context's now.
    A port-forward's start or resume that the gate refuses, as `readOnly.allowPortForward: false` does, is the command `forward` on the target the person chose, with the gate's reason; a forward that the mode ends while it runs is no command refused, and has no line.
    One line per command, not per write.
    A refusal before the command read anything names its target from the request: a delete of three config maps is `3 configmaps in a`.
    A name typed wrong, a countdown not ended, a context that names another cluster than when planned, and a plan that is gone leave no line.
  - `approval`: how a process's ask through the policy proxy ended (above).
  - `protection`: a change of protection a plan made or an unmarked ask's answer gave, with what changed, the context's access before and after, a lock the person's mode sets aside in its source, and the friction it went through or the process, as an approval names it; that line alone, in place of the bus's `confirmed` and `ended`.
  - `catalog`: a change of a context's mode, source or type that no command made, with its access before and after, as the catalog publishes the read that made it, before anything reads that read: a kubeconfig edited, a provider's lock that came or went, a source that listed the context or stopped listing it.
    The catalog's first read is no change, and the policy file, read once as the app starts (4.8), changes nothing while it runs; a context that moves to another cluster keeps its mode, source and type, so only the end of its unlock is noted.
  - `relocked`: an unlock that ended by a relock, by its time, as the context named another cluster or none, or as Twigo met an error it cannot go on from (2.1).
  - `trusted`: a plugin a person trusted, by its digest and program, never its arguments or environment, which may hold tokens.

  The log names targets, never a value, so the actors of M3 only add their name.
  A file that cannot be opened is logged (4.10), listed as the problem `audit.off`, and keeps nothing: the log records, it guards nothing.
  Past 8 MiB the log moves to `audit.1.jsonl`, each older one up by one as far as `audit.5.jsonl`, whose last content goes, and a new `audit.jsonl` opens, each 0600: at most 48 MiB.
  A move that fails is logged at error (4.10) and the log goes on where it is, to try again after another 8 MiB.
  A new log that cannot be opened after the move is logged at error, its lines go on to `audit.1.jsonl`, and the next line tries again before anything else.
  A write that fails is logged at error too, once until a write succeeds.
  The older logs move only with the log, so a log gone from its place, as when a person deleted it, is opened anew and moves none of them.

- **How the UI shows a mode and asks before damage**, designed with the owner on 2026-11-03 ([research](research/workbench-design.md)), for M2:
  - Environment types, Production, Staging, Development and Local, set a context's colour and its default mode.
    Nothing guesses a type from a context's name: a context nobody marked is `guarded` and shows a quiet chip, `Not marked`, until someone says what it is (above), and only an admin's policy file sets modes by glob (4.8).
  - A production context is a mode with two cues (NN/g): a chip in the title bar after its name that says the type and the lock (`Production · read-only`), and the status bar tinted in it.
    Where the bar is too narrow the chip folds to its icon, its words in its tooltip, after the search and before the crumbs (4.1).
    The mockup's third, a 2 px line of its colour along the title bar's top, was dropped on 2026-11-07: the chip, the tint and the bar's left end in the context's colour already say it.
    The chip opens what set the mode, in words, with the choices the person has.
    Where the person's choice sets a stricter lock aside, a kubeconfig's `twigo.readOnly`, a provider's or the type's default, the words say which: `You set this, over its kubeconfig's read-only.`
  - The person lowers protection only through the command bus (5.1): the chip's choices, Set Context Mode…, Set Environment Type… and the toast's Unlock for 15 minutes plan a `setMode`, `setEnvironment` or `unlock`, and the operations service draws the friction the plan names and runs it.
    A lasting change that leaves the context less strict under any set of the locks that can go taken away asks for its name typed, clearing a type counting as a change to `read-write`, an unlock asks in a dialog, and a change that no such set shows lowering, or that starts from a context nobody marked, runs at once, with a toast that says what it did; a plan with no kubectl command shows no such line.
  - A write or an exec that meets a context nobody marked is refused with `unmarked`, and the operations service asks what the context is: a dialog of Production, Staging, Development and Local, each with what its type gives, and Cancel, which sends nothing.
    It plans `setEnvironment` with the answer, runs it, and plans the command again, which asks its own friction or is refused in the new mode, with the unlock offered where it may be.
    A process's ask for such a context asks the same question in the approval host, naming the process and what it asked to do, and answers `mark` with the type, or `deny`; the ordinary ask that may follow, as Staging gives, comes with its own question and the context's new type on its badge, so that it does not read as a repeat.
    An ask that arrives meanwhile waits behind the question, and behind the command's own confirmation that follows it, so none shows in between.
  - Friction grows with the blast radius (Primer), and the mode raises it; Rust names it in a command's plan and checks it before the plan runs (5.1):
    - scale, cordon and suspend run at once with an undo (⌘Z): for 30 s the space's last action, the one that started last, can be put back, refused once anyone else replaced or changed the object since.
      Status moves an object's resourceVersion every second (a scale's went 873 to 888 within 1 s on kind 1.37, 2026-11-08), so the undo holds to its generation instead, or for a node, which has none, to the `spec.unschedulable` it set, and its write carries the resourceVersion it checked;
    - scaling to zero, a rollout restart, a CronJob's trigger and a drain ask in a dialog that lists the pods that go or are replaced; a drain that meets pods kubectl refuses without `--force` or `--delete-emptydir-data` takes them too and asks for the node's name typed, since they and that data go for good;
    - so do the writes an undo could not put back whole, and their undos alike: fewer pods of a StatefulSet whose `whenScaled` is `Delete` take their claims and data, which the dialog lists, and suspending a Job that runs pods deletes them and their work; a CronJob's resume asks too, and the undo of its suspend, since the latest run it missed while suspended starts at once and no undo stops it, as k9s, Freelens and Argo CD ask before it (Headlamp holds it 5 s with Cancel, Rancher not at all; 2026-11-08); a CronJob's suspend, and a Job's that runs nothing, stay at once;
    - deleting a pod that its ReplicaSet, StatefulSet or DaemonSet replaces, outside production, sends after a 5 s toast with Cancel, as Headlamp holds it, and ⌘Z cancels it too; in production it asks in a dialog, and a Job's or a workflow's pod, which may not come back, asks in one everywhere;
    - deleting one object asks in a dialog that names the cluster in its question and lists what follows, with the equivalent kubectl command;
    - a namespace, a node or a CustomResourceDefinition asks for the object's name typed, and a delete of several objects for the context's, as `guarded` does;
    - an apply, whose diff the person has just read (6.5), runs at once in `read-write` and asks in a dialog in `guarded`;
    - a shell or an attach (4.6) runs at once in `read-write` and asks in a dialog in `guarded`, since a person opens them often and a typed name would only slow them, and `read-only` refuses it before anything is asked, as the table says;
    - in `guarded` every other write asks for the context's name typed, whatever it risks, and a Reveal asks in a dialog, as in `read-only`; in `read-write` a Reveal shows at once;
    - the confirming button names its action, `Delete namespace`, never Yes or OK.
  - Delete is ⌘⌫, never a bare key (4.4).

### 6.5 YAML apply: dry-run diff, then server-side apply

1. Open: `GET` the object.
   Show it without managedFields, with `status` read-only.
2. Build the apply configuration from **the fields `twigo` already owns plus the fields the user changed**, plus apiVersion, kind, name and namespace.
   - The owned set is extracted from the live object through the `twigo` entry in managedFields, as client-go's `Extract…` apply configurations do.
   - Why: a field that a later apply leaves out is removed, or reset to its default, when no other manager owns it.
     Sending only this edit's changes would undo the previous edit: a forced `replicas: 5` would fall back on the next annotation change.
   - Changed items of map-type lists are sent with their keys; atomic lists are sent whole.
     Which a field is comes from the kind's OpenAPI schema, read as the server converts it (3.6).
   - An array or object the edit sends whole is refused, on the apply and on the merge patch alike, when it holds a number of magnitude 2^53 or more (`Refusal::Inexact`), since such a number reached the webview rounded and a change to its neighbour would send it changed.
     The refusal names the paths and says the editor cannot carry an integer that large and kubectl can; a reload would show the same number, so none is offered.
     A changed bare scalar is what the person typed, and what Twigo owns comes from the live object exact, so both pass.
   - Applying the whole object would make Twigo a co-owner of every field.
     Fields that a GitOps tool later removes would then stay behind.
   - `status` where the resource has a status subresource, and the server's metadata, never enter it: an edit that changes them is answered with what was ignored.
   - A `twigo` entry at another apiVersion than the one opened: the server prunes it at the version it was written with, so where its paths do not reach the object at the version opened, the preview refuses rather than leave fields out and lose them.
3. Add the opened `resourceVersion` as an optimistic lock, passed apart from the base: "Keep mine" after a change on the server diffs against the old base and locks to the new version, since diffing against the new live object would revert the other writer's change.
   Add the object's `uid` too: an apply with a `resourceVersion` to a name nothing holds creates the object, so one deleted between the preview and the run would come back, a Secret with real values from the preview's memory; with a uid the server answers a conflict and creates nothing (kind 1.37, 2026-11-08), which is told as changed on the server.
   A status update moves it too, so where the resource has a `status` subresource only what such a write leaves alone says an object changed: `metadata.resourceVersion`, `generation`, `managedFields` and `status` are left out when comparing.
   The preview holds to the server's version when the two compare equal, comparing with what "Keep mine" locked to where that is not the base, and does itself over when a status write lands between its read and its dry-run, as many times as an undo does (6.4).
   A run that loses to a write that left the two equal reads the object and sends again as many times; there `managedFields` count, leaving out their `time` and the entries with a `subresource`, as a co-owner that arrived since the preview would make a removal silently not happen.
   Anything else answers **Stale**, or fails as changed on the server.
   A Secret has no such subresource, and its masked view cannot tell a changed value of the same size, so it stays strict.
4. Dry-run: `PATCH` with `Patch::Apply`, `PatchParams::apply("twigo")`, `dry_run`, and `validation_strict()` (kubectl's default; the server's is Warn).
   Use `Client::send` so `Warning` headers are kept, because kube-rs drops them.
   A field the typed conversion does not know, or a value it cannot convert, answers `500` rather than `422` (kind 1.37, 2026-11-08); it is reported as invalid input with the server's message.
5. Show live against the dry-run result in a Monaco diff.
   Both sides are cleaned of managedFields, and Secret data is masked.
   The diff includes defaults and webhook mutations, which a local diff cannot know.
   A preview keeps what it prepared in Rust for its window under an id, once, and the plan of that id sends exactly that.
   In `read-only` and in a context nobody marked, which refuse the UI's writes, an object of a group-version kube-apiserver does not serve itself is not previewed, as the gate takes its dry run for a write (6.4): the preview says that another server serves the group and may not honour a dry run, or that Twigo could not read whether one does, and sends no dry run.
6. Apply, by a bus plan that the person has just read the diff of: at once in `read-write`, a confirmation in `guarded`, blocked in `read-only`.
   Apply is offered for a diff that was shown, and again only when the plan of that preview has ended, since the engine plans a preview once.
   Under an admin's policy file the lock cannot be lifted, so Apply is not offered and the diff says why in the words of the context's chip; a read-only the person set refuses it as the gate does, and it works after an unlock.
   A `409 FieldManagerConflict` shows a table per field with the owning manager, and offers **Force** or **Drop my change**.
   Giving up every conflicting field can leave nothing to send, and the bar then says that, and that the YAML still holds the change.
   So can an edit of what the engine leaves out, as `status` is: the bar says that nothing is left to apply, names what was left out, and that the text still holds it.
   The plan takes the preview when it is made, once the gate has allowed it: a cancelled confirmation, a failed run and a stopped one end the preview and close its diff, while a plan the gate refuses, as in `read-only`, leaves it for an Apply after an unlock.
   The edit ends only if its text is still what the plan sent, so what was typed while it ran stays.
   An answer that arrives after the person went to another space, or that a newer preview or a clear replaced, opens no tab; the first stays with its editor, which offers to show it.
   A new manifest applied to another context than its own space's stays, as the person may apply it elsewhere too, and a toast names the kind and the name from the manifest, says whether the object was created or updated (the preview's `live` tells), and where.
   Its action selects that space, waits for its discovery, which follows the space shown only, and opens the object, or says that the context does not serve the kind.
   A manifest applied to its own space opens the object it made and closes its own tab, and the tabs of a plan that ended while the person was in another space close when that space is shown again.
7. A field the user deleted goes by the apply only when Twigo's Apply entry is its only owner.
   Another manager's or nobody's stays after an apply, so it needs a separate merge patch with `null`, shown as its own step in the diff.
   The patch is sent after the apply, on the `resourceVersion` the apply returned; a merge patch cannot address a list element, so a removal inside a list sends the outermost list whole, as it stands after the apply minus the removal, and nothing is sent when the dry-run already shows it gone.
   A `409` on that patch is another write, as the Deployment controller's revision annotation right after the apply (1 of 25 on localhost kind, 2026-11-08): it reads again, rebuilds from what the server holds now, and sends on that version, as a removal is idempotent and the lock keeps a rebuilt list from clobbering anyone.
   A configuration holds its list elements in the live object's order, new ones after them, as the server follows a configuration's order for the elements the two share.
   A map or a list element that a removal empties in the configuration stays there while the edit holds it, as the server deletes the whole of what an apply stops naming, the fields nobody owns in it included; it leaves only when another manager's hold keeps it on the server anyway: its member for an element or a map's key, and anything under it for a field the schema declares ([`EnsureNamedFieldsAreMembers`](https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/fieldpath/set.go#L133-L151)).
   Some edits no apply can express without owning what they do not change: a list's elements moved or one put before the end (the server places a new element before the next one the configuration shares with the object, but an edit moving elements names more of the list than the person changed), an element of a key held twice, changed or removed, or added by the edit, an edit whose apply or whose patch is validated with the old field still there and answers 422 (a Deployment changed to `strategy: Recreate` while another manager owns `rollingUpdate`, an env var from `value` to `valueFrom`, a `volumeMount` repointed while another manager's old volume goes) while the same object as one write is valid, a granular map or list the edit leaves empty, or a list losing Twigo's last element while the edit keeps one nobody owns.
   Server-side apply cannot say that a map or a list stays, empty: an empty list claims nothing ([`doList`](https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/tofieldset.go#L132-L147)), so as Twigo's only field under its parent it prunes the named chain above it with an unowned sibling and answers 200, and a map emptied by a prune is left null ([`removingWalker`](https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/remove.go#L171-L173)), which a CRD refuses with 422; a merge patch of the same edit leaves `{}` (kind 1.37, 2026-11-08).
   An atomic map or list is a value like any other, so an apply carries it empty and Twigo owns it.
   Those go by one JSON merge patch that carries the changes and the removals together, a list on the path whole, under field manager `twigo-edit`, as `kubectl edit` would, held to the `resourceVersion` and validated strictly, as an apply is, or a typo would be lost with only a warning; the preview says which strategy it is, so the diff can say so, and the plan's `kubectl` is that patch.
   A list that goes whole while the server holds it otherwise than the edit was opened with answers **Stale**: nothing can merge it, and "Keep mine" would revert the other writer.
   That answer says `keepable: false`, and the editor offers Reload alone; a `409` answers `keepable: true`.
   A conflict answers before validation does on the server, so a `409` is never routed here.
   It adds no field to the `twigo` Apply entry.
8. Immutable fields return 422; the dry-run catches this before any write.
   Delete-and-recreate is offered only for Pods and Jobs, with confirmation; the uid is held by a precondition, and what the Job controller generates, its selector and its `controller-uid` and `job-name` labels, does not go along.
   A Pod that a controller owns is not offered it, as the controller would replace it within seconds, so its message says to edit the owner.
   The body is dry-run as a `POST` before it is offered and again before the delete, so an edit that cannot be created never takes the object away: an invalid body answers 422 even with the name taken, and a valid one 409 AlreadyExists (kind 1.37, 2026-11-08).
   A namespace at its quota refuses that dry-run, as the old object still counts, so it gets no recreate and the message says why: losing the workload is worse than the person deleting and creating it by hand.
   The plan lists what goes with it, a Job's pods, and says a Job runs again.

Destructive actions (delete, drain, scale to 0) list the exact objects and need a confirmation that matches the policy mode.
Their plans read the objects and what the garbage collector takes with them (every object whose owners all go, among what the core's controllers make) and send nothing before the confirmation: a server dry-run of a DELETE or an eviction is a write to the gate, which reads no body (6.4), and a fault in that body would delete unconfirmed.

### 6.6 MCP server and agents (D5)

**MVP: Twigo is an MCP server** (`twigo-mcp`, on rmcp).

- **Transport.**
  The primary path is a stdio shim, `twigo mcp`, which reaches the running app over a per-user socket (0600) or a named pipe.
  A Streamable HTTP endpoint is optional: `127.0.0.1:<random>/mcp` with a per-client pairing token and Origin and Host checks; it never binds `0.0.0.0`.
- **Setup.**
  A "Connect an agent" command shows a one-click snippet for Claude Code, Cursor and VS Code.
- **Grants per client and context.**
  `none` (the default), `read`, or `read + approved writes`.
  A context's policy mode caps the grant, so read-only contexts are always `read` at most.
  `read` includes dry-run.
  Enforcement is by request class in the policy layer, not by hiding tools.
- **Sessions.**
  MCP's 2026-07-28 revision has no protocol-level session, so Twigo defines one: the lifetime of one `twigo mcp` shim process, or a pairing token with a TTL on HTTP.
  Approval scopes, the untrusted-content rule and the audit log are all keyed on it.
- **Tools in the MVP are read-only:**
  - list (Table rows), get (redacted), events;
  - logs (bounded by bytes, lines and time window);
  - describe-style summaries: the Overview document as text (4.3);
  - a dry-run diff of a proposed manifest.

  Approved writes come in v1.x.

- **Approvals happen in Twigo's own UI**, never in the agent client.
  - The prompt shows context, verb, GVK, name and the server-side dry-run diff.
  - Scopes: once, this session, this object for N minutes, or (for `secret-read`) this session and namespace.
    There is no "always" scope, and "this session" never covers deletes (6.4).
  - When the UI cannot ask, the answer is deny.
- **Untrusted content.**
  Logs, events, annotations, ConfigMaps, CR status and Helm values are marked with their source and capped in size.
  Once a session has read untrusted content, every write, exec-class request, `secret-read` and gateway call needs a fresh approval for that call, in any mode (after Meta's "Rule of Two").
  A gateway server can send data out to a third party, and its output counts as untrusted content too.
- **Secrets.**
  Tools return only keys and sizes.
  Helm values are secret-grade, because they often carry credentials: agents get them masked.
  Patterns for JWTs, PEM blocks, cloud keys and kubeconfig credentials are redacted in tool output.
  There are no exec, attach or port-forward tools.
- **Audit.**
  An append-only JSONL log records: timestamp, client and pairing ID, session, context, verb, GVK, name, argument hash, approval, diff hash, result size and redactions.
  The Agent activity panel shows it.
  Requests carry a distinct User-Agent, so they stand out in the cluster's audit log.

**v1.x: the MCP gateway for extension servers.**

- MCP servers contributed by extensions are re-exposed through Twigo's own endpoint, to every MCP client: external agents and, later, the ACP panel.
  Provider tokens stay in Rust.
- It covers remote (`url`) servers.
  Local stdio servers need tier-3 processes and arrive with them.
- Grants work per contributed server and per client: `none` (the default), `read` (tools annotated read-only), or `approve` (every call goes to the approval broker).
  The server's annotations are untrusted unless the user trusts the extension.
- Every call is audited like Twigo's own.
  The kube policy layer cannot see what such a server does with its provider's API, and the grant prompt says so.

**Later: the agent panel over ACP** (Agent Client Protocol, used by Zed and JetBrains).

- Twigo runs an agent the user already has (Claude Code, Codex, Gemini CLI) as a process, after consent.
  - It passes the agent its own MCP endpoint, which includes the gateway's tools.
  - Twigo shows the agent's permission requests in its own UI.
- **Honest limit.**
  Twigo's policy binds Twigo's tools.
  An agent's own shell tool runs as the user, and the agent's permission system governs it.
  Twigo's mitigations:
  - the agent's `KUBECONFIG` is the policy proxy's (6.4), so kubectl run by the agent obeys the context's mode;
  - the agent can still read `~/.kube/config` or pass `--kubeconfig`.
    The panel says so: this is a mitigation, not a boundary.
- Twigo has no LLM client and stores no model keys (D5).

### 6.7 Webview and supply chain

- **CSP.**
  Strict, no remote URLs.
  `worker-src` is not set, so Monaco's and monaco-yaml's workers load under its fallback to `script-src 'self'` ([CSP3](https://www.w3.org/TR/CSP3/#directive-worker-src)): each is a Vite `?worker` file served from the app, and `blob:` would widen what can run for nothing that needs it.
- **Rendering.**
  Cluster data is rendered as text, never as HTML, so an annotation cannot inject markup.
  An XSS in the webview would reach every cluster.
- **Tauri.**
  Capabilities are scoped per window label, and commands are allowlisted through `AppManifest::commands`.
  The isolation pattern stays off: its hook would repeat checks that Rust makes at the boundary, page scripts can call commands without required arguments past it, and its frame's scheme changes with every build, so the app would have to add it to `frame-src` at startup ([isolation spike](spikes/tauri-isolation.md)).
- **Secrets in the webview.**
  Tokens, certificates and Secret values never reach it, except for a Secret value the user explicitly reveals.
- **Tier-2 frames.**
  - They get an opaque origin and cannot read Tauri's per-run invoke key.
    The key is all that keeps them out: WebKit gives them the page's message handler, and Tauri cannot tell their requests from the window's on Linux, nor from the app's on either platform.
  - The M0 spike showed on WebKitGTK and macOS that such a frame invokes nothing, and CI repeats the probe on every Tauri and wry update and weekly ([isolation spike](spikes/tauri-isolation.md)).
  - No frame gets `allow-same-origin`, and the host relays only data, from messages whose `event.source` is that extension's frame.
  - The page's CSP lists `twigo-ext:` in `frame-src`; Windows serves custom schemes as `http://<scheme>.localhost` (`https://` with `useHttpsScheme`) and needs that form.
- **Releases.**
  - Signed updater artifacts (minisign, new key).
  - macOS notarization; Linux AppImage, deb and rpm.
    Flatpak is excluded, since exec plugins are host binaries.
  - `cargo deny`, `pnpm audit`, an SBOM per release.

## 7. Scope and risks

### 7.1 MVP: first public beta, macOS + Linux

| Area          | In the MVP                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog       | Kubeconfig source (several files, live reload), kubeconfig metadata, one-context spaces, per-context settings and policy                                                                                                                                                                                |
| Auth          | Login-shell environment, the credential runner with interactive sign-in panel, kubeconfig trust, OIDC, certificates, proxies                                                                                                                                                                            |
| Explorer      | Every built-in kind from Lens's list plus CRDs from discovery. Table watches, namespace scope (multi-select), label and text filters, wide columns                                                                                                                                                      |
| Editors       | Overview (core kinds plus generic), YAML with OpenAPI schemas, dry-run diff and SSA apply with conflicts, Events, Related (owners and children), Compare with…, new manifest                                                                                                                            |
| Actions       | Delete, scale, rollout restart, cordon, uncordon, drain, CronJob trigger, Job suspend                                                                                                                                                                                                                   |
| Sessions      | Pod logs, exec and attach, the policy proxy for child processes, the port-forward manager (pod, Service and workload targets, whose pod is taken again when it leaves, port-forward tabs and one status-bar entry with a count, persisted per space), integrated terminal pinned to the space's context |
| Workbench     | Parts, spaces, quick access with every prefix, command/menu/context-key/keybinding services, keybindings editor, settings UI with layers and policy, notifications, light and dark themes                                                                                                               |
| Metrics, Helm | metrics-server CPU and memory in tables and the node/pod overview; Helm releases **read-only** (list, values, manifest, history, notes), decoded natively from release Secrets; values and Secret objects in manifests are secret-grade (3.6)                                                           |
| AI            | MCP server with read-only tools, grants, redaction, audit                                                                                                                                                                                                                                               |
| Release       | Auto-update, signing, notarization, the performance budgets checked in CI                                                                                                                                                                                                                               |

### 7.2 Later (rough order)

1. **Windows** (D2): WebView2, Authenticode signing, the registry environment, `CREATE_NO_WINDOW` for exec plugins, and the tier-2 frame probe of `bench/ipc` on WebView2.
2. **More resources and sessions:**
   - multi-context spaces with merged tables;
   - Helm upgrade, rollback, uninstall and install through the `helm` CLI and the policy proxy;
   - changes that an agent proposes over MCP and the person applies (D15).
3. **The agent panel over ACP.**
4. **Deeper views:**
   - Prometheus charts with auto-detection;
   - RBAC "who can" and effective permissions;
   - a resource graph;
   - Gateway API views;
   - node shell and debug containers.
5. **Windows and access:** detached editor windows; hosts-file aliases for port-forwards (needs a privileged helper); Cluster Inventory `ClusterProfile`; MDM policy; accessibility audit.
6. **Extensions** (D3, D4), last by D14:
   - tiers 0 and 1, the WIT API at `0.x` (unstable; release builds load allowlisted IDs only), cluster providers and the fixture extension; private at first, with the Segla extension as the first consumer and no public registry yet;
   - the public extension API: the WIT freezes at `1.0`, plus the registry, tier 2 frames, tier 3 processes (including actions) and the k9s `plugins.yaml` importer;
   - built-in extensions: Flux, Argo CD, cert-manager, and NATS (D1);
   - the MCP gateway for remote servers that extensions contribute.

### 7.3 Key risks

| Risk                                                                                                                            | Impact                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One HTTP/2 connection carries every request, watch and log of a cluster                                                         | A dead or slow connection stalls them all; streams wait once 100 are open | Keep-alive pings; the connection is retired on wake, on a network change that moves its route and when a probe fails; one stream counter per context, below every actor, keeps watches, logs, proxied streams and requests within budgets that add up to the default limit of 100, and shows `queued`; the hub reads every stream at once (3.2, [HTTP/2 spike](spikes/http2.md)). |
| Table watch edge cases: columns only in the first event, conversion fallbacks, aggregated APIs without Table, frozen date cells | Wrong or missing columns                                                  | Decoder conformance tests against kind 1.33 to 1.37 plus aggregated API fixtures; fall back to metadata columns.                                                                                                                                                                                                                                                                  |
| WebKit and WebKitGTK performance (virtualized tables, Monaco, WebGL context loss)                                               | Linux feels slower than macOS                                             | The budgets run on macOS for now; the release work brings them to Linux and CI. DOM fallback for xterm; Monaco loads lazily.                                                                                                                                                                                                                                                      |
| Component-model maturity (WASI 0.3 async is new; jco output is large; TinyGo limits)                                            | Extension authoring friction                                              | The host drives async through imports; the Rust SDK comes first; TS SDK after the API freeze; the Segla extension proves the model before it opens.                                                                                                                                                                                                                               |
| Exec auth diversity: device code, browser, Teleport, Pinniped, SSO chains                                                       | "Can't connect" in the first minute                                       | A test matrix with EKS, GKE, AKS, kubelogin (all modes), oidc-login and Segla; interactive classification; a visible sign-in panel.                                                                                                                                                                                                                                               |
| Sandboxed-frame IPC isolation on Linux                                                                                          | A malicious tier-2 frame invokes commands                                 | The M0 spike showed that a sandboxed frame invokes nothing on WebKitGTK and macOS, and CI repeats it on every Tauri and wry update ([isolation spike](spikes/tauri-isolation.md)); frames never get `allow-same-origin`, and the relay passes only data.                                                                                                                          |
| Prompt injection through cluster text; approval fatigue                                                                         | An agent causes a write                                                   | Read-only MCP in the MVP; the rule of two; approvals in Twigo's UI with a diff; audit.                                                                                                                                                                                                                                                                                            |
| Scope: chasing Lens's list feature by feature                                                                                   | A late, shallow MVP                                                       | The MVP list above is the contract. Everything else waits for v1.x.                                                                                                                                                                                                                                                                                                               |
| Extension API churn after third parties adopt it                                                                                | Broken extensions (the Lens history)                                      | `0.x` stays private until 1.0; versioned WIT with every old binding kept; the fixture extension in CI.                                                                                                                                                                                                                                                                            |
| Corporate networks: proxies, `NO_PROXY`, SOCKS bastions                                                                         | Works at home, fails at work                                              | No local proxy in the UI path; our connector picks proxies as kubectl does, `NO_PROXY` included (6.3); live tests through an HTTP CONNECT and a SOCKS5 proxy.                                                                                                                                                                                                                     |
| Measuring memory wrongly on macOS                                                                                               | False confidence                                                          | The bench counts the WebKit processes and judges their resident size, since their footprint misleads (3.8).                                                                                                                                                                                                                                                                       |

### 7.4 Milestones

- **M0, foundation.**
  - Repository, crates and packages; IPC codegen and the mock backend; the design system ported.
  - The workbench skeleton: parts, spaces, the command, keybinding and context-key services, quick access.
  - The kwok bench.
  - Spikes: HTTP/2 connector, Table decoder, tier-2 isolation on WebKitGTK, the Tauri isolation pattern's cost.
- **M1, read path.**
  Catalog, environment, credentials, discovery, the watch hub with every upstream kind, explorer tables, resource editors (read), logs.
  Budgets green at 5k pods.
- **M2, write path and sessions.**
  Policy and the policy proxy, the dry-run diff and apply, actions, exec, port-forward, terminal, metrics, Helm read.
- **M3, MVP beta.**
  MCP server, settings UI, keybindings editor, auto-update, signing, documentation.

## Appendix: references

Facts were checked on 2026-10-31 against sources or docs.
Versions: kube 5.0.0 and k8s-openapi 0.29 (rechecked on 2026-11-07), Tauri 2.12.5, wasmtime 50, Kubernetes 1.37.

- kube-rs:
  - https://github.com/kube-rs/kube/tree/5.0.0 (HTTP/1.1 only: `kube-client/Cargo.toml`; exec auth: `kube-client/src/client/auth/mod.rs`; WebSocket protocols: `kube-client/src/client/upgrade.rs`)
  - https://docs.rs/kube/5.0.0/kube/runtime/watcher/struct.Config.html
- Kubernetes:
  - Table fetches: https://kubernetes.io/docs/reference/using-api/api-concepts/#table-fetches
  - Server-side apply: https://kubernetes.io/docs/reference/using-api/server-side-apply/
  - Feature gates (WatchList, WebSocket gates): https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/
  - Kubeconfig exec risk: https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/
  - `kubectl diff`: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/cmd/diff/diff.go
- Tauri:
  - Events vs channels: https://v2.tauri.app/develop/calling-frontend/
  - Capabilities: https://v2.tauri.app/security/capabilities/
  - Isolation pattern: https://v2.tauri.app/concept/inter-process-communication/isolation/
- VS Code:
  - Source: https://github.com/microsoft/vscode/tree/1.144.0/src/vs (`platform/commands`, `platform/actions`, `platform/contextkey`, `platform/keybinding`, `platform/quickinput`, `workbench/services/editor/common/editorResolverService.ts`, `platform/shell/node/shellEnv.ts`)
  - Extension runtime security: https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
- Zed: https://zed.dev/docs/extensions/capabilities, https://github.com/zed-industries/zed/tree/v1.26.2/crates/extension_api/wit
- Lens:
  - Licensing and login: https://docs.lenshq.io/faq/subscription-and-licensing/
  - Login wall: https://github.com/lensapp/lens/issues/5444
  - Exec plugin PATH: https://github.com/lensapp/lens/issues/7956
  - Extensions in 2026.10: https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2026-10-51501/
- Freelens: https://github.com/freelensapp/freelens/tree/v2.0.0 (release notes; `kube-object.store.ts`, `cluster-frame-handler.ts`, `compute-unix-shell-environment.injectable.ts`)
- Headlamp:
  - https://github.com/kubernetes-sigs/headlamp/tree/v0.46.0 (`docs/development/architecture.md`, `app/electron/runCmd.ts`)
  - Exec plugins at first launch: https://github.com/kubernetes-sigs/headlamp/issues/7879
- k9s: https://github.com/derailed/k9s/tree/v0.51.0 (`internal/watch/factory.go`, `internal/config/plugin.go`, `internal/view/env.go`)
- JET Pilot: https://github.com/unxsist/jet-pilot/tree/v2.2.3 (`src-tauri/src/watch/`, `src-tauri/src/auth/`, `src-tauri/src/env_import.rs`, `src-tauri/src/port_forward/`)
- Aptakube: https://github.com/aptakube/aptakube/issues/499, /575, /384; context extension: https://aptakube.com/docs/context-extension
- srelens (macOS memory measurement): https://github.com/srelens/srelens/blob/2194e83ec53e/docs/PERFORMANCE.md
- MCP security: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http, https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/, https://ai.meta.com/blog/practical-ai-agent-security/
- Kubernetes MCP server (a reference for its toolsets and read-only mode): https://github.com/containers/kubernetes-mcp-server/blob/v0.1.1/docs/configuration.md
