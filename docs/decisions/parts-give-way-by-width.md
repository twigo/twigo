# A part that does not fit gives way in stages, by widths its stages cannot change

Decided 2026-11-15, for the title bar, the details' row of actions, a list's actions and a list's columns (ARCHITECTURE 4.1, 4.3, 4.4, 4.9).

## Context

These parts let the browser decide what a narrow width costs them.
The title bar cut the space's name and its namespace scope at their ends while the search field kept its width.
A pod's row of actions was wider than the details, so the actions past their edge could not be seen and still took the Tab key.
Beside the details, the editor's tab went into the overflow's chevron before the list's filters gave anything, and the list switched to a fixed set of columns.

A part measured as it is drawn measures the stage it is at: a fold changes the width that decided it, and the next measure can undo the fold.
A width estimated by counting a text's characters misses for capitals and digits, which are wider than an average letter.

## Decision

- A part that can be too narrow takes the fullest of its stages that fits, in a fixed order kept in one place beside it:
  - the title bar: the search field to an icon, the search out of the middle, the mode chip to its icon, then the crumbs cut in the middle (ARCHITECTURE 4.1);
  - the details' row of actions: the keys, then the labels from the last pinned action back (4.3);
  - a list's actions, once the tabs have their room: the field's key hint, the Group button's label, the field to an icon, the health control to a menu (4.4);
  - a list's columns: by each column rule's `drop`, the name column never (4.4).
- What decides a stage is never a width the stage changed.
  - The title bar and the row of actions measure hidden copies of themselves at their natural size, one per stage or part, `aria-hidden` and out of sight in a box of no height.
  - A list's actions read their own row at each stage as it shows, which never shrinks, so that is the stage's natural width, against the room the strip leaves beside its tabs, which the actions do not move.
    Each read is in a layout effect, and React runs it and the state updates it schedules before the browser paints ([`useLayoutEffect`](https://github.com/reactjs/react.dev/blob/46a54e0592729712b7640308b53268e84fdc7c9f/src/content/reference/react/useLayoutEffect.md?plain=1#L262)), so a turn to a stage that is too wide never shows.
  - A list's columns add up the widths in effect, the person's or the rule's, against the grid's measured width.
- Where a width on a boundary could flip a stage or cut a text, the step holds a margin.
  - The row of actions comes back to a fuller stage only with 16 px to spare.
  - The title bar counts half a pixel for each rounded width it adds up, so a part stays unfolded only where it fits whichever way the widths were rounded.
  - A list's actions and its columns hold none: neither moves the room it is measured against, so the same room gives the same stage whichever way it came.
- A part folds before it cuts.
  The title bar cuts its crumbs only once the search, the centring and the chip have given way, and then in the middle, down to a floor of characters with a middle of at least 2em.
  The row of actions and a list's actions only fold, and a list's columns leave whole, once the name column has given up the free width it takes.
- A part measures once, never once per row: one title bar, one row of actions per details, one strip per group, and a grid's own width, from which every row draws its columns; whether a row's hover icons have room comes from the columns' widths.

## Consequences

- What each stage takes is read the same way every time, so the stage is a function of the room, and only the row of actions, by its margin, depends on the way the room came.
- The hidden copies cost elements: a row of actions draws its pinned actions once more for each stage, for one row per details and never for a list's rows.
- The upstream behaviour this rests on:
  - `ResizeObserver` reports an element's content box, without its padding ([content rect](https://www.w3.org/TR/2020/WD-resize-observer-1-20200211/#content-rect-h)), once layout is done and before paint ([event loop](https://www.w3.org/TR/2020/WD-resize-observer-1-20200211/#html-event-loop)); `useWidth` rounds it, and keeps the last width of an element that reports 0, which is not laid out, as a tab that dockview detaches.
  - With `text-overflow: ellipsis` the first character on a line is clipped rather than ellipsed ([CSS Overflow 3](https://www.w3.org/TR/2025/WD-css-overflow-3-20251007/#text-overflow)), so a middle narrower than a glyph and the ellipsis shows a letter and no ellipsis, a name that does not exist.
    The middle is a grid track of `minmax(2em, 1fr)`, which never gets narrower than 2em ([`minmax()`](https://www.w3.org/TR/2025/CRD-css-grid-1-20250326/#funcdef-grid-template-columns-minmax)), 26 px at 13 px, where an M and the ellipsis take 23.25 px and a W and the ellipsis 23.20 (Chrome, 2026-11-15).
  - The title bar's columns are `minmax(0, …fr)`, since an `fr` track alone has an automatic minimum ([`<flex>`](https://www.w3.org/TR/2025/CRD-css-grid-1-20250326/#typedef-flex)) and would not narrow below the breadcrumb's content.
- Tests stand in for `ResizeObserver`, as `packages/ui/test/resize.ts` and `withScreenSize` in `packages/kube/test/workbench.tsx` do: jsdom lays nothing out, so a test sets the widths and checks the stage, and what is drawn is checked in a browser.
- The terminal's chip in the panel's strip still gives way by CSS alone, its words cut down to its icon (ARCHITECTURE 4.6).

## Where it is implemented

- The width hook: [`packages/ui/src/lib/useWidth.ts`](../../packages/ui/src/lib/useWidth.ts).
- The row of actions: `ActionRow` in [`packages/ui/src/components/actions.tsx`](../../packages/ui/src/components/actions.tsx), and the pins in [`packages/kube/src/resourceActions.ts`](../../packages/kube/src/resourceActions.ts).
- The title bar: [`packages/workbench/src/parts/TitleBar.tsx`](../../packages/workbench/src/parts/TitleBar.tsx), [`titleBarStage.ts`](../../packages/workbench/src/parts/titleBarStage.ts) and [`cutText.ts`](../../packages/workbench/src/parts/cutText.ts).
- The strip and a list's actions: `useActionsRoom` in [`packages/workbench/src/parts/EditorArea.tsx`](../../packages/workbench/src/parts/EditorArea.tsx), [`strip.ts`](../../packages/workbench/src/parts/strip.ts), [`packages/kube/src/list/ListActions.tsx`](../../packages/kube/src/list/ListActions.tsx) and [`stages.ts`](../../packages/kube/src/list/stages.ts).
- A list's columns: `drop`, `into` and `coverable` in [`packages/kube/src/columns.ts`](../../packages/kube/src/columns.ts), [`packages/kube/src/list/fit.ts`](../../packages/kube/src/list/fit.ts) and [`ResourceGrid.tsx`](../../packages/kube/src/list/ResourceGrid.tsx), and the held first column and the hover icons' room in [`packages/ui/src/grid/DataGrid.tsx`](../../packages/ui/src/grid/DataGrid.tsx).
- The rule [`.claude/rules/layout.md`](../../.claude/rules/layout.md) holds it for work in the frontend packages.
