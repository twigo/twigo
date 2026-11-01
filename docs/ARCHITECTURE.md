# Twigo architecture

Twigo is an open-source desktop IDE for Kubernetes: native, fast and keyboard-first.
It aims to match Lens feature for feature without its login wall, its weight or its slowness on large clusters.
This document fixes the architecture; the M0 spikes in `docs/spikes/` correct it wherever they measured otherwise.

- Status: M0 in progress, steps 1 to 5 done, steps 6 and 7 in review, 2026-11-01
- Stack: Tauri 2 (2.12.x), Rust with kube-rs (4.2.x, k8s-openapi 0.28), React 19 + TypeScript, Tailwind 4, shadcn/ui, pnpm monorepo
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
| D7  | Lists come from server-side Table watches (`as=Table`, `includeObject=Metadata`). Metadata-only watchers serve only as indexes (namespaces, owners, CRDs). The full object is fetched when it is opened.                                                     | **This replaces the brief's "metadata-only watchers for lists"**: `PartialObjectMetadata` has no Ready, Status, Restarts or Node. Section 3. |
| D8  | Good design is a requirement. The legacy design language (tokens, density, restraint) carries over.                                                                                                                                                          | Section 4.9.                                                                                                                                 |
| D9  | Licence: Apache-2.0.                                                                                                                                                                                                                                         | A patent grant for contributors and extension authors, and the CNCF default. `LICENSE` sits at the repository root.                          |
| D10 | Bundle identifier `io.twigo.ide`. The repository and its releases live at github.com/twigo/twigo, which replaced the legacy repository.                                                                                                                      | A new updater key; the endpoint stays that repository's `latest.json`. Section 1.                                                            |
| D11 | Extension manifests are `extension.json`, checked against a published JSON Schema.                                                                                                                                                                           | Validation and completion in any editor. Section 5.4.                                                                                        |
| D12 | Kubernetes 1.33 and later. 1.32 left upstream support on 2026-02-28 and will be out of date by the time Twigo ships; older releases come back only if users ask.                                                                                             | The test matrix runs from 1.33 to the newest release kind ships. Section 3.2.                                                                |

### 0.2 Principles

1. **Performance is the product.**
   Watch only what is visible and keep full objects out of lists.
   The backend batches its changes and the frontend renders only the visible rows.
   Budgets are numbers that CI checks (section 3.8).
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

### 0.3 What the other clients teach

The sources are in the appendix.

| Their problem                                                                                                                                           | Seen in                                            | Twigo's answer                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login wall, paid tiers for basics (hotbar, MCP, extensions), closed source                                                                              | Lens since 2023                                    | Apache-2.0, no account, every core feature free (0.2)                                                                                                         |
| Full list of every kind with no `limit`; one watch per namespace; a full app instance per open cluster (iframes)                                        | Freelens / OpenLens                                | Shared, ref-counted Table watches per GVR and scope (per namespace, widened above 4 namespaces); one webview; per-cluster budgets (3.2)                       |
| Unbatched global events per watch event; full snapshot per change; merge on the UI thread                                                               | Kubeli, srelens, Aptakube                          | Rust coalesces, sorts and windows; one Channel per view; acks for flow control (3.5)                                                                          |
| Hangs with "All namespaces" on 30k pods; freezes on big ConfigMaps; eager metrics on huge lists                                                         | Aptakube #499, #575                                | Rust owns sort, filter and window; metrics only for visible rows; large values rendered lazily (3.4, 3.6)                                                     |
| Exec plugins not found from a Dock launch; kubelogin re-run every 30 s, opening browser tabs; device codes lost; plugins run for every context at start | Lens #7956, Headlamp #7879, Freelens < 2.0         | Login-shell environment, a credential runner of our own with timeout, single-flight, backoff and visible prompts; connect only on space activation (6.1, 6.2) |
| Empty views after a fixed cache-sync timeout                                                                                                            | k9s PR #4023                                       | Typed view states: `syncing / ready / relisting / forbidden / unauthorized / error` (3.7)                                                                     |
| Port-forwards tied to one pod; no failover behind a Service; random pod names restored                                                                  | k9s, Aptakube #384, #519                           | Forward targets are Services or workloads, resolved through EndpointSlices on every new connection (4.6)                                                      |
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
| `ErrorBoundary`, `PanelBoundary`, `store/zoom.ts`, `store/commandHistory.ts`, `lib/updater.ts` + `store/updateCheck.ts`, `shell/menu.ts` (native menu built from commands), `lib/appVersion.ts`                                                                                 | `packages/workbench`                    | `menu.ts` changes: it is built from the menu registry (5.1), not a hand-written list.                                                                                                                                                                                                           |
| Typed IPC errors: Rust `Error::kind` + TS `IpcError` (`lib/api.ts`, `nats/error.rs`)                                                                                                                                                                                            | `crates/twigo-ipc`, `packages/protocol` | Error kinds are generated from Rust instead of written by hand.                                                                                                                                                                                                                                 |
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
| `lib/persist-storage.ts` (tauri-plugin-store)                                                            | Settings files + state store (4.8)                                                | Settings are user-editable JSONC files with layers. UI state (layouts, history) stays in the store.                                                                                                                                                         |
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
│                                                                                       │
│ twigo-core      spaces · settings · catalog · command bus · approval broker · state   │
│  ├─ twigo-kube      kubeconfig source · client factory · credential runner            │
│  │                  discovery + OpenAPI cache · operations (apply, scale, drain…)     │
│  │                  └─ policy layer (tower) ◄── twigo-policy: modes · proxy · audit   │
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
A tokio task that panics does not take the process down.
A wasmtime trap ends the extension call, not the app.
Each webview is already a separate OS process managed by the system.
The only extra processes Twigo needs are the ones it must run anyway: exec plugins, shells, native helpers and agents.

