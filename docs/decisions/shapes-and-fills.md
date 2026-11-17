# One edge per control, radius by height, plates inside full-size hit boxes

Decided 2026-11-16 with the owner, the sashes' line and the status bar's space entry on 2026-11-17 (ARCHITECTURE 4.9).

## Context

Small controls carried a fill and a 1 px outline at once: the search fields, the keycaps, the health filter, the mode chip and the triggers, so the top of a window read as a grid of boxes.
Radii were picked one by one, bare `rounded` and `rounded-sm` both 4 px, and a tree's row or a status bar entry hovered as a square strip from edge to edge.
An object's views were drawn three ways, an underlined tab bar in the details, a segmented control in an editor's tab strip and plain words in a side bar's header, none of them unlike the tabs above them.

## Decision

- A control has one edge: a fill or an outline, never both.
  - A field rests on a fill, `--well`, takes `--well-hover` under the pointer, and shows a ring only while it has the focus.
  - A trigger that opens a menu or a picker takes the same fills, and stays lit while its menu is open.
  - A keycap is a fill of its own, `--keycap`; the mode chip is its context's tint alone.
  - `Segmented`, for options and filters, is a track on `--well` with 2 px of padding and its pressed choice a plate on `--plate`, its label in the strong role.
- The fills a control rests and hovers on are overlays, as a row's hover and selection are, so they differ from every surface they sit on: the shell, the editor, a card, a popover, a dialog.
- Radius follows height: 4 px up to 22 px (`rounded-sm`), 6 px from 24 to 32 px (`rounded-md`), 8 px for cards, popovers, menus, toasts and dialogs (`rounded-lg`).
  An inner radius is the outer one less the gap between them, never under 2 px (`rounded-xs`), the padding counting as the gap.
- What a hover or an active state fills is rounded, but table rows and log lines, which run edge to edge, and the status bar's space entry, which fills the bar's corner.
- Inside a part's edges a hover or a selection is a plate drawn in a hit box of the full size: a side bar tree's row and a status bar entry take clicks across the part, and their plates sit 6 px and 3 px in from its edges.
- The views of a part are plates, and its places are tabs: tabs open into their content, while an object's views and a side bar's containers are the plates of one `TabBar`, the shown one filled with `--row-active`.
- Hairlines come in two tiers, `--border` and `--border-subtle`: the sashes between the parts take the full hairline, the panel's top edge is its sash's line alone, and the line under an object's views is the subtle one.

## Why

An outline and a fill on the same control give the eye two edges to find, and a row of such controls reads as boxes before it reads as words.
A fill alone needs to show on every surface, which a surface token cannot: a field on the editor's colour had no edge at all in the logs' toolbar, which lies on the editor, so the fills are overlays: `--well`, 6 % black in light and 6 % white in dark, stands 1.14:1 to 1.18:1 from the shell and the editor.

A field's placeholder then cannot be quiet: the well takes quiet under 4.5:1, 3.9:1 over the light shell and 3.7:1 when hovered, where support keeps 5.0:1 or more, so a placeholder on the well reads in support.

`--well-hover` exists because `--row-active` lies 1.02:1 from the well over the light shell, too near to read as a change; at 8.5 % black in light and 8 % white in dark it stands 1.06:1 from the well, and a darker one would take a keycap's text over it under 4.5:1: at 10 % black, 4.36:1 over the light shell, where 8.5 % keeps 4.52:1.
The figures of this section are colorjs.io 0.7.1 with the resolution of `roles.test.ts`, on the tokens as they stand (2026-11-17).
The pressed plate is lighter than the track rather than darker, since the track plus 12 % of the content colour took the health filter's support and error counts under 4.5:1.

A radius that follows height makes controls of one height alike wherever they are drawn, and a nested radius that is the outer one less the gap keeps the two curves concentric.

A plate drawn inside a full-size hit box keeps the look of an inset plate without the dead pixels of a shrunken box: a status bar entry 18 px tall lost a quarter of the bar's height to clicks, and a tree's inset row the 6 px at each edge.

Tabs and views were three looks for two ideas: a place, which opens into what it holds, and a view of the same thing, which is a choice among plates.
One component draws every view switch, so the details and an editor show an object's views alike, and the shape tells a view from a place.

The owner chose the full hairline for the sashes over the subtle one, and the full-height space entry over an inset plate, looking at both on the running interface on 2026-11-17.

## Consequences

- Text on a fill is held at 4.5:1 by `packages/ui/src/styles/roles.test.ts`, which resolves the stylesheets: every role on the well and the hovered well, on the track and the pressed plate, and a keycap's text over a hovered field, on each surface they sit on.
- A text field that is not `SearchField` takes `bg-well` itself, as the confirm dialog's typed name does.
- A width that a removed outline changed by 2 px moves the stages that measure it (the title bar's search, the mode chip, a list's actions), which read widths from the elements themselves and follow by themselves.

## Where it is implemented

- The tokens: `--well`, `--well-hover`, `--plate`, `--keycap` and the radii in [`packages/ui/src/styles/theme.css`](../../packages/ui/src/styles/theme.css).
- The controls: [`search-field.tsx`](../../packages/ui/src/components/search-field.tsx), [`trigger.tsx`](../../packages/ui/src/components/trigger.tsx), [`kbd.tsx`](../../packages/ui/src/components/kbd.tsx), [`segmented.tsx`](../../packages/ui/src/components/segmented.tsx), [`tab-bar.tsx`](../../packages/ui/src/components/tab-bar.tsx) and [`scope-chip.tsx`](../../packages/ui/src/components/scope-chip.tsx) in `packages/ui/src/components`, and the title bar's search in [`packages/workbench/src/parts/TitleBar.tsx`](../../packages/workbench/src/parts/TitleBar.tsx).
- The plates in full-size hit boxes: [`packages/ui/src/tree/Tree.tsx`](../../packages/ui/src/tree/Tree.tsx) and [`packages/workbench/src/parts/StatusBar.tsx`](../../packages/workbench/src/parts/StatusBar.tsx).
- The tabs and the sashes: [`packages/workbench/src/styles.css`](../../packages/workbench/src/styles.css).
- The rule [`.claude/rules/shapes.md`](../../.claude/rules/shapes.md) holds it for work in the frontend packages.
