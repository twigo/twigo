# Frontend architecture: contributions are data, primitives own the look

Decided 2026-11-03 with the workbench redesign (ARCHITECTURE 2.3, 4.1, 4.4, 4.9; [research](../research/workbench-design.md)).

## Decision

### Layers

| Package        | Owns                                                                                                                                                                                              | Knows nothing of               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `ui`           | Tokens and the primitives that draw every recurring pattern: actions and menus, status, counts, keys, fields, segmented controls, the data grid, the tree, property lists, sections, empty states | Kubernetes, IPC, the workbench |
| `workbench`    | Services and registries, and the parts that render what features contribute: title bar, space rail, side bars, panel, editor area, status bar, quick access, the list service                     | Kubernetes                     |
| `kube`         | Kubernetes contributions: column rules and cells, the list and object editors, the explorer, details, status entries, quick-access providers                                                      | —                              |
| `apps/desktop` | Bootstrap only                                                                                                                                                                                    | —                              |

### Rules

1. **Contributions are data.**
   A view, an editor, a status-bar entry, a menu item, a quick-pick item, an explorer node and a column rule are descriptors.
   The workbench renders them; a feature supplies data and callbacks, not chrome.
2. **One action model.**
   A command (id, title, icon, enablement, keybinding) is the only way to act on objects and the workbench.
   Menus place commands, and `workbench.actions(menu, lookup)` turns a menu into `ActionGroups`, which one set of `ui` renderers draws as a context menu, a dropdown, inline row buttons, a selection bar or a toolbar.
   A view's own display choices, such as its shown columns or its grouping, are actions it builds from its data; nothing draws a menu by hand.
3. **Primitives own the look.**
   Every recurring pattern (a dot, a count, a key, a button, a menu, a field, a row, a section, an empty state) is a `ui` primitive, and features use it rather than redraw it.
   Feature code colours text only through the tokens' tiers and tones (`text-muted-foreground`, `text-error`) and otherwise only lays things out.
4. **Status is semantic.**
   `Tone` is `error`, `warn`, `ok` or `idle`; `kube` maps Kubernetes values to tones as data.
   `ui` draws a tone by shape and colour, so no state rests on hue alone: error a filled dot, warn a ring, idle grey, and a pulse only while a state is in flight.
5. **State lives in services.**
   Components read services through `useChanges`; what an editor shows (filters, grouping, collapsed groups, selection, marks) lives in a service keyed by the editor's URI, so an editor remounts without losing it.
6. **Lists are widgets.**
   `ui` has a virtualized `DataGrid` and a `Tree`, controlled and domain-free, each with an imperative controller.
   The workbench's list service routes the `list.*` commands to the focused one, so every list and tree moves, opens, marks, folds and filters with the same keys.
7. **View states are drawn once.**
   One component in `kube` renders a `ViewState` (loading, forbidden, unauthorized, error) for lists, the explorer, details and object editors; `ui`'s `EmptyState` draws it.

## Why

The registries were already VS Code's; the rendering was not.
Each part and editor built its own rows, menus, dots and empty states from class strings: the row menu existed twice, a 6 px dot told error from pending by hue alone, and the list navigation lived in `kube` though nothing in it is Kubernetes.
Moving every pattern into one primitive and every contribution into data makes a new kind, column, view or command a matter of data, and a redesign a matter of the primitives.

## Enforcement

- ESLint keeps the package boundaries of ARCHITECTURE 2.3 and rejects raw colours outside `ui` ([design tokens](design-tokens.md)).
- The rule file `.claude/rules/frontend.md` carries these rules for agents.
