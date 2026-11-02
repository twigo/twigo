---
paths:
  - "apps/**"
  - "packages/**"
---

# Frontend

- Contributions are data: views, editors, status-bar entries, menu items, quick-pick items, explorer nodes and column rules are descriptors that the workbench renders ([decision](../../docs/decisions/frontend-architecture.md)).
- Act on objects and the workbench only through commands; place them in menus and render menus with `workbench.actions(menu, lookup)` and the `ui` action renderers; a view's display choices (columns, grouping) are `Action`s built from its data; never a hand-built menu.
- Draw every recurring pattern (dots, counts, keys, buttons, menus, fields, rows, sections, empty states) with a `ui` primitive; feature code colours text only through token tiers and tones and otherwise only lays things out.
- Map Kubernetes values to a `Tone` as data in `packages/kube`; `ui` draws the tone.
- Keep editor state in a service keyed by the editor's URI, not in component state.
- Lists and trees are `ui`'s `DataGrid` and `Tree`, driven by the workbench's list service.
