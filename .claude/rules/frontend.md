---
paths:
  - "apps/**"
  - "packages/**"
---

# Frontend

- Contributions are data: views, editors, status-bar entries, menu items, quick-pick items, explorer nodes and column rules are descriptors that the workbench renders ([decision](../../docs/decisions/frontend-architecture.md)).
- Act only through commands; place them in menus and render menus with `workbench.actions(menu, lookup)` and the `ui` action renderers, never a hand-built menu.
- Draw every recurring pattern with a `ui` primitive; outside `packages/ui` and the workbench's parts, class names only lay things out (flex, grid, gap, size, overflow), never colour or type.
- Map Kubernetes values to a `Tone` as data in `packages/kube`; `ui` draws the tone.
- Keep editor state in a service keyed by the editor's URI, not in component state.
- Lists and trees are `ui`'s `DataGrid` and `Tree`, driven by the workbench's list service.
