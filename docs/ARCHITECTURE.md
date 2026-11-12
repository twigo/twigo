# Twigo architecture

Twigo is an open-source desktop IDE for Kubernetes: native, fast and keyboard-first.
It aims to match Lens feature for feature without its login wall, its weight or its slowness on large clusters.
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

### 0.3 What the other clients teach

The sources are in the appendix.

| Their problem                                                                                                                                           | Seen in                                            | Twigo's answer                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login wall, paid tiers for basics (hotbar, MCP, extensions), closed source                                                                              | Lens since 2023                                    | Apache-2.0, no account, every core feature free (0.2)                                                                                                         |
| Full list of every kind with no `limit`; one watch per namespace; a full app instance per open cluster (iframes)                                        | Freelens / OpenLens                                | Shared, ref-counted Table watches per GVR and scope (per namespace, widened above 4 namespaces); one webview; per-cluster budgets (3.2)                       |
| Unbatched global events per watch event; full snapshot per change; merge on the UI thread                                                               | Kubeli, srelens, Aptakube                          | Rust coalesces, sorts and windows; one Channel per view; acks for flow control (3.5)                                                                          |
| Hangs with "All namespaces" on 30k pods; freezes on big ConfigMaps; eager metrics on huge lists                                                         | Aptakube #499, #575                                | Rust owns sort, filter and window; metrics only for visible rows; large values rendered lazily (3.4, 3.6)                                                     |
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
A tokio task that panics does not take the process down.
A wasmtime trap ends the extension call, not the app.
Each webview is already a separate OS process managed by the system.
The only extra processes Twigo needs are the ones it must run anyway: exec plugins, shells, native helpers and agents.

