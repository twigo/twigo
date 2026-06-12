# Twigo architecture

Twigo is a desktop IDE for NATS, built like a real IDE workbench: a **domain-free
shell** (activity bar, sidebar, tabbed editor, detail panel, status bar, command
palette) that knows nothing about NATS, plus a **NATS module** that contributes
everything domain-specific through a small set of registries. The goal is that
the core could host a second domain (e.g. a Kubernetes IDE) by adding a sibling
module — not by editing the shell.

This document describes how the pieces fit and how to add a new domain.

## Big picture

```
┌──────────────────────────── Tauri (Rust) ────────────────────────────┐
│  src-tauri/src/nats/*   async-nats client, JetStream/KV/Object/monitor │
│  #[tauri::command] handlers (lib.rs) · events: nats:event, nats:*      │
└───────────────────────────────▲───────────────────────────────────────┘
                                 │  IPC (invoke + Channels + events)
                                 │  typed wrappers in src/lib/api.ts
┌───────────────────────────────┴───────────────────────────────────────┐
│  React frontend (apps/twigo/src)                                       │
│                                                                        │
│  shell (domain-free)            registries            NATS module      │
│  ───────────────────            ──────────            ───────────      │
│  components/workbench/*   ◄──►  src/shell/*      ◄──  src/modules/nats/* │
│  shell stores (ui, …)           lib/commands          components/views/* │
│                                 store/connScoped       components/editor/* │
│                                                        NATS stores        │
└────────────────────────────────────────────────────────────────────────┘
```

Monorepo (pnpm workspace): `apps/twigo` (the app), `libs/ui` (design system —
shadcn/Tailwind tokens), `libs/utils` (pure helpers). The frontend talks to the
Rust backend only through `src/lib/api.ts`.

## The shell / domain split

The single most important rule: **the workbench shell imports no domain code.**
It reaches NATS only through registries that the module fills.

|                    | Shell (domain-free)                                                                                 | NATS domain                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| UI                 | `components/workbench/*` (AppShell, ActivityBar, StatusBar, CommandPalette, ShortcutsHelp, Toaster) | `components/views/*`, `components/editor/*`, `src/modules/nats/*`                                |
| Registries / infra | `src/shell/*`, `lib/commands.ts`, `store/connScoped.ts`                                             | —                                                                                                |
| Stores             | `store/ui`, `store/palette`, `store/help`, `store/toasts`                                           | `store/connections`, `stream`, `subjects`, `jetstream`, `kv`, `objstore`, `monitor`, `responder` |
| IPC                | —                                                                                                   | `lib/api.ts`, `lib/actions.ts`, `lib/editor.ts`                                                  |

This boundary is **enforced by ESLint** (`@typescript-eslint/no-restricted-imports`
in `eslint.config.js`): `components/workbench/**` and `src/shell/**` may not
import NATS stores, `@/modules/**`, `@/lib/api`, `@/lib/actions`, or domain
view/editor components. `AppShell` is the one exception — it composes the pane
components — but still may not reach into domain state/modules/IPC.

`App.tsx` (the composition root) and `main.tsx` (the entry) are allowed to wire
the domain in; that is where module registration happens.

## Contribution registries

Each registry is a tiny module: a `Map`/array plus `register*` / `get*` (and a
`clear*` for tests). A domain module fills them; the shell reads them.

| Registry           | File                      | Holds                                                          | Read by                                 |
| ------------------ | ------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| Views (viewlets)   | `src/shell/views.ts`      | `{ id, title, icon, order, Panel }`                            | ActivityBar, Sidebar, view-nav commands |
| Commands           | `src/lib/commands.ts`     | shell commands + `registerCommand` / `registerCommandProvider` | CommandPalette, ShortcutsHelp           |
| Status segments    | `src/shell/statusBar.ts`  | `{ id, side, order, render }`                                  | StatusBar                               |
| Watermark          | `src/shell/watermark.tsx` | the editor zero-state component                                | EditorArea                              |
| Conn-scoped stores | `src/store/connScoped.ts` | stores to `reset(connId)` on disconnect                        | connections teardown                    |

Notes:

