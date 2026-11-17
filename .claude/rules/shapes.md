---
paths:
  - "packages/ui/**"
  - "packages/workbench/**"
  - "packages/kube/**"
---

# Shapes and fills

- One edge per control: a fill or an outline, never both ([decision](../../docs/decisions/shapes-and-fills.md)).
  A field and a toolbar picker that shows its choice (`TriggerButton`) rest on `--well` and hover to `--well-hover`; the list's Group button and `TabBar`'s More are bare with `--row-hover`, the scope chip is `--row-active`, a keycap is `--keycap`, a pressed choice is `--plate` on a `--well` track; a text field outside `SearchField` takes `bg-well` itself.
- A control's fills are overlays, never a surface token, so they show on the shell, the editor, a card, a popover and a dialog; text on them keeps 4.5:1, which `packages/ui/src/styles/roles.test.ts` holds, and a placeholder on a well is `text-support`.
- Radius by height: `rounded-sm` (4 px) up to 22 px, `rounded-md` (6 px) from 24 to 32 px, `rounded-lg` (8 px) for cards, popovers, menus, toasts and dialogs; never bare `rounded`.
  An inner radius is the outer one less the gap, never under `rounded-xs` (2 px).
- What a hover or an active state fills is rounded, but table rows and log lines, and the status bar's space entry in its corner.
- A hover or selection inside a part's edges is a plate in a hit box of the full size: draw it with `::before` inset, never by shrinking the box that takes the clicks.
- A place is a tab that opens into its content; a view of the same thing is a plate of `TabBar`, never an underline and never a `Segmented`.
- Hairlines are `--border` or `--border-subtle`; a line that the sash already draws is not drawn again beside it.