**Multiple windows.**
One core process serves every window.
List subscriptions are keyed by `(window, view)`, so a window reaches only its own, and closing or reloading it drops them: a page that starts to load has none of the lists of the page it replaces.
The followers of the catalog, the credentials, the resources, the shell and the keyboard are kept one per window and replaced when its next page subscribes.
Detached editor windows (VS Code's auxiliary windows) come after the MVP.

### 2.2 Repository layout

```
twigo/
├─ apps/desktop/              Tauri app: thin glue; src-tauri only wires crates into commands/channels
├─ crates/
│  ├─ twigo-core/             app services: spaces, settings layers, catalog, command bus and its actions, policy proxy and approval broker
│  ├─ twigo-kube/             contexts, client factory, credential runner, discovery/OpenAPI cache
│  ├─ twigo-cache/            watch hub (upstreams, row stores, query views, batching), the discovery it follows
│  ├─ twigo-describe/         describers by GroupKind: an object and its related facts → the Overview document (4.3)
│  ├─ twigo-sessions/         logs, exec/attach, port-forward manager, pty terminal
│  ├─ twigo-policy/           read-only modes, authorize(), what an approval covers, audit log, redaction
│  ├─ twigo-env/              login-shell environment resolution
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
- `twigo-keyboard` keeps the OS's keyboard APIs out of `apps/desktop`.
  It needs no Tauri, and its tests read named layouts without a window.
- `twigo-netmon` keeps the OS's power and network notifications out of the transport, which only learns that the machine woke or the network changed.

`apps/desktop/src-tauri` holds no domain logic.
It translates Tauri commands and channels into calls on `twigo-core`.

### 2.3 Frontend packages

| Package              | Owns                                                                                                                                                                                                                                                                                                                                   | May import                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `packages/ui`        | Tokens, and primitives (shadcn/Radix) for every recurring pattern: actions and their menus, tones and status dots, counts, keys, fields, segmented controls, the data grid, the tree, the line list and styled text, the histogram, property lists, sections, callouts and banners, toasts (`notify`), empty, loading and error states | —                             |
| `packages/workbench` | Layout parts and the panel's own dockview, contribution registries, command, menu, keybinding and context-key services, the list service and its `list.*` commands, quick access, the toaster and notification centre (4.7), settings UI, spaces UI, editor service over the editor area and the panel                                 | `ui`, `protocol`              |
| `packages/kube`      | Every Kubernetes view and editor, column rules and cells, status entries; registers into the workbench registries                                                                                                                                                                                                                      | `ui`, `workbench`, `protocol` |
| `packages/protocol`  | Generated request and response types, a channel client with seq/ack, and a **mock backend** that runs the UI in a plain browser on fixtures (design reviews, component tests)                                                                                                                                                          | —                             |
| `packages/utils`     | Pure helpers without React or IPC, such as formatters                                                                                                                                                                                                                                                                                  | —                             |
| `apps/desktop/src`   | Bootstraps the workbench and registers `kube`                                                                                                                                                                                                                                                                                          | all                           |
| `apps/desktop/bench` | The bench mode's entry and driver, built only by `vite build --mode bench` ([bench](bench.md))                                                                                                                                                                                                                                         | all                           |

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
  - "All namespaces", or more than a few selected namespaces (default 4), switches to one cluster-wide upstream, if the user may list the kind cluster-wide (one SelfSubjectAccessReview, kept with the context's clients).
    Rust then filters by namespace.
  - Hysteresis: while a cluster-wide upstream runs or lingers, it serves narrower selections too, without holding it, so toggling back and forth costs nothing.
    Once it has lingered out, those selections move to upstreams per namespace, and keep its rows until theirs are listed.
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
  - A request the policy proxy sends carries a marker, `Proxied`, that makes the counter take a stream of the proxy's class whatever its URI, a watch or a followed log included, so it never waits among the hub's, and fail at once with `OverBudget` when they are all taken.
  - The credential layer drops a `401`'s response before its retry, so no request holds two streams: with a budget of one, a request's retry waited for its own first try, or the proxy's refused it (`a_retry_after_a_401_goes_through_a_full_budget_of_one` in `crates/twigo-kube/tests/credentials.rs`).
  - Timeouts start when the counter admits a stream.
    A per-request timeout, a tower layer rather than a socket read timeout, backs the counter up against a server with a lower limit.
    It gives the response's headers 70 s, more than the 60 s the API server allows a request that is not long-running, so it cuts nothing the server still works on.
  - Sessions, meaning exec, attach and port-forward connections, have their own budget (default 64), counted in the same place below every actor.
    A session's permit outlives the `101` response, which `hyper::upgrade::on` drops: the task of the session holds it, a shell's or a forward's connection's, not the upgraded stream, and so does the policy proxy's splice.
    A proxied upgrade takes its session from this budget, not the proxy's 16, and over it gets the proxy's `429` instead of waiting (6.4).
  - A proxy or server that answers HTTP/1.1 turns every stream back into a connection; the budgets stay the same.
    Benchmarks tune each of them.
  - When the watch budget is full, the least recently used idle upstreams are evicted.
    The counter tells a watch that it waits, through an extension of its request, and that is when the hub evicts one: an idle upstream with a watch open, since evicting one in its backoff or in a paged list frees none.
    The freed watch goes to the one that has waited longest, as the counter admits them in order, and an upstream whose watch waits while nobody shows it goes at once, so it takes none from one that is shown.
    When nothing is idle, the new subscription waits in the state `queued` and its view says why, until an upstream of the context lingers and makes way at once.
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
  - Streaming lists (`sendInitialEvents=true`) on 1.34 and later.
    The WatchList gate is off in 1.33, and kube-rs has no fallback.
  - Otherwise a paginated list followed by a watch from its exact `resourceVersion`.
  - The capability is learnt once per cluster, from its first streaming list: 1.33 refuses `sendInitialEvents` with 422 on that field ([`validateWatchOptions`](https://github.com/kubernetes/kubernetes/blob/v1.33.12/staging/src/k8s.io/apimachinery/pkg/apis/meta/internalversion/validation/validation.go#L53-L62)).
    The answer, and the access reviews of the scope, are kept with the context's clients, so clients rebuilt for another server learn them again.
  - A relist, after `410 Gone` or over rebuilt clients, keeps the rows on screen and replaces them with its own once it ends.
  - A changed fingerprint or proxy variables, or a context no source lists any more, retire the connections of its clients at once, so its watches re-open over rebuilt clients and relist, or show that no source lists the context.
    Such clients are abandoned, not only retired: a watch that starts on them later still learns that they were replaced, which a count of retirements, followed from the moment it subscribes, would not tell it; so are clients a build finishes after such a change.
  - A resource the server cannot watch, which answers a watch with 405 as ComponentStatus and metrics do ([`handleWatch`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go#L268-L270)), is listed in pages again every 15 s, the interval of metrics (3.6).
- **Backoff.**
  UI-friendly: 0.5–5 s with jitter, reset on every event.
  kube-runtime's default of 0.8–30 s leaves lists stale for a long time after an API-server restart.
  A watch the server ends without sending anything reopens after the backoff too.
- **Refusals retry too.**
  A `forbidden` or another error shows in the view while the upstream keeps trying with the backoff: a kind 1.33 API server answered a watch it had allowed with 403 for a while after a restart (`restart_live`, 2026-11-02).
  Only `unauthorized`, a 401 the auth layer's retry did not cure or a credential plugin that failed, stops the upstream until a subscription asks for it again, since retrying would run the plugin by itself.

### 3.3 Three upstream kinds

| Kind         | Request                                                                                                                                                                                 | Used for                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Table**    | `GET …?watch=true&allowWatchBookmarks=true&includeObject=Metadata` with `Accept: application/json;as=Table;v=v1;g=meta.k8s.io, application/json`, read through `Client::request_stream` | Every list, for built-in kinds and CRDs alike. The server computes the columns, the same as `kubectl get -w`.                                                                                                                |
| **Metadata** | List and watch with `Accept: application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1` and `…as=PartialObjectMetadata…`, managedFields skipped at deserialisation               | Indexes: namespaces (for the picker), CRDs and APIServices (discovery invalidation), and owner references for the "Related" tab.                                                                                             |
| **Object**   | List and watch with `fieldSelector=metadata.name=…`, another field selector or none, as a Table with `includeObject=Object`: whole objects with their cells                             | An open editor: live YAML, overview, conflict detection; an object's events; what its describer reads while its Overview is shown, such as a namespace's ReplicaSets or EndpointSlices, or a node's pods by `spec.nodeName`. |

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
| The hub with one Table upstream                | 4.0 MiB |

A Table row takes about 700 bytes, half of a `PartialObjectMeta<Pod>` without managedFields.
The hub's row store adds about 130 bytes a row for its key and map, by `examples/hub_memory.rs` on the same cluster (2026-11-02, three runs alike).

### 3.4 Query views: Rust sorts, filters and windows

The frontend never holds the full list.
A subscription carries a `ListQuery { space, gvr, namespaced, namespaces, labelSelector, fieldSelector, owners, text, columns, sort, countBy, groupBy, values }`.
The field selector goes to the server with the list's requests, as a node's pods need; `owners` keeps the rows whose controller reference names one of its uids, an empty set none, after the labels and before the text and the counts, as a workload's pods are its ReplicaSets'.
`namespaced` comes from discovery, which the webview holds already, so a list subscribes once its space's resources are known: Rust needs the scope for the request's path and for the Namespace column, which a cluster-scoped kind never has.
The webview then sends `setWindow(start, end)` as the user scrolls, covering the visible rows plus about two screens of overscan.

- Rust keeps an incremental ordered index per query view, indexset's two-level B-tree with a Fenwick tree over its nodes: a change finds its place in O(log n) and shifts at most a node of 1,024 entries, and one that fills or empties a node rebuilds the Fenwick tree, O(n/1,024).
  - Cells carry their column type, but many core columns are formatted strings: Pod Ready `1/2`, Restarts `3 (5m ago)`, Age.
  - Rust derives sort keys: a ratio by its fraction, then its total, `0/0` as whole; a count such as `3 (5m ago)` by the count, then the duration; durations such as `1h5m` in seconds; Age by `creationTimestamp`, the youngest first.
    Other text sorts naturally: runs of ASCII digits by value, ASCII letters folded, ties by code points.
    Empty cells come first, then numbers, ratios and text; rows with equal keys follow their ids, ascending in either direction.
  - A sort, a count, a group or values for a column the list lacks do nothing, and no sort sorts by Name.
- Each reader of a row store has a feed of the keys changed since it last read, coalesced, and a key added since then and deleted again leaves it, so it holds no more keys than the reader held and the store holds, however long the reader waits.
  A flush drains it, updates the index row by row and computes what changed **inside the window**; a relist, new columns or new upstreams send every row again.
- Text filter on the columns the table shows, Name always among them: a substring in any case of ASCII letters; `!` before it keeps the rows without one; `/…/` is a case-insensitive regex, and `!/…/` its negation.
  Until the closing slash the text stays a substring, so typing a regex never turns the list into an error; a closed regex that does not parse is refused.
  Fuzzy matching belongs to Quick Access (4.5), not to tables.
  `columns` carries the user's choices by name, and Rust resolves them against its own columns, so the first batch already filters right and a choice for a column the list lacks, such as Namespace under one namespace, does nothing; without choices the columns of priority 0 count.
- Label selectors are matched in Rust against each row's labels, with the grammar and checks of apimachinery's `labels.Parse`.
- Values keep the rows whose column holds one of them, such as a pod's Status in CrashLoopBackOff or Error.
  `countBy` counts the rows that the labels and the text keep before values drop any, so a filter by health keeps every health's count.
- `groupBy { column, collapsed }` groups the rows by a column's text: groups in the natural order of their values, the empty value last, and rows within a group by the sort.
  Only groups with a matching row show; a batch carries them whenever one appears, goes, moves or changes, each with its rows and its own `countBy` counts, counted before values drop any.
  A collapsed group's rows still count, but they leave the sequence the window indexes, so `setWindow` and the window cover only the rows of open groups; the webview puts each group's header before its rows (4.4).
- Each row says where the generated part of its name starts, when the name is its `generateName`, cut to 58 bytes as the API server cuts it, and the five characters the API server appends: after the `generateName`, less a `pod-template-hash` it ends with, so a Deployment's pod `api-7f9c8d6b5-x2kq9` reads `api-` and a quieter rest, and a StatefulSet's `db-0`, whose `generateName` is `db-` but whose controller names it, has none (4.4).
- A list sends rows only while it is ready, relisting or stale; in the other states its view shows the state, as 3.7 has it.
- The mock backend sorts, filters and groups by the same rules, and `packages/protocol/src/query-cases.json` holds cases that both it and Rust's query view run.
  Its regexes are the browser's, which agree with Rust's `regex` crate only where both the pattern and the text are ASCII, without carriage returns, in the syntax both have, since the crate's `\d`, `\w`, `\s` and case folding follow Unicode and its `.` matches a carriage return, and it prints numbers as JavaScript does, `1e-7` where Rust prints `0.0000001`: the shared cases keep to what both read alike.
  It sends the pod columns once a list knows them, from its first page on, as Rust does.
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
  It runs only while the object's events are shown: the Events tab, or the events section of the drawer or the Overview.
  No field of an event is indexed and the API server keeps no watch cache for events by default, so such a query is filtered, by inference from the source, from the namespace's events in etcd ([research](research/details.md#events)).
- **Metrics** (metrics-server).
  - `metrics.k8s.io` cannot be watched, so it is polled every 15 s.
  - Only the namespaces of the rows currently in a visible window are polled, and only while a CPU or memory column is shown.
  - The values merge into the rows in Rust as extra cells.
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
    The API server updates its discovery from such a change in a controller of its own, which may not be done when the change reaches Twigo: apiextensions' discovery controller waits for the CRD's `Established` condition through an informer of its own ([`sync`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiextensions-apiserver/pkg/apiserver/customresource_discovery_controller.go#L105)).
    So discovery is fetched once the changes have been quiet for 0.5 s, or 2 s after the first of them if they keep coming, and again 2 s and 10 s after the last of them.
    A new follower whose upstreams another one left listed fetches at those times too, since the changes they told may still lag.
    On kind 1.37 a CRD came with the first of these, 0.52 to 0.54 s after its creation, in four runs of `a_crd_created_while_followed_comes_without_a_restart` (2026-11-02).
  - Users who may not list CRDs or may not list APIServices poll discovery with its ETags every minute, the interval at which kube-aggregator refreshes an aggregated server's discovery ([`discoveryRefreshInterval`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kube-aggregator/pkg/apiserver/handler_discovery.go#L58)).
    An aggregated server whose resources change while its APIService does not is seen with the next change, or once the space is followed again.
  - A follower first sends the name of the cluster its context reaches, as soon as its clients are built from the kubeconfig and before it asks for discovery, and again whenever an edit moves the context to another cluster.
    An edit drops a discovery request under way, which may wait on the old cluster's timeout or sign-in.
    A space keeps its last resources in the explorer while that name is the same, so a switch shows it at once, and shows a placeholder until the new cluster answers when the name changed.
  - A failed fetch keeps the resources the server last answered to the follower, and is tried again after 5 s, the hub's longest backoff.
    A copy from the disk cache counts only once the server has confirmed it, since only the server's ETags tell apart clusters at the same address with the same trust, as behind a load balancer; clients that cannot be built fail it rather than show another cluster's resources.
  - A fetch whose credential failed stops the follower, since retrying would run the plugin by itself, as for the upstreams (3.2), until the context's fingerprint changes.
    Then it holds its CRD and APIService upstreams anew, which restarts those the failure ended, and fetches again; the fetches due after a change stay, since the server's discovery may still lag it, and a change that the new upstreams list but the old ones had not told yet gets its own.
    The fingerprint is taken once the catalog's sources have been read, so their first read at a start is no change, and it leaves out the oidc tokens that Twigo and kubelogin write back (6.2) and other contexts' entries, so neither sets off a fetch.
    The frontend follows the active space again whenever a credential comes after none or after a failed run.
    A run that a rejected credential sets off by itself does not count: against a server that keeps refusing fresh credentials, every view asking again would run the plugin again, forever.
    A fix on the server's side, as a role binding for the identity, and new oidc tokens are seen once the space is followed again, as after switching to another space and back.
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
- `error` (a typed kind plus a retry)

Every view header and the status bar render these states.
A blank table is never an error state.
A view of several upstreams, one per namespace, shows the least ready of their states.

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

| Part               | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title bar          | Breadcrumb of the space and its namespace scope; in the middle a search field with its key that opens quick access, as VS Code's Command Center; drag region; native traffic lights on macOS. Parts show and hide by keys (⌘B, ⌘J, ⌥⌘B), the View menu and the palette, not buttons                                                                                                                                                                                                                                                                 |
| Space rail         | Tiles of the open spaces (D6, Lens's hotbar), each with a dot of its connection, ⌘1..9 by position, a button that opens any context                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Primary side bar   | View containers as tabs in its header (Explorer, Port forwards, Helm, Extensions and contributed ones); the active one's views: resource tree, saved filters                                                                                                                                                                                                                                                                                                                                                                                        |
| Editor area        | Dockview grid of editor groups: tabs, preview tabs, splits, drag between groups; with no editor open, the space's home                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Panel              | A dockview of its own for sessions opened by URI, its layout kept per space beside the editor area's: logs, shell and terminal tabs now (4.6); the cluster's Events, Output (Twigo logs per channel) and Agent activity (audit, 6.6) later. Its tabs split and move; it maximizes over the editor area and hides with ⌘J                                                                                                                                                                                                                            |
| Secondary side bar | The ACP agent panel later; hidden while nothing lives there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Status bar         | In the shell's colour, entries as data: on the left the active space in its context's colour, with a lock while its mode holds writes back (6.4), a warning while the login shell's environment is missing (6.1), credentials that need the person, the cluster's version, or its connection in words when it is not connected (sync later), one entry with the count of port-forwards, `⇄ 3 forwards`, while there are any, in warning while one fails or reconnects; on the right the active list's rows and how many fail or wait, each a filter |

The parts sit flush, split by hairlines, with no cards or gaps: the owner tried islands, as JetBrains Islands and VS Code's 2026 layout ([research](research/workbench-chrome.md)), and preferred flat parts.
Views are descriptors (ID, title, container, `when`, provider), so the user can move a view to another container, VS Code style.
An editor area with no editor open shows the first watermark a feature registered whose `when` holds, else the workbench's key hints.
`kube` registers the space's home for spaces of one context: the space's tile, name, Kubernetes version and node count; a tile each for nodes, pods, Deployments and warning events, which opens its list with the filter that shows what is wrong (`h=` or `q=`); what needs attention, the abnormal pod statuses by count in words and then nodes not ready and Deployments short of ready, each with a Show; and the keys that open things.
Rust counts each tile's list in a query view with `countBy` and an empty window, so no row crosses the IPC (3.4), and only while the home shows (3.2).
A list the credentials may not read shows "–" and why, never 0.
The layout per space is persisted (dockview `toJSON` and which parts show); part sizes are the app's (4.8).

### 4.2 Spaces (D6)

- A space has an ID, a list of contexts (one or more), a namespace scope and a persisted layout: open inputs, view placement, and what each view keeps, such as the explorer's open sections (4.8).
  M1 serves one-context spaces, whose ID is the context's name; `Space.contexts` stays a list for 7.2.
- The rail shows the spaces whose contexts the catalog lists.
  A space whose context goes away keeps its state and comes back with it.
  When the catalog lists contexts but no space has them, as on the first start, the first context's space opens.
- Switching spaces moves the whole workbench: explorer, editors, status bar, policy badge.
  The rail shows a tile per open space: two letters on the tint of its context's colour, the active one ringed and marked, a dot of its connection (connected, connecting, failed, or idle while another space is active).
  The title bar's breadcrumb names the active space and its namespace scope and opens their pickers.
  Every context has a colour, the only extra colour, from six tokens: red, orange, yellow, green, blue and purple.
  It comes from the context's kubeconfig metadata (5.5), else from the user's pick in Twigo (Set Space Colour… in the palette and the tile's menu, kept in the app's state), else from its environment type (6.4), Production red, Staging orange, Development green and Local blue, else from its name, the same each time, among blue, purple, green and orange: red and yellow stay for the user and the environment types (6.4), so neither says danger by chance.
  Decided with the owner on 2026-11-03, after contexts without metadata left the workbench grey.
  It tints the tile and the title bar's left end behind the breadcrumb, as JetBrains does with a project's colour, and fills the status bar's space entry.
  A space with several contexts shows none.
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
| `k8s://<space>/<group>/<version>/<resource>[/<ns>]/<name>`          | Resource editor with sub-tabs: Overview, YAML, Events, Related; Logs in its title opens the object's logs tab in the panel, and Shell for pods its shell tab           |
| `k8s-list://<space>/<gvr>?ns=…&q=…`                                 | Resource table as an editor, so one can pin "pods in payments where status≠Running" next to another list                                                               |
| `logs://<space>/<group>/<version>/<resource>/<ns>/<name>`           | Logs tab in the panel (4.6): a pod's, or a workload's pods' merged; the core group an empty segment, as in `k8s://`                                                    |
| `exec://<space>/<ns>/<pod>/<container>[?n=2][?attach=1]`            | Shell tab in the panel (4.6): xterm over an exec of the container, `n` for a second shell on it, `attach` for its main process                                         |
| `terminal://<space>/<n>`                                            | Terminal tab in the panel (4.6): xterm over a pty on this machine, pinned to the space's context, numbered within its space                                            |
| `pf://<space>/<forward-id>`                                         | Port-forward tab: state, target and resolved pod, local address, open connections, bytes, errors; Open in browser and Copy address (a quick HTTP request tester later) |
| `diff://edit/apply?editor=<uri>`, `diff://<space>/objects?…`        | Monaco diff: the apply dry-run of an editor's edit, its opened object against the server's now (`edit/server`), Compare with…, any two objects                         |
| `untitled://<space>/manifest-n`                                     | New manifest of a space, numbered within it; its first Apply asks for the target context and, once applied, opens the object it made                                   |
| `twigo://settings`, `twigo://keybindings`, `twigo://extension/<id>` | Settings UI, keybindings UI, extension details                                                                                                                         |

- **Details and preview tabs.**
  A click or Enter on a row opens its details, and Space shows or hides them, as Linear's peek; arrows move them along and Esc closes them.
  - In an editor at least 960 px wide they stand beside the list as an inspector, and the list keeps only its name, ready and status columns, so the selected row stays in view (WCAG 2.4.11); in a narrower one they slide over the list from the right, as Lens's drawer.
  - Their header says what the object is and how it is: the name, its generated part quieter; the status as a pill; the namespace; the controlling owner as a link; the age.
    Then the commands of `resource/details` with their keys, such as Logs (`l`), Show YAML (`e`) and Open in Editor, and later Shell (`s`) and Forward (`f`) as their commands come.
  - Below, the object's views as tabs, Overview, YAML, Events with its warnings counted, and Related, the same views the editor shows; the tab shown stays as the selection moves.
  - The Diagnostics section of step 9 comes first in the Overview when something is wrong: why, in words, with its exit code, restarts, next try and the last log line of the instance that ended, and Previous logs and Logs buttons that open the container's logs tab.
    After a 150 ms pause they hold the object's Object upstream and follow it, as an editor does ([research](research/details.md#following-the-object)).
    The upstreams it leaves behind linger as a list's do, and give way to any watch that waits for the budget (3.2).
    Opening the resource from its details opens a preview tab (italic title); editing it or double-clicking its tab pins it.
    Opening an object from a list's details, or following a link in an object, pins the tab it came from, so the object opens beside it rather than in its place.
- **Compare with….**
  The picker offers the editor's own kind first, from every namespace and not the ones the lists have selected, and asks Rust for it with the text typed, as the pod search of quick access does, so an object past the first rows is found by its name; the objects the space opened lately, of any kind, follow.
  Forbidden cluster-wide, it falls back to the selected namespaces and the object's own, and says so.
  A view reads all its namespaces or none (`combine` takes the least ready part), so one selected namespace that may not be listed refuses the rest: it then tries the object's own namespace alone, and says so; forbidden there too, it says that.
- **A URI and its space.**
  Each space has its own docks, and an editor opens in the dock of the space its URI names.
  An open for the URI of a space other than the one shown waits for that space's dock and opens there when it is the next one mounted; if another space comes first, it is forgotten.
  A forgotten open is reported as closed, so what a feature kept for the URI goes, unless the space's saved layout holds the URI: its tab comes back with the layout, and a restart that answered late keeps its terminal for it.
  A close for such a URI waits for that space's dock too, whichever space is mounted first, so a tab whose edit ended while the person was elsewhere does not stay behind; opening the URI again, or closing one that waits to open, withdraws what waits.
  A provider says which space a URI is of, so an answer that arrives after a switch of spaces cannot open a tab in the wrong space.
  A new manifest's URI names the space it was written in, as an object's does, and its number counts within that space, so a number reused after a restart cannot show the text of one space in another's tab.
- **Object URIs.**
  The core group is an empty segment, `k8s://prod//v1/pods/payments/api-0`, so an object in a namespace has five path segments and a cluster-scoped one four.
- **Sub-tabs.**
  A resource editor's Overview, YAML, Events and Related switch at the right of its group's tab bar, where a list keeps its filters; Rust follows only the one shown.
- **Closing a tab.**
  When an editor that opens, closes or moves, or a space that shows, drops the keyboard focus to the page, the active group takes it, and the active editor its own where it has something to hold it, a text editor or a list's grid, so a key such as ⌘S, ⌘Z or `j` still reaches an editor.
  A tab's X and a middle click close through the editor service as ⌘W does, and the panel's last editor leaves the focus to the editor area's active group.
  An open that the person asked for, from quick access, a button or a command, gives the editor it opened the focus from whatever held it, an editor on screen in another group included, except a field outside the editors.
  One that arrives on its own, such as the diff of an answer or an object that a plan made, and the explorer's, whose tree goes on with its keys, take it only from the page and the dock's own elements, never from another editor or from anything outside the editors (`preserveFocus`).
  A hidden or covered part loses its height and not its elements, so it would keep the focus it held, answer Tab, and take back the focus that quick access or a dialog gives back, and the keys would go on to what nobody sees.
  Such a part is `inert` from the moment the panel's state changes, and the focus held inside moves just before to the other area's active editor, or off the page when that area has none: a maximized panel with nothing open leaves the page without a focus, since the covered editor area is inert and refuses it (the mock in Chromium and WebKit, 2026-11-09).
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
  - Sections have ids and an order, the object's state first: Diagnostics when something is wrong, the kind's first section, conditions, the kind's other sections, extension sections, then metadata and events last.
    Each section holds blocks from a closed set (fields, diagnostics, tables, conditions, containers, data keys, live lists, events, a tree), which the webview renders with a switch that lint holds exhaustive.
  - Core kinds get describers (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, Node, PVC, ConfigMap, Secret): at least what `kubectl describe` prints, plus a Diagnostics section when something is wrong.
    A describer names the objects of other resources it reads, such as a Deployment its ReplicaSets, a Service its EndpointSlices or a node its pods, and `twigo-core` follows them through the hub while the Overview is shown.
  - A container's card shows its state, how it last ended and its resources; the rest of what `kubectl describe` prints of it, its environment and its mounts fold.
  - Any kind, CRDs included, gets a generic overview: the server's printer columns, a `status.conditions` table when present, spec and status as a tree with the descriptions of their schema, metadata, events.
  - A workload's pods, a CronJob's jobs and a node's pods are live resource tables inside the Overview, run by query views: a workload's by the uids of what controls them, a node's by a field selector.
  - Extensions add declarative sections per GVK (5.4), and replace a core section only by naming its id.

### 4.4 Resource tables and the keyboard

- Columns come from the Table `columnDefinitions` (priority 0 by default, wide on toggle), plus Context, CPU and memory when available, and Namespace unless the query names one namespace.
  Each kind keeps a preset for every space: the columns the user showed or hid by name from the head of the actions column (a column nobody chose for follows its priority), the widths they dragged or fitted, and the column the rows are grouped by.
- What a column does is data in `packages/kube`, a rule by kind, then by name, then by `group/resource/column`: its cell, starting width, alignment, whether it is quiet, whether rows group by it, and the tone of its abnormal values.
  Columns keep their widths, numbers and ratios aligned to the end; the name column takes the free width until the user sizes it; a double click on a header's edge fits the column to what it shows.
- Cells read by what matters, data near-monochrome:
  - a name's generated part is quieter, and stays whole when the name is cut, since it tells siblings apart (3.4);
  - a status shows a tone dot, its text coloured when abnormal, the dot pulsing while the state is in flight (ContainerCreating, Terminating);
  - a ratio short of its total (Ready `0/1`) is pending;
  - restarts read as a count in a column of its own and how long ago the last was;
  - Namespace and Age are quiet, a zero count and empty values grey.
- A failing or pending row has an edge in its tone at its left.
- Grouping by a column (Namespace, Node, a status) puts a header before each group with its rows and how many fail or wait; a click or Enter folds it, Left goes to it from a row, and folded groups are kept per list.
- The last column is the row's actions: a ⋯ button on hover and on the selected row, and the same menu on a right click, from `resource/context`; a hovered row also shows the commands of `resource/inline` that have icons.
  They act on the selected row of the active list.
- Marks: X marks the row under the cursor, ⇧↓ and ⇧↑ mark as they move, a click on a row's box marks it; Space shows the details (4.3).
  Marked rows get a bar at the bottom with the commands of `resource/marked`; Esc clears them.
  A change of the list's text, health or, for a namespaced kind, namespaces clears them too, as a new search clears a selection, so no command acts on rows the list no longer shows.
  Marks are row IDs (3.4).
- Focus model: arrows or `j`/`k` move, Enter opens, Left and Right fold, `/` or ⌘F filters, Esc clears.
  These are the workbench's `list.*` commands, which drive every list and tree.
- A list's filters sit at the right of its group's tab strip, as the editor's actions (`editor/title`): its health as one control of All, Failing, Pending and Healthy with their counts, for kinds with a health column, a pod's or a node's Status or a Deployment's Ready; the text field, which names its syntax and its key; the grouping; and a pin.
  They take no row of their own, so a table sits under three bars: title, tabs, header.
  Each open list keeps its own; a count in the status bar picks the same health.
- A pinned list keeps its namespaces, text and health in its URI and shows at the top of the explorer; a kind whose list is open shows its rows and its worst health there.
- Single-key verbs work only when a table is focused (context key `listFocus`): `l` logs, `s` shell, `e` edit YAML, `d` describe/overview, `y` copy YAML, `f` port-forward, `⇧J` jump to owner, `⌘⌫` delete (with confirmation), off a bare key since k9s users deleted the wrong object from one ([research](research/workbench-design.md)).
  Bare letters read; a write is ⇧ and a letter, with its friction (6.4): `⇧S` scale, `⇧R` restart, `⇧C` cordon, `⇧U` uncordon, `⇧D` drain, `⇧T` trigger, `⇧P` suspend, `⇧O` resume.
  `⌘⌫` deletes the marked rows while there are marks, else the selected one.
  These are ordinary commands with keybindings, so users can remap them.
- Changed cells flash briefly: the cell's background starts at the `--flash` tint and fades out over 1 s, as the opacity of a layer behind the text, which runs on the compositor and leaves the page asleep ([bench](bench.md#the-visible-window)).
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

- **The widget** drops from the title bar's search field, centred under the title bar and min(600 px, 62 vw) wide, as VS Code's quick input.
- **Rows are data** (`QuickPickItem`) that the widget draws alike for every provider: the kind's icon or a space's tile, the label with what matched the filter bold in the brand colour, a quiet description such as the namespace, a state only when it is abnormal as its dot and its words in its tone, a quieter kind at the end, and keys.
  Filters match as Sublime Text does (fuzzysort), so a row's highlight is what its score came from; the pods of the no-prefix provider are filtered in Rust by substring, and highlight that.
- **Recent first.**
  The no-prefix provider shows the space's recently opened editors that match under Recent, each with its kind and namespace, then the pods; `workbench.recent` keeps them per space (4.8).
- **A footer of keys**: ↑↓ move, ↵ the provider's verb (Open, Run, Switch), and ⌘↵ open to the side where the provider can, which opens the editor in a new group to the right of the active one.
  Each is the binding of a `quickInput.*` command, so a key the user binds shows there.
  On the empty prefix the footer adds the prefixes whose providers name themselves for it (`>` Commands, `:` Lists, `?` Help), so a new provider shows up by registering.

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
    - a logs tab lives in the panel (4.1), a `logs://` input; `l` on a row, in the details and in their context menu, Logs in an object editor's title and a finding's buttons open it or focus the open one, so logs live in one place and a pod's editor has no Logs sub-tab;
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
    - a line shows its text as the container wrote it, ANSI colours as tokens at 4.5:1 or more on the editor, warnings and errors tinted with an edge as failing rows are; markers say that a container ended, with its code and next start, that a pod joined from its ReplicaSet or left, and what the buffer dropped;
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
    A shell is a `exec://` editor of the panel, opened by `s` on a pod, by Shell in its details, context menu and editor title, and by Attach, which joins the container's main process.
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
    On Linux and Windows `mod` is Ctrl, which a shell needs, so only quick access, the command palette and the toggle of the panel win over the shell, a short list as VS Code's `commandsToSkipShell` is, and every other Ctrl chord stays with it.
    New Terminal and Toggle Terminal join that list on every platform, since their keys, ⌃⇧\` and ⌃\`, are Ctrl chords on macOS too.
    Copy and paste ride on the `copy` and `paste` events, which xterm answers with the selection and with `Terminal.paste`, so bracketed paste works; the Edit menu keeps its Copy and Paste for them.
    A `linkHandler` makes OSC 8 links do nothing unless ⌘-clicked, and opens only what the app's opener takes, `https` and `http` on localhost; xterm's `confirm` and `window.open` never run, and no addon detects URLs.
  - **Endings.**
    A session's ending has its words, which stand once in the scrollback, in a quiet colour, with its state and Restart at the right of the tab strip: `Session ended.`, `Session ended with exit code N.`, `Session ended by SIGKILL.` (`SIG` and the signal's name), `The attach ended.`, `This container has no shell.` with the runtime's message, the error's own message, `The connection was lost. A shell cannot be resumed.`, and `The context became read-only.`.
    A finished tab stays with its scrollback readable and selectable and its input off, until it is closed or restarted; Restart plans a new shell, so `guarded` asks again.
    A session that waits for a place among the cluster's 64 says so in its tab, and the status bar lists open shells while there are any, to go to one or close it.
  - The theme is the editor's surface and the logs' sixteen colours from the tokens, and follows the document's theme live.
- **Port-forward manager.**
  A target is a Pod, a Service or a Deployment, ReplicaSet, StatefulSet or DaemonSet, and a forward is one port of one target, named by the target the person chose; the pod it reaches is a detail of it.
  The data path is `twigo_sessions::forward`; the table, the policy and what is kept are `twigo_core::forward`.
  - **The listener.**
    The manager binds `127.0.0.1`, which must bind, and `::1` on the same port where this machine has it, as kubectl's `localhost` does, and keeps both for the life of the forward, whatever happens to pods, so no other process can take the port between check and bind.
    A port that either loopback cannot give is answered as data, in use or not permitted, with the next free port above it, from 1024 up, found by binding on those two addresses.
    A port that another process holds on `0.0.0.0` or `[::]` is in use too.
    `SO_REUSEADDR`, which [mio sets](https://github.com/tokio-rs/mio/blob/v1.2.4/src/net/tcp/listener.rs#L67-L82) and which a port needs to bind again while the connections it served wait out `TIME_WAIT`, makes macOS bind `127.0.0.1:P` beside such a listener and give the new socket that process's loopback clients, where Linux refuses with or without it (bind probes of macOS 27.2 and of Linux 6.12.54 in Docker Desktop, 2026-11-12).
    So Linux binds with the option, Windows without it, as mio does, since there it lets a socket in use be bound over, and macOS binds without it first; when that finds the port in use, the port is busy unless nothing accepts a connection on it, which leaves only the connections of a closed listener that are still open or wait out `TIME_WAIT`, and then binds with the option.
    A forward's listeners close when the forward is dropped, so a stop, a move and a shutdown return with the port free.
    The local port of a start is the one that port of that target had last, else the same number, else for a port below 1024 that number plus 8000.
    A free port offered in place of a busy one is never taken silently, and starting on it is not remembered.
  - **The pod.**
    - A Pod target is that pod by name while it exists and is `Running`, as kubectl wants ([`portforward.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/kubectl/pkg/cmd/portforward/portforward.go#L427-L428)); a pod made again under the name is the same target.
      One that does not run yet, or has finished, is no candidate, so a connection waits for it, 20 s at most, as behind a Service.
    - A Service's pods come from the EndpointSlices that carry its name: endpoints whose `serving` is not false and `terminating` not true, with a `targetRef` of kind Pod, one per pod uid whatever address families it has.
      The pod's port is the entry of the same slice that carries the Service port's name, so a named `targetPort` that pods resolve differently needs no pod spec.
      A Service with no such endpoint says why: it is an ExternalName, its endpoints are not pods, or no pod is ready.
    - A workload's pods are those it controls by controller reference, as the logs find them, a Deployment's through its ReplicaSets; they count when they are Ready by their conditions and not being deleted, and a workload's port that has a name is each pod's container port of that name.
    - The pod is sticky.
      Connections go to the forward's current pod while it is a candidate, so a client's connections do not spread over the replicas; another is picked when it leaves or a connection to it fails, and a pod that failed is avoided for a backoff unless it is the only one.
      Connections already open keep their pod.
  - **A connection.**
    Each accepted TCP connection holds a place among the context's sessions (3.2) for its life, waiting in `queued` when the budget is full, then goes to the current pod, waiting 20 s at most for one to be a candidate.
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
    `Starting` while the first pod is found and one stream to it is opened and dropped, which proves the credentials, the rights, the upgrade and, by the pod's silence for 250 ms, that something listens: a port that nothing listens on answered on the error channel within 36 ms of the request (20 tries, kind 1.37, containerd 2.3.4, 2026-11-11).
    No access review comes first, since from 1.35 the upgrade needs `get` and `create` on `pods/portforward` and before that `get` (6.3).
    `Ready` once it worked, and only if a pod can still be reached when the stream proves it; a connection that carries bytes while the proof is waiting proves it as well.
    The first stream's place among the sessions is waited for 15 s.
    A forward that worked goes to `Reconnecting` with its reason when a pod or the cluster does not answer, and tries again with a backoff; the hub tries its own errors again, so a forward that worked waits on them, and one that never worked fails at once with the cluster's words.
    A cluster that does not answer is said so: `the cluster does not answer` is the reason of a forward that worked and of the failure of a connection that waited 20 s for a pod, and the words a forward that never worked fails with after the same 20 s.
    A hub that has no watch to give is said so too, `every watch of this context is in use`, in the same places.
    A forward that never worked waits no longer than 20 s for the hub to list anything, and fails with `the cluster has not answered yet` if the hub is still connecting.
    A forward whose credentials, rights or policy are refused (a `401`, a `403` on a stream, the gate's) goes to `Failed`.
    A failed forward ends its connections, keeps listening and closes what it accepts at once, until it is started again; one that failed because its target is gone looks at the target again at its next connection, as a forward that worked, so a pod made again under its name goes on, and one that is still Pending or refuses makes it `Reconnecting` with the reason and does not fail it for good.
    A resume starts a failed forward again and leaves one that works, or waits for its first connection, as it is.
    `Restored` is a forward that listens since the app started and has not asked its cluster yet; `Stopped` is one that does not listen and is kept.
    A connection that fails after the forward was ready sets the forward's `failure` and changes nothing else.
    The `failure` holds until a connection opened after it carries bytes from the pod, or the forward is ready again after not being so.
    So one refused connection does not show for the whole life of a forward that stays ready, and a connection opened before the failure, or one that carried nothing, leaves it.
  - **Watching.**
    A forward reads its target through the hub only while it has connections or proves that it can be reached: its subscriptions start with a connection and go when the last one closes, so a listening forward that nobody uses costs none of the context's 24 watches.
    A forward that waits for a pod, with no connection, lets them go as well, keeps saying why it waits, and looks again when a connection comes.
    So does a forward that worked and whose try to reach a pod failed, a pod whose container crash-loops or whose node does not answer: with connections it tries again with a backoff, and when the last one closes it keeps its reason and tries again at the next.
    A forward that is proving holds them until the proof ends, which the 15 s and 20 s waits above bound.
  - **Keeping them.**
    A space keeps its forwards and the local port each target's port had last under a key that only Rust writes, as it does the modes, so the webview follows them and cannot overwrite them (4.8).
    Ids are unique in the app and never reused across restarts.
    Whether a forward's local port is a detour is kept with the forward, and a detour is never remembered, not by a stop and a resume either; a port shows the local port of its forward where it has one.
    A local port of 0 is refused.
    The bytes count since the app started, so a stop, a resume and a move keep them.
    A forward that ran listens on its port again at a start and waits, `Restored`, for its first connection or for its space to connect, which is when the core makes the clients of its context; no credential plugin runs at a start.
    A port that another process holds, or that another forward of Twigo holds, or a context the catalog does not list, makes it `Failed` with that; a target that is gone is found once the forward is asked, and fails with `NotFound` and its name.
    A start that comes while the forwards are being restored wins: a port of a target has one forward, and the saved one for it is dropped.
    The state is written in the order of the table's snapshots.
    A stopped forward stays stopped.
  - **The mode.**
    A forward changes nothing in the cluster, so it does not go through the command bus: the gate decides each connection's upgrade, and the manager asks the policy and the catalog again for each running forward's context, reading both under the table's lock, whenever either changes, when a start, a resume or a move puts a forward in, and when the context's clients are made.
    When the mode comes to refuse forwards (`read-only` with `readOnly.allowPortForward: false`), or the catalog loses the context, its connections end and it is `Failed` with the gate's words or the missing context's, still listening, until that passes.
    A resume or a move computes the refusal before it restarts anything and keeps one that holds, and the refusal's words are those of its cause now, a missing context or the mode, as that changes.
    It then goes back to what it was: a forward that waited for its first connection waits again and asks no cluster, any other starts over.
    A move leaves a forward that waits for its first connection waiting, on its new port.
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
  - **Terminals of every other context**, including one temporarily unlocked, get only a generated policy-proxy kubeconfig (6.4), a process of the terminal's actor, label and window that ends when its shell does, so a job the shell left, its file and its tokens gone, reaches nothing.
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
    In the default window, 1280 px with the explorer open, the warning `Your credentials · read-only context` is whole at 236 px beside two tabs, 189 px wide beside five and 63 px beside six, all six keeping their titles where a chip of a fixed 10 rem put the sixth into the overflow in Chrome, and its icon alone, 34 px, beside eight, which overflow anyway (the mock in Chrome and in Playwright's WebKit, 2026-11-11).
    A move or a dismiss of an offer leaves them, since the entries stay in the terminal's file.
    A terminal in a shell that Twigo cannot set `KUBECONFIG` in again after its startup files (`kubeconfigKept` false: any but zsh, bash, fish and pwsh) says `KUBECONFIG not kept` in the chip, in the same tone: a startup file of that shell may replace the terminal's `KUBECONFIG`, so a proxy terminal could then reach clusters with the person's credentials, and a terminal with real credentials may no longer be pinned to its context.
    Toggle Terminal (⌃\`) shows the panel with the space's last terminal focused, starts one when the space has none, and hides the panel when a terminal has the focus.
    Go to Terminal… and Close Terminal… are in the palette; a terminal holds no cluster's place, so the status bar lists none.
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
    An offer is a toast at the window's bottom right that stays until it is answered and has no close of its own.
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
The toasts exist; the centre does not yet.
Every long operation reports progress from Rust: drain, apply, Helm, provider "Create cluster".
A command's run tells how it goes over the channel of `command_execute` (5.1).
The status bar shows a run that waits, as for a deleted namespace to go, until it ends, and a click stops the wait; a toast says how it ended, and an error waits to be read.
An action with an undo ends in a toast that offers it for as long as it lasts, a bar running down under it, and ⌘Z in the list does the same (6.4).

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
    The app keeps the rail's spaces in order, the active space, part sizes, quick-access history, the columns chosen per kind and the colours chosen for contexts.
    A space keeps its editors, which parts show and their containers, moved views, its namespace scope, the editors it opened recently and each view's own state.
  - Part sizes are the app's, so switching spaces never moves the splits; VS Code keeps them per profile for the same reason.
  - Each value is a key that one module owns, such as `parts`, `namespaces`, `recent` or `view/<id>` in a space, and `parts/sizes` or `quickaccess/history` in the app.
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
  - A file that cannot be read, or has another version, moves aside as `state.json.unreadable`, and the app starts with nothing remembered.
    Before users exist there are no migrations.
  - Secrets never go into the state: they stay in Rust and the keychain (6.2).
  - Until the settings files come in M3, the mode a person chooses for a context and the type they mark it as live here too, under a key `state_set` refuses, since only a command changes a mode.
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
  - Neutral greys with a trace of the brand hue: an app's chrome, not a tinted dashboard.
    The shell and the side bars share one tone and the editor is the surface that stands out: white under a 0.975 shell on light; on dark the darkest, 0.185 under a 0.218 shell, as VS Code's Dark 2026, JetBrains Islands and Zed draw it, with card 0.25 and popover 0.27 above both.
    Text sits a step below white on dark (0.87).
  - Three text tiers, each at 4.5:1 or more on the shell and the editor (WCAG 1.4.3): primary, secondary for what places a row, tertiary for units, hints and empty values ([research](research/workbench-design.md)).
    On a selected row tertiary reads as secondary, and text in a tone reads at 4.5:1 on a selected row and its pill's tint too.
  - Tones: error, warn, ok and idle; `--warn` fills dots and edges, and `--warn-foreground` is its readable text.
  - Hover and selection are alpha overlays, so they work on any surface.
  - A two-layer focus ring: a solid brand line, 3:1 or more on any surface (WCAG 1.4.11), and a translucent halo.
  - Hairline borders in alpha tiers.
  - The status bar takes the shell's colour; colour there comes only from its entries' tones and the active space's context colour, as VS Code's 2026 themes do, and from the whole bar's tint in a production context (6.4).
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
    A tone has a shape too, so no state rests on hue alone (WCAG 1.4.1): error a filled dot, warn a ring, and a pulse only while a state is in flight.
    Rows, namespaces and labels are never coloured; a failing or pending row has only an edge in its tone.
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
- **Settled with the owner** on 2026-11-03, from live mockups after [research](research/workbench-design.md) into Kubernetes clients, IDEs, operations tools and guidelines:
  - the resource list of 4.4 as a whole, grouping included: search in the middle of the title bar, connection dots on the rail, counts and pins in the explorer, a status bar in the shell's colour;
  - the editor darker than the shell in dark;
  - text tiers at 4.5:1, a solid focus ring, tones drawn by shape;
  - the space's home in an empty editor area (4.1), without the mockup's capacity and trend, for which Twigo has no data.
- **Settled with the owner** on 2026-11-03, from live variants of the Overview (4.3): the object's state before its metadata, and containers as cards whose less used fields fold.

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
  - Each is an action of the command bus in `twigo-core`, planned first through `command_plan`.
    Rust finds what it acts on, refuses what the policy blocks before anything is asked, and answers with what it will do, in words and as the equivalent kubectl command, and the friction its blast radius asks for in the context's mode (6.4).
  - The webview draws the friction and runs the plan by its id through `command_execute`, with what proves the friction was met: the name typed, the countdown passed.
    Rust checks the proof, runs a plan once, only from the window it was made for and on the cluster it was planned for, refuses it when the mode now asks for more, and decides on the policy again; the gate checks each request as it goes out.
  - `command_cancel` drops a plan, or stops a run where stopping leaves what it sent standing, as the wait for a deleted object to go.
  - Args are resource references (`ResourceRef`), never full objects.
    What a command still needs is asked in quick access, as VS Code's input box: scale's replicas, prefilled with what the row says.
- **Menus are data that point at commands**, with `group`, `order` and `when`, as VS Code's MenuRegistry.
  The menu IDs:
  - `commandPalette`
  - `resource/context` (row context menu)
  - `resource/details` (details header, 4.3)
  - `resource/inline` (row icon buttons on hover, 4.4)
  - `resource/marked` (marked rows' bar, 4.4)
  - `resource/title` (resource editor toolbar)
  - `view/title`, `view/item`
  - `editor/title`
  - `edit/toolbar`, `edit/changed`, `edit/conflicts`, `edit/immutable`, `edit/diff`, `edit/answer` (the YAML editor's toolbar and the bars of what an apply answered, 4.3, 6.5)
  - `space/context`
  - `statusBar`
  - `explorer/kind`

  The native macOS menu is generated from the registry, replacing legacy `menu.ts`'s hand-written list.

- **Context keys** are typed values scoped to the focused element.
  A `when` expression evaluates them, using a subset of the VS Code grammar: `==`, `!=`, `&&`, `||`, `!`, `=~`, `in`, `<`, `>`.
  Core keys:
  - `space.id`, `space.contexts`, `space.multiContext`
  - `context.name`, `context.readOnly`, `context.mode`, `context.unlocked`, `context.provider`
  - `listFocus`, `treeFocus` (a tree, which is also a list: left and right close and open), `editorFocus`, `inputFocus`
  - `inQuickOpen`, `quickOpenToSide` (the open provider opens rows to the side)
  - `resource.group`, `resource.kind`, `resource.namespaced`, `resource.namespace`, `resource.scalable` (discovery lists its `scale` subresource)
  - `resource.cordoned`, `resource.suspended`, `resource.ended`: what the selected row's cells say, so a menu offers Uncordon only on a cordoned node, Resume only on a suspended Job or CronJob, and neither Suspend nor Resume on a Job that ended
  - `selection.count`
  - `editor.open`, `editor.dirty`, `editor.type`
  - `capability.<verb>.<resource>[/<subresource>]`, the resource by kubectl's name (`capability.create.jobs.batch`), and `resource.capability.<verb>[/<subresource>]` for the list's own resource, which a command of every resource, as delete, cannot name.
    A list asks `access_review` for the keys some command's enablement reads, in the selected row's namespace and, for the list's own resource, by the row's name, which a rule that lists `resourceNames` needs; Rust answers each with a SelfSubjectAccessReview kept with the context's clients, for the whole resource first and by name only when that says no, and asks about a namespace in that namespace, as kube-apiserver authorizes it.
    The Delete of the marked rows reads `marked.capability.delete` instead, the list's delete asked for each marked row, and true only where every answer is.
    A key holds until its answer says no, and one the cluster cannot answer holds, so only what RBAC refuses is disabled and the server still decides.
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
- **Bare keys** fire only in `listFocus` and never inside inputs or Monaco.
  This keeps legacy `isTypingTarget`.
  Quick access's input is the one exception, for ↑, ↓ and Enter under `inQuickOpen`: they edit no line of text, and drive its list as in VS Code's quick input.
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
    - A listed file that does not exist is skipped, as client-go skips it; one that cannot be read or parsed is skipped and logged, and the other files still count.
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
  Each field is read on its own, so a value Twigo does not know drops only that field; `readOnly` alone reads anything but `false` as a lock (6.4).
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
  - The digests live in `trust.json` beside the state store, which only Rust writes; an unreadable file trusts nothing.
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
    Whether every aggregated API server honours it is not verified.
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
    Nothing goes out once the process's handle has dropped: every send races the process's end, the reads an ask makes to show what a request would do included, so a request accepted before it, its body still coming or its ask answered at that moment, gets a `403` instead of the server's answer, and no ask is shown for a process that has ended.
  - `Impersonate-*` goes on unless the context's kubeconfig acts as someone already, which gets a `400`: kube appends its own impersonation headers to the request's, and a request of two identities is not what the person asked for.
  - `Authorization`, `Host` and hop-by-hop headers stop at the proxy, `Upgrade` and `Connection: Upgrade` excepted on an upgrade; `User-Agent`, `Kubectl-Command` and the WebSocket and SPDY headers pass as they came, and nothing is added.
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
      It shows the verb, the target, the client's `Kubectl-Command`, whom `--as` acts as, and what the request would do: a dry run of the same request through the same actor's clients against the live object for a write of a resource itself, a Secret's values masked and none of the server's words about it shown, as a refusal of a patch quotes the patched Secret whole, but only in groups kube-apiserver serves itself, as an aggregated server that ignored `dryRun` would perform the write before the person answers; whether an APIService names a `spec.service` is read as the actor and kept 5 minutes of the wall clock.
    - Every `DELETE`, whatever RBAC calls it, and every eviction of a pod, which deletes the pod, asks for the typed context name and shows the propagation its options ask for, and "for 15 minutes" never covers one.
      "For 15 minutes" holds only while the context's mode, where it comes from, its connection and all else the catalog says of it stay, a change that went back included, and ends with the process's handle.
      Given, it also lets through the process's other asks on the context that are still waiting, each withdrawn from the window and noted `lasting`, and its requests whose ask is still reading what to show, but a delete's, which waits on.
    - One answer covers a request's repeats for 15 s of the wall clock, by token, method, path, query, body, every `Impersonate-*` header and `Content-Type`, and whether it upgrades: kubectl repeats a write after each `429`, and a refused exec, attach or port-forward of a pod, its WebSocket `GET`, over SPDY as a `POST`, so for those alone a `GET` and a `POST` are one.
      The same bytes acting as someone else, or read as another kind of patch, are another request, which asks again.
      A denial covers every repeat; "once" covers only a repeat of the verb, decoded path and class it was answered for, the `GET` and `POST` of a pod's stream as one, and one request at a time.
      A request takes it as it is sent and gives it back only when it reached no server: after the proxy's own `429`, or a pod's stream answered other than `101`, as nothing of it runs before the kubelet's `101` ([`ServeExec`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/cri-streaming/pkg/streaming/remotecommand/exec.go#L40-L48)); a proxy's answer came from its backend, and a request whose client went may have reached the server, so neither gives it back.
    - An ask is withdrawn when its request goes, as when kubectl is killed, when the process's handle drops, when the window goes, and when the context's access changes so that the request needs no approval any more, which then goes on as the gate says.
    - The audit log notes how each ask ended: `once`, `lasting`, `denied`, `nobody` when no window could ask, or `withdrawn`.
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

| Operation                                                                     | `read-write`                            | `guarded`                             | `read-only`                                            |
| ----------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| get, list, watch, logs, events, discovery                                     | ✓                                       | ✓                                     | ✓                                                      |
| Reveal secret-grade data (3.6)                                                | ✓                                       | confirm                               | confirm                                                |
| Port-forward                                                                  | ✓                                       | ✓                                     | ✓ unless `readOnly.allowPortForward: false`            |
| exec, attach, ephemeral debug container                                       | ✓                                       | confirm                               | ✗                                                      |
| create, apply, patch, update (dry-run diff always shown)                      | ✓                                       | confirm with the diff                 | ✗ (dry-run still allowed, so a change can be prepared) |
| delete, scale, rollout restart, cordon, drain, evict, Helm rollback/uninstall | ✓ with friction by blast radius (below) | typed confirmation (the context name) | ✗                                                      |

- **Where the mode comes from**, highest first:
  1. a policy file entry, which the UI cannot change or unlock; of several that match, the strictest;
  2. no source lists the context now: `read-only`, since clients built before it went may still run and nothing says what it lets through;
  3. the person's choice for the context;
  4. kubeconfig metadata (`twigo.readOnly`), where a value other than true or false counts as true;
  5. the provider (Segla can mark production clusters);
  6. the default of its environment type: `read-only` for Production, `guarded` for Staging and `read-write` for the rest;
  7. the default `read-write`.

  The mode is read for every request, so a change reaches clients already built.

- **Unlock for 15 minutes.**
  A command switches a `read-only` context to `guarded` for a limited time, and a command that such a lock refused offers it in the toast that says so; a policy file's lock offers nothing.
  A banner shows the countdown, and the context relocks by itself.
  The gate reads the wall clock, as timers stop while the machine sleeps, and nothing stores an unlock, so a restart relocks.
  An unlock holds only while the context's fingerprint stays, so one given on a cluster never reaches another its name moves to, and a new choice or type ends it.
- **Clients keep to what they were built for.**
  Clients of a context that now names another cluster still reach the old one until their owner re-opens, so their gate reads them as `read-only` from the moment the fingerprint changes, whatever the new one's mode is.
- **Every blocked request** returns a typed `permissions` error with the mode and its source, and the UI shows which rule blocked it.
- **The audit log** is `audit.jsonl` in the app-data directory, mode 0600.
  The gate notes each write it sends, just above the socket, or stops, with the actor, the context and its mode; the command bus notes what a person confirmed, through which friction, and how it ended.
  It names targets, never a value, so the actors of M3 only add their name.
  A file that cannot be opened is said on stderr and keeps nothing: the log records, it guards nothing.
- **How the UI shows a mode and asks before damage**, designed with the owner on 2026-11-03 ([research](research/workbench-design.md)), for M2:
  - Environment types, Production, Staging, Development and Local, set a context's colour and its default mode.
    A person marks a context, or its kubeconfig metadata says so (`twigo.environment`, 5.5), and the person's mark wins, their None included.
    Nothing guesses a type from a context's name: a context nobody marked is `read-write` with no chip, and only an admin's policy file sets modes by glob (4.8).
  - A production context is a mode with two cues (NN/g): a chip in the title bar after its name that says the type and the lock (`Production · read-only`), and the status bar tinted in it.
    The mockup's third, a 2 px line of its colour along the title bar's top, was dropped on 2026-11-07: the chip, the tint and the bar's left end in the context's colour already say it.
    The chip opens what set the mode, in words, with the choices the person has.
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
| Extensions    | Tiers 0 and 1, the WIT API at `0.x` (unstable; release builds load allowlisted IDs only), cluster providers, the fixture extension. Private: the Segla extension is the first consumer; there is no public registry yet                                                                                 |
| Release       | Auto-update, signing, notarization, the performance budgets checked in CI                                                                                                                                                                                                                               |

### 7.2 Later (rough order)

1. **Windows** (D2): WebView2, Authenticode signing, the registry environment, `CREATE_NO_WINDOW` for exec plugins, and the tier-2 frame probe of `bench/ipc` on WebView2.
2. **More resources and sessions:**
   - multi-context spaces with merged tables;
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
  MCP server, extension tiers 0 and 1 with the Segla extension, settings UI, keybindings editor, auto-update, signing, documentation.

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