- **Commands** live in `lib/commands.ts` because the shell contributes its own
  (theme, layout, settings, help, editor split) and owns the dispatch utilities
  (`matchKeybinding`, `fmtBinding`, `isTypingTarget`, `PALETTE_BINDINGS`).
  `getCommands()` merges shell commands + view-nav (derived from the view
  registry) + registered providers, filtered by each command's `when()`.
- **Conn-scoped** stores self-register (`registerConnScoped(useX)`); the
  connections store drops them all via `resetConnScopedStores(connId)` without
  importing any of them.
- The **editor** panel registry (`components/editor/registry.ts`) is still a
  typed `Record<EditorType, EditorDef>` (compile-time exhaustiveness), not a
  runtime registry — it becomes one when a second domain actually exists
  (rule of three).

## Module lifecycle

A domain module has two entry points:

1. **Registration (import time).** `registerNatsModule()` in
   `src/modules/nats/index.ts` is called once from `main.tsx` before the first
   render. It registers views, commands, status segments and the watermark.
   (Conn-scoped stores register themselves on import.)

2. **Runtime (React effects).** `useNatsRuntime()` in
   `src/modules/nats/runtime.ts` is called once from the `Workbench` root. It
   restores the previous session (reconnect saved connections, resume subject
   watches) and bridges backend `nats:event` / `nats:reconnect` /
   `subjects:update` events into the stores.

So `App.tsx` is just: call the runtime hook, render `<AppShell/>`.

## Store layer

- **`createConnTreeStore(...)`** (`store/connTree.ts`) — the shared per-connection
  "lazy tree" (parents loaded on demand, children fetched on first expand and
  cached). JetStream, KV and Object Store are one-liners over it; it
  auto-registers each store for conn-scoped teardown. `store/monitor.ts` is
  bespoke (polling, not a tree).
- **Persistence** — `createPersistStorage()` (`lib/persist-storage.ts`) persists
  through `tauri-plugin-store` (falls back to `localStorage` in the browser/tests)
  and parses defensively. `lib/hydration.ts` gates the first render until the
  persisted stores have loaded. (Schema migrations are deferred until the app is
  in production — see `todo.md` #29.)

## Editor area

`components/editor/EditorArea.tsx` hosts a [Dockview](https://dockview.dev/)
tabbed/split area. Layout is serialized per connection in `store/workspace.ts`
and swapped when the active connection changes. Tabs are "editor inputs"
(a type + stable id; opening the same id focuses the existing tab). Live stream
subscriptions survive splits because Dockview suppresses add/remove-panel events
during a programmatic move. `lib/editor.ts` is the open/close API
(`openStream`, `openPublish`, …) and the conn-scoped editor teardown.

## Rust backend

`src-tauri/src/nats/` is layered: every feature module (`connection`,
`subscription`, `publish`, `subjects`, `jetstream`, `kv`, `obj`, `monitoring`,
`context`) depends only on `error.rs` and `connection.rs` (the `ConnState`
registry). `lib.rs` registers the `#[tauri::command]` handlers; live subscription messages
flow to the frontend over Tauri Channels (the `stream` store ring-buffers and
batches them on the UI side). Connection lifecycle is pushed to the frontend as
`nats:*` events. Errors currently serialize to a string (typed `{ kind, message }`
is planned — `todo.md` #30).

## Adding a new domain

The shape a `registerKubernetesModule()` would follow:

1. **Backend:** add `src-tauri/src/<domain>/` (sibling to `nats/`), its
   `#[tauri::command]`s in `lib.rs`, and namespaced events (`<domain>:*`).
2. **IPC:** typed wrappers in a `lib/<domain>-api.ts`.
3. **Stores:** per-connection stores (reuse `createConnTreeStore` where it fits);
   call `registerConnScoped` for teardown.
4. **Module:** `src/modules/<domain>/` with a `register<Domain>Module()` that
   contributes views, commands, status segments and a watermark, plus a
   `use<Domain>Runtime()` hook for its event listeners.
5. **Wire-up:** call `register<Domain>Module()` in `main.tsx` and the runtime
   hook in `Workbench`.
6. The shell needs **no changes** — and the ESLint boundary guarantees it.

When a real second domain lands, the shell + registries extract into
`libs/workbench` and NATS into `libs/domain-nats` (the pnpm workspace already
makes this mechanical). Until then, everything lives in `apps/twigo`.