**Multiple windows.**
One core process serves every window.
Subscriptions are keyed by `(window, view)`, so closing a window drops its watches.
Detached editor windows (VS Code's auxiliary windows) come after the MVP.

### 2.2 Repository layout

```
twigo/
├─ apps/desktop/              Tauri app: thin glue; src-tauri only wires crates into commands/channels
├─ crates/
│  ├─ twigo-core/             app services: spaces, settings layers, catalog, command bus, approvals
│  ├─ twigo-kube/             contexts, client factory, credential runner, discovery/OpenAPI cache, operations
│  ├─ twigo-cache/            watch hub (upstreams, row stores, query views, batching)
│  ├─ twigo-sessions/         logs, exec/attach, port-forward manager, pty terminal
│  ├─ twigo-policy/           read-only modes, authorize(), policy proxy, approvals, audit log, redaction
│  ├─ twigo-env/              login-shell environment resolution
│  ├─ twigo-ipc/              protocol types (serde) + TS codegen (ts-rs); channel framing
│  ├─ twigo-keyboard/         active keyboard layout and its changes, from TIS, xkbcommon and ToUnicodeEx
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
- `twigo-policy` sits under everything that can reach a cluster.
- `twigo-keyboard` keeps the OS's keyboard APIs out of `apps/desktop`.
  It needs no Tauri, and its tests read named layouts without a window.

`apps/desktop/src-tauri` holds no domain logic.
It translates Tauri commands and channels into calls on `twigo-core`.

### 2.3 Frontend packages

| Package              | Owns                                                                                                                                                                                       | May import                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `packages/ui`        | Tokens, primitives (shadcn/Radix), table and tree primitives, toasts (`notify`), empty, loading and error states                                                                           | —                             |
| `packages/workbench` | Layout parts, contribution registries, command, menu, keybinding and context-key services, quick access, the toaster and notification centre (4.7), settings UI, spaces UI, editor service | `ui`, `protocol`              |
| `packages/kube`      | Every Kubernetes view and editor; registers into the workbench registries                                                                                                                  | `ui`, `workbench`, `protocol` |
| `packages/protocol`  | Generated request and response types, a channel client with seq/ack, and a **mock backend** that runs the UI in a plain browser on fixtures (design reviews, component tests)              | —                             |
| `packages/utils`     | Pure helpers without React or IPC, such as formatters                                                                                                                                      | —                             |
| `apps/desktop/src`   | Bootstraps the workbench and registers `kube`                                                                                                                                              | all                           |
| `apps/desktop/bench` | The bench mode's entry and driver, built only by `vite build --mode bench` ([bench](bench.md))                                                                                             | all                           |

Every package may import `utils`.
The ESLint boundary rule from legacy now enforces the whole table; above all, `workbench` must not import `kube`.
The workbench only learns about Kubernetes through registries.

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
RowStore  uid → Row { meta-lite (name, ns, uid, rv, labels, owners, created), cells[] }
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

- **One upstream per `(context, GVR, scope, server-side selectors)`, shared by every view.**
  Subscribing increments a reference count.
  When the last subscriber leaves, the upstream lingers for 60 s so going back and forth costs nothing, then it stops.
- **Watch only what is visible.**
  - A subscription lives as long as its view or editor is visible.
  - Background tabs and inactive spaces unsubscribe.
    Their upstream lingers, then stops.
  - Coming back resumes from the last `resourceVersion`, or relists on `410 Gone`.
- **Scope follows the namespace selection.**
  - One upstream per selected namespace, so looking at 200 pods in one namespace never watches the cluster's 50k.
  - "All namespaces", or more than a few selected namespaces (default 4), switches to one cluster-wide upstream, if the user may list the kind cluster-wide (one SelfSubjectAccessReview, cached per space).
    Rust then filters by namespace.
  - Hysteresis: while a cluster-wide upstream lingers, it keeps serving narrower selections, so toggling back and forth costs nothing.
  - Users who may not list namespaces type them in.
    The context's default namespace is preselected.
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
      Actors other than the UI may hold at most 20 of them, so an agent's lists cannot starve the UI.
  - A watch, log or request over its budget waits in the counter and shows `queued`.
    The proxy's class refuses instead, with the `429` of 6.4.
  - Timeouts start when the counter admits a stream.
    A per-request timeout, a tower layer rather than a socket read timeout, backs the counter up against a server with a lower limit.
  - Sessions, meaning exec, attach and port-forward connections, have their own budget (default 64), counted in the same place below every actor.
    A session's permit outlives the `101` response, which `hyper::upgrade::on` drops: the upgraded stream holds it, and so does the policy proxy's splice.
    A proxied upgrade over the budget gets the proxy's `429` instead of waiting (6.4).
  - A proxy or server that answers HTTP/1.1 turns every stream back into a connection; the budgets stay the same.
    Benchmarks tune each of them.
  - When the watch budget is full, the least recently used idle upstreams are evicted.
    When nothing is idle, the new subscription waits in the state `queued` and its view says why.
  - When the log or session budget is full, a new log stream, exec session or port-forward connection waits in `queued` the same way.
    Its tab says why, and the status bar lists open sessions so the user can close some.
  - Nothing fails silently.
- **Dead connections.**
  kube 4.0 removed the global read timeout, and a watch can stall silently after sleep or a network change.
  - Every watch sets `timeoutSeconds` and uses TCP keepalive.
  - The HTTP/2 connection sends keep-alive pings, while idle too, since one dead connection now stalls every watch of the cluster.
    A failed ping closes it.
  - A request whose stream ends with the server's GOAWAY is retried once: the server never processed it.
  - An idle timer expects an event or a bookmark every couple of minutes.
    When it fires, a probe request goes over the shared connection first.
    If the probe answers, only that upstream re-watches.
    If it fails, the connection is retired and every upstream re-watches, as on wake.
  - On wake from sleep or a network change (OS notifications), the cluster's HTTP/2 connection is retired and every upstream re-watches.
    Retiring poisons the connection: the pool keeps a dead connection that still looks open, and every actor's client holds a clone of that pool, so rebuilding one client would not reach the others.
  - After every client rebuild and every new connection, one request goes out before any watch opens.
    A cold client opens one TCP and TLS connection per concurrent first request and keeps only the first that negotiates `h2` ([HTTP/2 spike](spikes/http2.md)).
  - Views show `stale` while this happens.
- **Initial list.**
  - Streaming lists (`sendInitialEvents=true`) on 1.34 and later.
    The WatchList gate is off in 1.33, and kube-rs has no fallback.
  - Otherwise a paginated list followed by a watch from its exact `resourceVersion`.
  - The capability is probed once per cluster and cached.
- **Backoff.**
  UI-friendly: 0.5–5 s with jitter, reset on every event.
  kube-runtime's default of 0.8–30 s leaves lists stale for a long time after an API-server restart.

### 3.3 Three upstream kinds

| Kind         | Request                                                                                                                                                                                 | Used for                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Table**    | `GET …?watch=true&allowWatchBookmarks=true&includeObject=Metadata` with `Accept: application/json;as=Table;v=v1;g=meta.k8s.io, application/json`, read through `Client::request_stream` | Every list, for built-in kinds and CRDs alike. The server computes the columns, the same as `kubectl get -w`.                    |
| **Metadata** | `Api<PartialObjectMeta<K>>` + `watcher`, with managedFields cleared                                                                                                                     | Indexes: namespaces (for the picker), CRDs and APIServices (discovery invalidation), and owner references for the "Related" tab. |
| **Object**   | `GET` + `watch` with `fieldSelector=metadata.name=…`                                                                                                                                    | An open editor: live YAML, overview, conflict detection.                                                                         |

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
- Age cells and CRD `date` columns are strings frozen when encoded ("5m").
  Rust recomputes Age from `creationTimestamp`.
  An Age column is the one named Age that prints `creationTimestamp`, built in or as a CRD printer column.
  Other date columns refresh on every modify event.
- Every server built on `k8s.io/apiserver` implements Table, aggregated ones such as metrics-server included.
  A server that does not answers through the JSON fallback with raw objects, which get the metadata columns, Name and Age; the namespace comes from meta-lite, as for every kind.
- Some objects have no uid or resourceVersion: ComponentStatus, and metrics-server's metrics.
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

A Table row takes about 700 bytes, half of a `PartialObjectMeta<Pod>` without managedFields.

### 3.4 Query views: Rust sorts, filters and windows

The frontend never holds the full list.
A subscription carries a `ListQuery { space, gvr, namespaces, labelSelector, text, columns, sort, groupBy, values }`.
The webview then sends `setWindow(start, end)` as the user scrolls, covering the visible rows plus about two screens of overscan.

- Rust keeps an incremental ordered index per query view.
  - Cells carry their column type, but many core columns are formatted strings: Pod Ready `1/2`, Restarts `3 (5m ago)`, Age.
  - Rust derives sort keys: known formats are parsed (ratios, leading counts, durations, Age from `creationTimestamp`), and other strings sort naturally.
- A change set updates the index in O(log n) per row and computes what changed **inside the window**.
- Text filter: substring or fuzzy match on the columns the table shows, Name among them.
  `columns` carries the user's choices by name, and Rust resolves them against its own columns, so the first batch already filters right and a choice for a column the list lacks, such as Namespace under one namespace, does nothing; without choices the columns of priority 0 count.
  `/!` negates; a regex can be given explicitly, k9s style.
- Values keep the rows whose column holds one of them, such as a pod's Status in CrashLoopBackOff or Error.
  `groupBy` counts the rows before values drop any, so a filter by health keeps every health's count.
- Multi-context spaces: the query view merges the upstreams of several contexts and adds a Context column.
  Row identity is `context/namespace/name`.
- Selections and bulk actions refer to row IDs, so "select all 5,000" never ships 5,000 rows.

This scales to 50k rows.
Shipping every row would cost about 15 MB of JSON, plus a sort on the UI thread after every batch.

### 3.5 Batching and flow control

- One Tauri `Channel` per subscription.
  Channels deliver in order.
  Payloads over 8 KB travel via the `ipc://` fetch path, not `eval`.
  Global events are used only for rare notices: catalog, settings, policy prompts.
- Coalescing by uid inside a flush window:
  - the latest version wins;
  - a delete wins;
  - add followed by delete sends nothing;
  - add followed by modify is sent as add.
- Flush every 50 ms on a tokio interval (`MissedTickBehavior::Skip`), or sooner when the window changes.
- **Credit-based flow control.**
  - Channels have no backpressure, so the frontend acknowledges every `seq`.
  - Rust keeps at most one batch unacknowledged and keeps coalescing while it waits.
  - Memory stays bounded by the number of rows, and a slow frame merges updates instead of queueing them.
- Delivery pauses while the window is hidden or minimised.
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
  - The `kubectl.kubernetes.io/last-applied-configuration` annotation on a Secret holds its values in clear text.
    The decoder strips it from Secret rows and objects everywhere: tables, editors, agents.
  - **Secret-grade data** is anything that can carry Secret values: Secret data, Helm values, and Secret objects inside a Helm release manifest.
    The UI shows it masked, and revealing it follows the Reveal row of the policy table (6.4).
    Twigo's MCP tools always return it masked.
    Reading Secrets through the policy proxy or `host-kube` is its own policy class, `secret-read` (6.4).
- **Events for an object.**
  A watch of `events.k8s.io/v1` with a field selector on the regarding object.
  It runs only while the Events tab is visible.
- **Metrics** (metrics-server).
  - `metrics.k8s.io` cannot be watched, so it is polled every 15 s.
  - Only the namespaces of the rows currently in a visible window are polled, and only while a CPU or memory column is shown.
  - The values merge into the rows in Rust as extra cells.
- **Discovery and OpenAPI.**
  - Aggregated discovery (`run_aggregated()`, GA since 1.30), with a fallback to legacy discovery.
  - A per-cluster disk cache holds discovery with its ETag (`If-None-Match` → 304), invalidated by the CRD and APIService metadata upstreams.
    Users who may not list those poll discovery with the ETag instead.
  - OpenAPI v3 documents are fetched lazily on the first edit of a group/version and cached forever under their `?hash=` URL, which is immutable.
    Rust converts them to JSON Schema for the YAML editor.
- **Never pre-fetched.**
  Counts for every kind, full lists of CRDs (they can be tens of MB), large ConfigMap values (rendered lazily), metrics for invisible rows.

### 3.7 View states

Each upstream reports one of:

- `queued` (waiting for a stream slot, 3.2)
- `connecting`
- `syncing` (with a progress count)
- `ready`
- `relisting`
- `stale` (no event or bookmark in time; reconnecting)
- `forbidden` (verb and resource from the 403)
- `unauthorized` (a sign-in action is offered)
- `error` (a typed kind plus a retry)

Every view header and the status bar render these states.
A blank table is never an error state.

### 3.8 Performance budgets and the benchmark

These are targets, measured on a kwok cluster, which simulates nodes and pods without kubelets, at 5k, 20k and 50k pods with churn:

| Metric                                                   | Target (5k pods)     | Target (50k pods)     |
| -------------------------------------------------------- | -------------------- | --------------------- |
| Pod list first paint after the space connects (LAN)      | < 1 s                | < 4 s                 |
| Change → painted cell, p95                               | < 150 ms             | < 300 ms              |
| Scroll and sort                                          | 60 fps, sort < 50 ms | 60 fps, sort < 200 ms |
| Core RSS with the pod list open                          | < 150 MB             | < 500 MB              |
| Webview memory with the pod list open                    | < 300 MB             | < 400 MB              |
| Idle CPU (100 changes/s background churn, window hidden) | < 1 %                | < 2 %                 |

The memory numbers count WebKit's `com.apple.WebKit.*` processes, all but the GPU process.
Any page that repaints, a blank one with one changing number included, holds about 260 MB there, WebKit's pool of IOSurfaces, so counting it would measure WebKit rather than Twigo; the report shows it on a row of its own ([bench](bench.md#where-the-webviews-memory-goes)).
They are children of launchd, not of the app, so measuring per process under-reports a Tauri app by about half.

`bench/harness.sh` measures them at 5k pods on macOS ([bench](bench.md)).
It builds the app's bench mode in release, runs a churn generator at 100 changes/s against kwok, launches the app, whose webview driver opens, scrolls, sorts and watches the pod list, and prints one row per metric with its value, target, status and what it measured:

- **First paint** runs from opening the list to its first rows painted.
- **Change → painted cell** joins the churn generator's log of changes, in Unix ms, with the webview's paints.
- **Scroll** is the mean fps of `requestAnimationFrame` over 5 s of scrolling at 4,000 px/s, and **sort** the p95 from a header click to the resorted rows painted, over ten sorts.
- **Core RSS** is the app process's resident size with the list open under churn.
- **Webview memory** is the physical footprint of the WebKit processes the app is responsible for, the process macOS records as having asked for them, but the GPU process, which is shown apart and never judged; the harness starts the app responsible for itself, since one started from a terminal shares the terminal's.
- **Idle CPU** is the CPU time of the app and those WebKit processes over 30 s with the window hidden, as a share of one core.

Until M1 the webview runs on the mock backend, so first paint and change → painted cell are not measurable: only their webview halves, from a batch to its paint, are shown, apart and unjudged.
Scroll, sort, memory and idle CPU are measured in the real app on the mock, which sorts and windows in JS in the webview, while the core holds no watch cache, so they are shown and not judged either: the report judges a metric, and fails the run on a missed target, only off the mock.
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

| Part               | Holds                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Title bar          | Breadcrumb of the space and its namespace scope, a search button that opens quick access; drag region; native traffic lights on macOS. Parts show and hide by keys (⌘B, ⌘J, ⌥⌘B), the View menu and the palette, not buttons                                                                                                                     |
| Space rail         | Tiles of the open spaces (D6, Lens's hotbar), ⌘1..9 by position, a button that opens any context                                                                                                                                                                                                                                                 |
| Primary side bar   | View containers as tabs in its header (Explorer, Port forwards, Helm, Extensions and contributed ones); the active one's views: resource tree, saved filters                                                                                                                                                                                     |
| Editor area        | Dockview grid of editor groups: tabs, preview tabs, splits, drag between groups                                                                                                                                                                                                                                                                  |
| Panel              | Terminal (pty), cluster Events stream, Output (Twigo logs per channel), Agent activity (audit, 6.6)                                                                                                                                                                                                                                              |
| Secondary side bar | The ACP agent panel later; hidden while nothing lives there, as is the panel                                                                                                                                                                                                                                                                     |
| Status bar         | The cluster's health: on the left a warning while the login shell's environment is missing (6.1), the cluster's connection and Kubernetes version (later policy mode, port-forwards, sync); on the right the active list's rows and how many are healthy, pending or failing, each a filter; the breadcrumb, not the status bar, names the space |

The parts sit flush, split by hairlines, with no cards or gaps: the owner tried islands, as JetBrains Islands and VS Code's 2026 layout ([research](research/workbench-chrome.md)), and preferred flat parts.
Views are descriptors (ID, title, container, `when`, provider), so the user can move a view to another container, VS Code style.
The layout per space is persisted (dockview `toJSON` plus part sizes and visibility).

### 4.2 Spaces (D6)

- A space has an ID, a list of contexts (one or more), a namespace scope and a persisted layout: open inputs, view placement, and what each view keeps, such as the explorer's open sections.
- Switching spaces moves the whole workbench: explorer, editors, status bar, policy badge.
  The rail shows a tile per open space: two letters on the tint of its context's colour, the active one ringed and marked, a lock badge on a locked context.
  The title bar's breadcrumb names the active space and its namespace scope and opens their pickers.
  An optional user-chosen colour from the context's metadata (5.5) is the only extra colour, from six tokens: red, orange, yellow, green, blue and purple.
  It tints the tile and the title bar's left end behind the breadcrumb, as JetBrains does with a project's colour.
  A space with several contexts shows none.
- Every editor in a space belongs to that space's contexts.
  Opening another cluster's object means switching spaces or running **Compare with…**, which opens a diff editor against an object picked from any context and says so in its title.
- A multi-context space ("dev+qa") gets merged tables with a Context column.
  Its editors still each carry one context, shown as a chip on the tab.
- A space connects lazily on its first activation.
  A background space's sessions (port-forwards, exec, logs) survive; its list subscriptions linger, then stop (3.2).
- Shortcuts: ⌘1..9 selects a space by its place in the rail; the rail's button and `ctx ` in quick access switch to a space or open one for any context; ⌘⇧N opens a space in a new window.

### 4.3 Editor model

Inputs are typed URIs.
A resolver maps a URI pattern to an editor pane by priority, as VS Code's editor resolver does:

| URI                                                                 | Editor                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `k8s://<ctx>/<group>/<version>/<resource>[/<ns>]/<name>`            | Resource editor with sub-tabs: Overview, YAML, Events, Related; plus Logs and Shell for pods and workloads                    |
| `k8s-list://<space>/<gvr>?ns=…&q=…`                                 | Resource table as an editor, so one can pin "pods in payments where status≠Running" next to another list                      |
| `logs://<ctx>/<ns>/<pod>[/<container>]?previous`                    | Log viewer                                                                                                                    |
| `exec://<ctx>/<ns>/<pod>/<container>`                               | Terminal (xterm)                                                                                                              |
| `pf://<space>/<forward-id>`                                         | Port-forward tab: state, target and resolved pod, local address, open connections, bytes, errors, a quick HTTP request tester |
| `diff://…`                                                          | Monaco diff: the apply dry-run, Compare with…, any two objects                                                                |
| `untitled://manifest-n`                                             | New manifest; Apply asks for the target context                                                                               |
| `twigo://settings`, `twigo://keybindings`, `twigo://extension/<id>` | Settings UI, keybindings UI, extension details                                                                                |

- **Preview tabs.**
  A click or Enter on a row opens its details, sliding in over the list from the right, as Lens's drawer; arrows move them along and Esc closes them.
  After a 150 ms pause they fetch the object once with a GET.
  No watch starts until an editor opens.
  Opening the resource from its details opens a preview tab (italic title); editing it or double-clicking its tab pins it.
- **Working copies.**
  A YAML editor that the user has changed holds a working copy based on the opened `resourceVersion`.
  - When the live object changes underneath, the editor shows "changed on server" with Compare, Reload and Keep mine.
  - Save runs the apply flow (6.5).
  - Unsaved working copies survive a restart (backups per space).
- **Overview.**
  - Core kinds get hand-made sections (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, Node, PVC, ConfigMap, Secret).
  - Any kind, CRDs included, gets a generic overview: metadata, a `status.conditions` table when present, owners and children, events.
  - Extensions add declarative sections per GVK (5.4).

### 4.4 Resource tables and the keyboard

- Columns come from the Table `columnDefinitions` (priority 0 by default, wide on toggle), plus Context, CPU and memory when available, and Namespace unless the query names one namespace.
  Column presets are kept per GVR, for every space: the user shows or hides columns by name from the head of the actions column, and a column nobody chose for follows its priority.
- The last column is the row's actions: a ⋯ button on hover and on the selected row, and the same menu on a right click, built from `resource/context`.
  Its commands act on the selected row of the active list.
  Columns share the free width in proportion to their widths until the user drags one's edge; header dividers show on hover.
- Cells read by what matters: a status shows a tone dot, a ratio short of its total (Ready `0/1`) is pending, Namespace and Age are quiet, and a count's remainder (Restarts ` (28m ago)`) and a zero count are grey.
  Which column does what is data in `packages/kube`, by `group/resource/column`.
- Focus model: arrows or `j`/`k` move, Enter opens, Space marks, ⇧Space marks a range, `/` or ⌘F filters, Esc clears.
- A list's filters sit at the right of its group's tab strip, as the editor's actions (`editor/title`): chips for All, Failing, Pending and Healthy with their counts, for kinds with a status column, and the text field.
  They take no row of their own, so a table sits under three bars: title, tabs, header.
  Each open list keeps its own; a count in the status bar picks the same chip.
- Single-key verbs work only when a table is focused (context key `listFocus`): `l` logs, `s` shell, `e` edit YAML, `d` describe/overview, `y` copy YAML, `f` port-forward, `⇧J` jump to owner, `⌫` delete (with confirmation).
  These are ordinary commands with keybindings, so users can remap them.
- Changed cells flash briefly: the cell's background starts at the `--flash` tint and fades out over 1 s.
  A batch that changes more than 8 rows flashes nothing, so a rollout does not strobe the table.
  The flash is a setting, on by default.

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

### 4.6 Logs, terminal and editors

- **Logs.**
  A virtualized line list with ANSI parsing, not xterm.
  - The backing store is a ring buffer in Rust, bounded by lines and bytes, with a `dropped` marker as in legacy.
  - Search is done in Rust (regex) and returns a match index.
  - Supported: follow, wrap, timestamps, previous container, download, and switching between containers.
  - On EOF the stream reopens with `sinceTime` set to the last timestamp and drops duplicates.
  - Logs aggregated across a workload's pods, stern-style, come in v1.x.
    Watch the log budget (3.2).
- **Exec and attach.**
  xterm.js 6 with the WebGL addon.
  It falls back to the DOM renderer on context loss, which happens on WebKitGTK.
  WebGL is disposed on hidden tabs.
  kube-rs `AttachedProcess` (version 4.0 or later fixes the task leak and the join deadlock) handles resize.
  The shell is detected by trying `bash`, then `sh`.
- **Port-forward manager.**
  A target is a Pod, a Service or a workload.
  - The manager binds the local `TcpListener` and keeps it for the life of the forward, so no other process can take the port between check and bind.
  - Each accepted TCP connection resolves a Ready, non-terminating pod through EndpointSlices (named `targetPort`s are translated), opens its own kube-rs port-forward stream and copies in both directions.
  - A failed pod is avoided on the next resolution, with backoff.
    Open TCP connections die with their pod; the listener does not.
  - States: `starting → ready → reconnecting(reason) → error`, plus `queued` when the session budget is full (3.2).
  - The local port is remembered per target.
    When it is busy, the next free port is offered.
  - Forwards persist per space.
    Each one has its own tab (`pf://`) and a status-bar item.
  - Each TCP connection is its own WebSocket and counts against the session budget.
    If browsers or connection pools exhaust it, Twigo implements the SPDY-over-WebSocket tunnel that kubectl has used since 1.31 to multiplex connections.
  - Later: defaults from annotations (k9s `k9scli.io/port-forwards`), and a `kubectl port-forward` fallback, run through the policy proxy, for proxies that refuse WebSocket upgrades.
- **Integrated terminal.**
  A local pty with the login-shell environment.
  - The terminal is pinned to the space's context without touching the user's kubeconfig.
  - **Terminals of `read-write` contexts from the user's kubeconfig** use the user's real credentials.
    `KUBECONFIG` is a tiny Twigo file holding only `current-context: <ctx>`, followed by the user's own files, so kubectl takes the first file's current context.
    Such a terminal reaches every context with real credentials, read-only ones included, as any terminal app would.
  - **Terminals of every other context**, including one temporarily unlocked, get only a generated policy-proxy kubeconfig (6.4).
    So do terminals of contexts that come from a provider, whatever their mode, because those have no kubeconfig entry to point at.
    It holds one proxy entry per catalog context, each with its own token and that context's mode, and none of the user's files.
    `--context`, k9s `:ctx` or `config use-context` therefore cannot reach real credentials by accident.
    The proxy follows the current mode, so a relock applies to terminals that are already open.
    A write from a `guarded` terminal raises a Twigo approval.
  - The tab shows which kind of terminal it is.
    `terminal.usePolicyProxy` turns the proxy on for `read-write` contexts too.
    The policy file can force it on for any context, and settings cannot turn that off.
  - kubectl and most tools write new entries (for example from `aws eks update-kubeconfig`) to the first file in `KUBECONFIG`, which is Twigo's.
    Twigo watches that file and offers to move new entries into the user's kubeconfig.
- **YAML editor and diff.**
  Monaco with monaco-yaml (yaml-language-server).
  - The schema per model URI comes from the cluster's OpenAPI (3.6), so validation, completion and hover work for CRDs too.
  - The diff editor is Monaco's DiffEditor.
  - Monaco is bundled locally (no CDN loader) and loaded lazily on the first YAML or diff editor.
  - CodeMirror 6 was rejected: its YAML schema support is weaker, and two editors would be waste.

### 4.7 Notifications and progress

A notification centre with severity, actions and do-not-disturb, built on the toasts of `packages/ui`.
`notify` raises a toast from anywhere, and sonner, under the `<Toaster>` the workbench shell mounts, positions, stacks and times them.
The toasts exist; the centre does not yet.
Every long operation reports progress from Rust: drain, apply, Helm, provider "Create cluster".
Progress shows in the status bar, or in a notification when the operation needs attention.

### 4.8 Settings and state

- **Layers**, lowest first, highest wins:
  1. defaults (from contributed schemas);
  2. user `settings.json` (JSONC);
  3. context overrides (`"[context:prod-*]": { … }`, VS Code's language overrides turned into context globs);
  4. policy.
- **Policy** is an admin-managed file, `/Library/Application Support/Twigo/policy.json` or `/etc/twigo/policy.json`, and later MDM.
  It locks values: for example "contexts matching `prod-*` are read-only", "extensions only from these registries", "MCP off".
- Settings are files the user can edit in the app (with a schema) or through the generated settings UI.
  Changes are picked up live.
  `keybindings.json` works the same way.
- **State** that is not settings stays in the app store: layouts, recent items, command history, dismissed hints.
- **What is skipped from VS Code, and why:**
  - Workspace and folder layers: spaces take their place.
  - Profiles and settings sync: later, if users ask.
  - Workspace trust: becomes "kubeconfig trust" (6.2).

### 4.9 Design language (D8)

The legacy app had a deliberate design language.
It moves into `packages/ui` unchanged and gets extended for the new views.

- **Tokens (`theme.css`).**
  - An azure brand pair (`--brand` at oklch hue ≈245).
    Changing that pair re-skins the app.
  - Neutral greys with a trace of the brand hue: an app's chrome, not a tinted dashboard.
    The shell and the side bars share one tone and the editor is the surface that stands out: 0.975 and white on light, 0.205 and 0.235 on dark, with card 0.25 and popover 0.27, as VS Code's ramp.
    Text sits a step below white on dark (0.87).
  - Hover and selection are alpha overlays, so they work on any surface.
  - A two-layer focus ring.
  - Hairline borders in alpha tiers.
  - The status bar is a matte, muted blue, low in chroma so it reads as ink, never a glossy accent.
- **Type.**
  - The platform's UI font, SF on macOS, as VS Code; tabular numbers for every metric column.
  - Two weights, 400 and 600, as VS Code and JetBrains; 13 px base, 12 px secondary, 11 px labels; sentence case, no capitals.
  - Dense rows: 22 px in trees, 26 px in tables, whose rows carry more columns to read across; icons 16 px, Lucide's 1.5 stroke drawing 1 px lines.
- **Surfaces.**
  Flat parts split by hairlines (4.1), and editor tabs connect to their editor: the strip takes the shell's surface, the active tab the editor's, open into it.
  Table columns resize from their header's edge.
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
    Rows, namespaces and labels are never coloured.
  - Syntax colour lives in Monaco only.
  - Big canvases stay plain.
  - About one primary action per panel.
  - The density target is the JetBrains/Fleet/Linear end, not an airy admin panel.
- **States are designed, not defaulted.**
  Every view state in 3.7 has its own empty, loading (skeleton) or error rendering, with a plain muted icon and one action.
- **How quality is kept.**
  - Tokens only: a lint rule rejects raw colour literals outside `packages/ui`.
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
  - All Kubernetes operations: apply, delete, scale, restart, drain, cordon, trigger, suspend, Helm.
  - They run in Rust through one `command.execute` IPC.
  - Rust checks policy before it runs, so a read-only context blocks the command before anything is sent.
  - Args are resource references (`ResourceRef[]` = the selection), never full objects.
- **Menus are data that point at commands**, with `group`, `order` and `when`, as VS Code's MenuRegistry.
  The menu IDs:
  - `commandPalette`
  - `resource/context` (row context menu)
  - `resource/title` (resource editor toolbar)
  - `view/title`, `view/item`
  - `editor/title`
  - `space/context`
  - `statusBar`
  - `explorer/kind`

  The native macOS menu is generated from the registry, replacing legacy `menu.ts`'s hand-written list.

- **Context keys** are typed values scoped to the focused element.
  A `when` expression evaluates them, using a subset of the VS Code grammar: `==`, `!=`, `&&`, `||`, `!`, `=~`, `in`, `<`, `>`.
  Core keys:
  - `space.contexts`, `space.multiContext`
  - `context.name`, `context.readOnly`, `context.mode`, `context.provider`
  - `listFocus`, `treeFocus` (a tree, which is also a list: left and right close and open), `editorFocus`, `inputFocus`
  - `resource.group`, `resource.kind`, `resource.namespaced`, `resource.namespace`
  - `selection.count`
  - `editor.open`, `editor.dirty`, `editor.type`
  - `capability.<verb>.<resource>` (cached SelfSubjectAccessReview)
  - `platform`

  Extensions may define keys under their own prefix.

### 5.2 Keybindings

- **Resolution as in VS Code's `keybindingResolver`.**
  - Rules carry a weight: core < built-in extension < extension < user.
    The last matching rule whose `when` holds wins.
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
- **Bare keys** fire only in `listFocus` and never inside inputs or Monaco.
  This keeps legacy `isTypingTarget`.
- **The keybindings editor** shows conflicts and the source of every binding.
- **Keymaps** ship as contributions: Default (VS Code-like) and k9s (vim movement, `:` mode on bare `:` in `listFocus`).
- **macOS native menu accelerators** come from the same table.
  The OS consumes them before the webview does, as legacy's menu already relied on.
- **Shortcuts the webview reserves** (for example ⌘Q, ⌘H, ⌘M, and some ⌘⌥ combinations on WebKitGTK) are documented and refused in the editor.

### 5.3 Extension runtime (D3, D4)

Four tiers.
An extension uses only the tiers it needs.
Every tier is declared in the manifest and granted at install time.

| Tier                   | What                                                                                                                                         | Isolation                                                                                                                                                                                                      | Ships         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **0: manifest**        | Contributions as data: commands, menus, keybindings, settings schema, themes, keymaps, CRD schemas and snippets, declarative views and forms | Nothing executes.                                                                                                                                                                                              | MVP (private) |
| **1: WASM component**  | Logic: cluster and credential providers, command handlers, data providers for trees and tables, form submit handlers, resource actions       | wasmtime, one store per extension. No ambient authority. Fuel or epoch limits for CPU and a `ResourceLimiter` for memory. Every import is checked against grants.                                              | MVP (private) |
| **2: sandboxed frame** | Views that cannot be declared (charts, wizards with custom widgets)                                                                          | `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) served from `twigo-ext://<id>/` with a deny-by-default CSP. postMessage only to the host frame, which relays to that extension's tier-1 component. | v1.x          |
| **3: native process**  | k9s-style actions (shell, kubectl), MCP or LSP servers, helpers that must be native                                                          | None beyond the user's rights: shown as such and started only after explicit consent. Binaries are declared per OS with URL and SHA-256. Their cluster access goes through the policy proxy (6.4).             | v1.x          |

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
| `resourceSections`                            | Declarative sections on a GVK's Overview (key/value, table, conditions, links)                    | `onResource:<group>/<kind>` |
| `columns`                                     | JSONPath columns for a GVK (turns on projection, 3.3)                                             | —                           |
| `actions`                                     | k9s-style shell or kubectl actions with `scopes`, `confirm`, `dangerous`, `inputs` (tier 3, v1.x) | —                           |
| `clusterProviders`                            | Catalog source, credential minting, lifecycle (create, delete, upgrade)                           | `onClusterProvider:<id>`    |
| `mcpServers`                                  | MCP servers re-exposed through Twigo's MCP gateway, auth kept in Rust (6.6, v1.x)                 | first `tools/list`          |
| `crdSchemas`, `snippets`                      | YAML editor help for CRDs the cluster's OpenAPI describes poorly                                  | —                           |
| `themes`, `iconThemes`                        | Look                                                                                              | —                           |
| `uriHandlers`                                 | `twigo://ext/<id>/…` deep links (for example SSO callbacks)                                       | `onUri`                     |

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
  - The core ships one: kubeconfig files from `KUBECONFIG` (as the login shell sets it, 6.1), `~/.kube/config` and folders the user adds.
    They are watched with a notify debouncer on the parent directories, because writers replace files by rename.
  - Each extension's `clusterProviders` is a further source.
  - Later: Cluster Inventory `ClusterProfile` (SIG Multicluster, alpha).
- **Connection** is either
  - `KubeconfigRef { file, context }`, or
  - `Provider { provider, clusterId, server, caData }`, whose credentials come from the provider's `resolve-credential`.
    The token or certificate stays in Rust, is cached until 60 s before it expires, and is refreshed on 401.
  - Unlike Lens and Headlamp, **providers never write kubeconfig files**.
    "Export to kubeconfig" is an explicit command; for Segla it writes an exec entry for `sgl cluster credentials <label>`.
- **Metadata from kubeconfig** `extensions` (name `twigo`): `color`, `tags`, `readOnly`, `order`.
  Twigo reads it and never writes it.
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
It runs the plugin with a blocking `Command::output()` and no timeout, verified in `kube-client/src/client/auth/mod.rs`.
It inherits stdin and stderr, so device codes disappear.
In our probe it ran the plugin three times while building one client.
Twigo therefore owns credentials:

- **Clients.**
  Each context has two shared hyper-util clients: an HTTP/2 one for requests, watches and logs, and an HTTP/1.1 one for exec, attach and port-forward (3.2).
  Every actor's kube clients are built over them with kube's base URI and header layers and our auth layer, and carry the credential's expiry.
  The exec block is stripped from the config first.
- **The credential runner.**
  - Uses `tokio::process` with the shell environment, null stdin and its own process group, and caps stdout at 1 MiB.
  - Sets `KUBERNETES_EXEC_INFO`, including cluster info when `provideClusterInfo` is set.
  - Times out after 120 s, and the user can cancel.
  - Concurrent requests for the same credential share one run.
  - Caches per hash of the user and cluster entries until 60 s before the credential expires.
    A 401 drops the cache and retries once.
- **Interactive plugins** (kubelogin devicecode or interactive, `oidc-login`, `pinniped`, `tsh`, `aws sso`):
  - They are classified up front.
    Nothing in the background ever runs one.
  - The user starts them, and their stderr streams into a sign-in panel that shows device codes and URLs (redacted in logs).
  - After sign-in, Twigo rebuilds the context's clients for every actor, as in 6.3, and restarts the watches that were unauthorized.
- **Lazy.**
  Credentials are resolved only when a space activates, never for all contexts at startup.
  Headlamp #7879 is the failure this avoids.
- **Kubeconfig trust**, adapted from VS Code's workspace trust.
  - An exec plugin is a command chosen by whoever wrote the kubeconfig.
  - On first run, Twigo lists the exec commands it found, and the user confirms them once.
  - A new or changed exec entry (a different hash of command, args and env) asks again before it runs.
- **Other auth methods.**
  The deprecated `auth-provider: oidc` refreshes its token.
  Writing the refreshed token back to the kubeconfig is an explicit opt-in; kube-rs never writes it back.
  Client certificates and token files are also supported.

### 6.3 Transport

- TLS is rustls with ring by default, using the OS trust store when the kubeconfig has no CA.
  An optional per-context openssl stack covers legacy clusters that rustls rejects: TLS < 1.2, X.509 v1, CN-only certificates.
- `proxy-url` (http, https, socks5) comes from the kubeconfig.
  - Without it, kube-client 4.2.0 falls back to `HTTPS_PROXY` (or `https_proxy`), read from the process environment, and has no `NO_PROXY` support (`kube-client/src/config/file_loader.rs`).
    The unreleased `main` adds `NO_PROXY`, but matches it against the proxy URL instead of the API server.
  - Twigo's connector takes the proxy variables from the login-shell environment and matches `NO_PROXY` against the API server host.
  - When neither the kubeconfig nor the environment sets a proxy, the connector uses the OS proxy settings: SystemConfiguration on macOS, the desktop proxy settings on Linux.
    PAC files are out of scope for the MVP.
  - Corporate proxies are where Lens failed.
- When the kubeconfig changes, Twigo fingerprints each context from its context, cluster and user entries plus the files they reference.
  It rebuilds only the clients whose fingerprint changed, for every actor at once, since each actor's kube clients hold the context's shared pools (6.4), and restarts their upstreams.
- Exec, attach and port-forward use kube-rs WebSockets (`v5.channel.k8s.io`, falling back to `v4`; there is no SPDY) over the HTTP/1.1 client; requests, watches and logs share the HTTP/2 connection (3.2).
  RBAC needs `create` on `pods/exec`, `pods/attach` and `pods/portforward` for WebSocket upgrades from 1.35.
  The action is offered only after a cached access review.

### 6.4 Read-only enforcement (`twigo-policy`)

**One gate, in Rust, below every caller.**

- The policy check is a tower layer in every actor's kube clients (3.2).
  The UI, extensions (via `host-kube`) and the MCP server have no other way to reach a cluster, so they cannot get around it.
  `host-http` refuses any host and port that belongs to a catalog API server.
- `authorize(context, verb, resource, subresource, namespace, name, actor)` runs before the request leaves the process.
- The frontend only displays the lock.
  Legacy kept the lock in a frontend store synced to Rust, and that model is reversed.
- **What the layer sees, and what commands add.**
  The layer classifies each request before it is sent, by HTTP method, resource, subresource, the `dryRun` and `includeObject` parameters, and the `Accept` header:
  - read: GET, LIST, WATCH, plus the POSTs that only ask questions (`authorization.k8s.io` self-subject access and rules reviews, `authentication.k8s.io` self-subject reviews);
  - dry-run: any write with `dryRun=All`;
  - write: every other POST, PUT, PATCH, DELETE;
  - secret-read: GET, LIST or WATCH of `secrets` whose `Accept` header allows a full-object response.
    Only `PartialObjectMetadata`, or a Table with `includeObject` `None` or `Metadata` and no plain JSON fallback, escapes it.
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

  The mode allows or blocks every other class.
  Confirmations, typed context names and diffs belong to the commands above the layer, because at the HTTP level a scale is one PATCH and a drain is many requests.

- **Actors.**
  Each actor (the UI, an extension, an MCP client, an agent session) gets its own two kube clients, which carry its policy layer over the context's two shared hyper-util clients and the context's stream counter (3.2).
  A hyper-util client clone shares its pool, so every actor uses the same HTTP/2 connection, and the layer knows who is asking without per-call plumbing.
- **Child processes go through a policy proxy.**
  `helm` for release actions, kubectl in actions, the `kubectl port-forward` fallback, agent sessions and terminals of every context that is not `read-write` get a generated kubeconfig.
  Provider contexts always use it in terminals (4.6).
  - It points at a loopback endpoint in the core, with a bearer token per process and context.
    Each token maps to a context, an actor and, optionally, a pre-approval.
  - Ordinary requests and watches go through the same per-context clients, stream counter and policy layer.
  - Upgrade requests are checked by the same classes, then forwarded with the actor's HTTP/1.1 client and spliced with `hyper::upgrade::on`, which is all kube's own `connect` does (`kube-client/src/client/mod.rs`).
    The raw upgraded stream passes through whatever the protocol: WebSocket, SPDY, or SPDY over WebSocket.
    Auth, the 401 refresh, the proxy connector and the policy layer stay one path.
  - **A process started by a confirmed command** (a Helm release action, an action with `confirm`) gets a token pre-approved for exactly what the user confirmed: the verbs and objects the command listed.
    A request outside that set goes to the approval broker.
  - **Other processes in `guarded` contexts** (terminals, unconfirmed actions, agents): writes and exec-class requests go to the approval broker.
    - The broker shows the verb, the resource, the name, and a dry-run diff where one can be computed.
    - Deletes ask for the typed context name.
    - Agents may use the scope "this process" for the rest of one run, except for deletes.
      Terminals get only "once" and "for N minutes", because a terminal's token lives as long as the shell.
    - When the UI cannot ask, the answer is deny.
  - For agents, the Rule of Two (6.6) also applies in `read-write` contexts: after untrusted content, their writes, exec-class requests and Secret reads go to the broker one call at a time.
  - The proxy has its own cap on concurrent streams per context (default 16, 3.2).
    Over the cap it answers `429` with `Retry-After`, because client-go retries a 429 only when that header is present.
    An upgrade while the session budget is full gets a `429` too, but client-go never waits for an upgrade: `kubectl exec`, `attach` and `port-forward` fail with it, and `kubectl run -it` and `debug -it` fall back to printing logs.
    The proxy never queues requests and never evicts the UI's upstreams (3.2).
- **What the proxy does not cover.**
  It guards against accidents, not against a determined process.
  - Any process running as the user can still read `~/.kube/config` or pass `--kubeconfig`.
    That includes tier-3 processes, agents and terminals.
  - The terminal of a `read-write` context from the user's kubeconfig uses real credentials by design: it is the user's own shell, like any terminal app (4.6).

| Operation                                                                     | `read-write`                            | `guarded`                             | `read-only`                                            |
| ----------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| get, list, watch, logs, events, discovery                                     | ✓                                       | ✓                                     | ✓                                                      |
| Reveal secret-grade data (3.6)                                                | ✓                                       | confirm                               | confirm                                                |
| Port-forward                                                                  | ✓                                       | ✓                                     | ✓ unless `readOnly.allowPortForward: false`            |
| exec, attach, ephemeral debug container                                       | ✓                                       | confirm                               | ✗                                                      |
| create, apply, patch, update (dry-run diff always shown)                      | ✓                                       | confirm with the diff                 | ✗ (dry-run still allowed, so a change can be prepared) |
| delete, scale, rollout restart, cordon, drain, evict, Helm rollback/uninstall | ✓ with confirmation listing the objects | typed confirmation (the context name) | ✗                                                      |

- **Where the mode comes from**, highest first:
  1. a policy file entry, which the UI cannot unlock;
  2. the user setting for the context (or a context glob);
  3. kubeconfig metadata (`twigo.readOnly`);
  4. the provider (Segla can mark production clusters);
  5. the default `read-write`.
- **Unlock for 15 minutes.**
  A command switches a `read-only` context to `guarded` for a limited time.
  A banner shows the countdown, and the context relocks by itself.
- **Every blocked request** returns a typed `permissions` error with the mode and its source, and the UI shows which rule blocked it.

### 6.5 YAML apply: dry-run diff, then server-side apply

1. Open: `GET` the object.
   Show it without managedFields, with `status` read-only.
2. Build the apply configuration from **the fields `twigo` already owns plus the fields the user changed**, plus apiVersion, kind, name and namespace.
   - The owned set is extracted from the live object through the `twigo` entry in managedFields, as client-go's `Extract…` apply configurations do.
   - Why: a field that a later apply leaves out is removed, or reset to its default, when no other manager owns it.
     Sending only this edit's changes would undo the previous edit: a forced `replicas: 5` would fall back on the next annotation change.
   - Changed items of map-type lists are sent with their keys; atomic lists are sent whole.
   - Applying the whole object would make Twigo a co-owner of every field.
     Fields that a GitOps tool later removes would then stay behind.
3. Add the opened `resourceVersion` as an optimistic lock.
4. Dry-run: `PATCH` with `Patch::Apply`, `PatchParams::apply("twigo")`, `dry_run`, and `validation_strict()` (kubectl's default; the server's is Warn).
   Use `Client::send` so `Warning` headers are kept, because kube-rs drops them.
5. Show live against the dry-run result in a Monaco diff.
   Both sides are cleaned of managedFields, and Secret data is masked.
   The diff includes defaults and webhook mutations, which a local diff cannot know.
6. Apply.
   A `409 FieldManagerConflict` shows a table per field with the owning manager, and offers **Force** or **Drop my change**.
7. A field the user deleted but another manager owns needs a separate merge patch with `null`, shown as its own step in the diff.
8. Immutable fields return 422; the dry-run catches this before any write.
   Delete-and-recreate is offered only for Pods and Jobs, with confirmation.

Destructive actions (delete, drain, scale to 0) use dry-run where the API supports it, list the exact objects, and need a confirmation that matches the policy mode.

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
  - describe-style summaries;
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
  `worker-src 'self' blob:` is allowed for Monaco's workers.
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

| Area          | In the MVP                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog       | Kubeconfig source (several files, live reload), kubeconfig metadata, one-context spaces, per-context settings and policy                                                                                                                                |
| Auth          | Login-shell environment, the credential runner with interactive sign-in panel, kubeconfig trust, OIDC, certificates, proxies                                                                                                                            |
| Explorer      | Every built-in kind from Lens's list plus CRDs from discovery. Table watches, namespace scope (multi-select), label and text filters, wide columns                                                                                                      |
| Editors       | Overview (core kinds plus generic), YAML with OpenAPI schemas, dry-run diff and SSA apply with conflicts, Events, Related (owners and children), Compare with…, new manifest                                                                            |
| Actions       | Delete, scale, rollout restart, cordon, uncordon, drain, CronJob trigger, Job suspend                                                                                                                                                                   |
| Sessions      | Pod logs, exec and attach, the policy proxy for child processes, the port-forward manager (Service and workload targets, re-resolution, port-forward tabs and status-bar items, persisted per space), integrated terminal pinned to the space's context |
| Workbench     | Parts, spaces, quick access with every prefix, command/menu/context-key/keybinding services, keybindings editor, settings UI with layers and policy, notifications, light and dark themes                                                               |
| Metrics, Helm | metrics-server CPU and memory in tables and the node/pod overview; Helm releases **read-only** (list, values, manifest, history, notes), decoded natively from release Secrets; values and Secret objects in manifests are secret-grade (3.6)           |
| AI            | MCP server with read-only tools, grants, redaction, audit                                                                                                                                                                                               |
| Extensions    | Tiers 0 and 1, the WIT API at `0.x` (unstable; release builds load allowlisted IDs only), cluster providers, the fixture extension. Private: the Segla extension is the first consumer; there is no public registry yet                                 |
| Release       | Auto-update, signing, notarization, the performance budgets checked in CI                                                                                                                                                                               |

### 7.2 Later (rough order)

1. **Windows** (D2): WebView2, Authenticode signing, the registry environment, `CREATE_NO_WINDOW` for exec plugins, and the tier-2 frame probe of `bench/ipc` on WebView2.
2. **More resources and sessions:**
   - multi-context spaces with merged tables;
   - workload logs (stern-style);
   - Helm upgrade, rollback, uninstall and install through the `helm` CLI and the policy proxy;
   - approved writes over MCP, and the MCP gateway for remote servers that extensions contribute.
3. **The public extension API:** the WIT freezes at `1.0`, plus the registry, tier 2 frames, tier 3 processes (including actions) and the k9s `plugins.yaml` importer.
4. **The agent panel over ACP.**
5. **Deeper views:**
   - Prometheus charts with auto-detection;
   - RBAC "who can" and effective permissions;
   - a resource graph;
   - Gateway API views;
   - node shell and debug containers.
6. **Built-in extensions:** Flux, Argo CD, cert-manager, and NATS (D1).
7. **Windows and access:** detached editor windows; hosts-file aliases for port-forwards (needs a privileged helper); Cluster Inventory `ClusterProfile`; MDM policy; accessibility audit.

### 7.3 Key risks

| Risk                                                                                                                            | Impact                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One HTTP/2 connection carries every request, watch and log of a cluster                                                         | A dead or slow connection stalls them all; streams wait once 100 are open | Keep-alive pings; the connection is retired on wake, on a network change and when a probe fails; one stream counter per context, below every actor, keeps watches, logs, proxied streams and requests within budgets that add up to the default limit of 100, and shows `queued`; the hub reads every stream at once (3.2, [HTTP/2 spike](spikes/http2.md)). |
| Table watch edge cases: columns only in the first event, conversion fallbacks, aggregated APIs without Table, frozen date cells | Wrong or missing columns                                                  | Decoder conformance tests against kind 1.33 to 1.37 plus aggregated API fixtures; fall back to metadata columns.                                                                                                                                                                                                                                             |
| WebKit and WebKitGTK performance (virtualized tables, Monaco, WebGL context loss)                                               | Linux feels slower than macOS                                             | The budgets run on Linux CI too. DOM fallback for xterm; Monaco loads lazily.                                                                                                                                                                                                                                                                                |
| Component-model maturity (WASI 0.3 async is new; jco output is large; TinyGo limits)                                            | Extension authoring friction                                              | The host drives async through imports; the Rust SDK comes first; TS SDK after the API freeze; the Segla extension proves the model before it opens.                                                                                                                                                                                                          |
| Exec auth diversity: device code, browser, Teleport, Pinniped, SSO chains                                                       | "Can't connect" in the first minute                                       | A test matrix with EKS, GKE, AKS, kubelogin (all modes), oidc-login and Segla; interactive classification; a visible sign-in panel.                                                                                                                                                                                                                          |
| Sandboxed-frame IPC isolation on Linux                                                                                          | A malicious tier-2 frame invokes commands                                 | The M0 spike showed that a sandboxed frame invokes nothing on WebKitGTK and macOS, and CI repeats it on every Tauri and wry update ([isolation spike](spikes/tauri-isolation.md)); frames never get `allow-same-origin`, and the relay passes only data.                                                                                                     |
| Prompt injection through cluster text; approval fatigue                                                                         | An agent causes a write                                                   | Read-only MCP in the MVP; the rule of two; approvals in Twigo's UI with a diff; audit.                                                                                                                                                                                                                                                                       |
| Scope: chasing Lens's list feature by feature                                                                                   | A late, shallow MVP                                                       | The MVP list above is the contract. Everything else waits for v1.x.                                                                                                                                                                                                                                                                                          |
| Extension API churn after third parties adopt it                                                                                | Broken extensions (the Lens history)                                      | `0.x` stays private until 1.0; versioned WIT with every old binding kept; the fixture extension in CI.                                                                                                                                                                                                                                                       |
| Corporate networks: proxies, `NO_PROXY`, SOCKS bastions                                                                         | Works at home, fails at work                                              | No local proxy in the UI path; our connector honours `NO_PROXY` and the OS proxy settings (6.3); a proxy matrix in integration tests.                                                                                                                                                                                                                        |
| Measuring memory wrongly on macOS                                                                                               | False confidence                                                          | The bench counts the WebKit processes (3.8).                                                                                                                                                                                                                                                                                                                 |

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
  MCP server, extension tiers 0 and 1 with the Segla extension, settings UI, keybindings editor, auto-update, signing, documentation.

## Appendix: references

Facts were checked on 2026-10-31 against sources or docs.
Versions: kube 4.2.0, k8s-openapi 0.28, Tauri 2.12.5, wasmtime 50, Kubernetes 1.37.

- kube-rs:
  - https://github.com/kube-rs/kube/tree/4.2.0 (HTTP/1.1 only: `kube-client/Cargo.toml`; exec auth: `kube-client/src/client/auth/mod.rs`; WebSocket protocols: `kube-client/src/client/upgrade.rs`)
  - https://docs.rs/kube/4.2.0/kube/runtime/watcher/struct.Config.html
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
