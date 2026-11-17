# A part that does not fit gives way in stages, by widths its stages cannot change

Decided 2026-11-15, for the title bar, the details' row of actions, a list's actions and a list editor's columns; on 2026-11-16 for a row of views and a list's scope chip (ARCHITECTURE 4.1, 4.3, 4.4, 4.9).

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
  - a row of views, an object's in the details and in an editor and a side bar's containers (`TabBar`): its trailing tabs into a More menu, one more at each stage, the shown tab never, and past the last fold the shown tab's label cut, down to 2em (4.9);
  - a list's actions, once the tabs have their room: the field's key hint, the Group button's label, the field to an icon, the health control to a menu, then the scope chip, its first name cut in the middle down to its floor, then the chip folded to its glyph and how many more namespaces follow, then to its glyph alone (4.4);
  - a list editor's columns: by each column rule's `drop`, the name column never (4.4).
- What decides a stage is never a width the stage changed.
  - The title bar, the row of actions, a row of views and the scope chip measure hidden copies of themselves at their natural size, one per stage, part or form, `aria-hidden` and out of sight in a box of no height.
  - A list's actions read their own row at each stage as it shows, which never shrinks, so that is the stage's natural width, against the room the strip leaves beside its tabs, which the actions do not move.
    The scope chip, which gives way after the row's last stage, is read apart: each stage is read without the chip and counted with the whole chip, and the chip takes the form that fits the room the last stage leaves it, by the widths of its forms from its hidden copies.
    Each read is in a layout effect, and React runs it and the state updates it schedules before the browser paints ([`useLayoutEffect`](https://github.com/reactjs/react.dev/blob/46a54e0592729712b7640308b53268e84fdc7c9f/src/content/reference/react/useLayoutEffect.md?plain=1#L262)), so a turn to a stage that is too wide never shows.
    Beside docked details that room is less what the details take, which is read in a layout effect too as they dock, before the width observers report it.
    A text in the filter changes the counts, and so the row: each count keeps room for the most digits it had with no text, by an invisible copy of them, and while the filter field or its Clear button has the focus no stage moves, so the field never shifts under the caret; nor while the focus is in the scope chip, whose close mark a fold would take away with the focus; while the filter's popover is open the filter stays an icon.
  - The room a list's actions read is the strip's width less every tab at the width it asks for, the 4 px before the first tab, the 2 px between tabs and the overflow button's 28 px (`useActionsRoom`); beside docked details the least the strip keeps is the space before the tab, a list's tab at its 220 px, the overflow button, the actions at their last stage with the chip as its glyph, and the 6 px after them (`STRIP_KEPT`).
  - A list editor's columns add up the widths in effect, the person's or the rule's, against the grid's measured width.
- Where a width on a boundary could flip a stage or cut a text, the step holds a margin.
  - The row of actions and a row of views come back to a fuller stage only with 16 px to spare.
  - The title bar counts half a pixel for each rounded width it adds up, so a part stays unfolded only where it fits whichever way the widths were rounded.
  - The scope chip comes back to a fuller form only with a pixel to spare: the room it reads is the row's width less the chip's, two widths each rounded to a pixel, and the form a width was read in changes how they round.
  - A list's actions and a list editor's columns hold none otherwise: neither moves the room it is measured against, so the same room gives the same stage whichever way it came, but for a list's actions while their filter field, its Clear button or the scope chip has the focus, or the filter's popover is open.
- A part folds before it cuts.
  The title bar cuts its crumbs only once the search, the centring and the chip have given way, and then in the middle, down to a floor of characters with a middle of at least 2em.
  The row of actions only folds; a row of views folds its trailing tabs first and cuts the shown tab's label only where even that and More are too wide; a list's actions fold, and cut only the scope chip's name, in the middle, before they fold it too; and a list editor's columns leave whole, once the name column has given up the free width it takes.
- A part measures once, never once per row: one title bar, one row of actions per details, one row of views per details, editor or side bar, one strip per group, and a grid's own width, from which every row draws its columns; whether a row's hover icons have room comes from the columns' widths.

## Consequences

- What each stage takes is read the same way every time, so the stage is a function of the room, and only the row of actions and a row of views, by their margin, the scope chip, by its pixel, and a list's actions, while their filter field, its Clear button or the scope chip has the focus, or the filter's popover is open, depend on the way the room came.
- The hidden copies cost elements: a row of actions draws its pinned actions once more for each stage, a row of views its tabs once more for each fold and the scope chip itself in four forms, for one row per details, editor or side bar and one chip per list, and never for a list's rows.
- The upstream behaviour this rests on:
  - `ResizeObserver` reports an element's content box, without its padding ([content rect](https://www.w3.org/TR/2020/WD-resize-observer-1-20200211/#content-rect-h)), once layout is done and before paint ([event loop](https://www.w3.org/TR/2020/WD-resize-observer-1-20200211/#html-event-loop)); `useWidth` rounds it, and takes a report of 0 for an element that is not laid out, as a tab that dockview detaches, and keeps the width it had.
  - With `text-overflow: ellipsis` the first character on a line is clipped rather than ellipsed ([CSS Overflow 3](https://www.w3.org/TR/2025/WD-css-overflow-3-20251007/#text-overflow)), so a middle narrower than a glyph and the ellipsis shows a letter and no ellipsis, a name that does not exist.
    The middle is a grid track of `minmax(2em, 1fr)`, which never gets narrower than 2em ([`minmax()`](https://www.w3.org/TR/2025/CRD-css-grid-1-20250326/#funcdef-grid-template-columns-minmax)), 26 px at 13 px.
    In the system font at weight 600, the name crumb's, an M and the ellipsis take 23.25 px and `@` and the ellipsis, the widest of M, W, m, w and `@` measured, 23.63 px, so all stay under the floor (Chrome 157 on the mock, 2026-11-15).
  - The title bar's columns are `minmax(0, …fr)`, since an `fr` track alone has an automatic minimum ([`<flex>`](https://www.w3.org/TR/2025/CRD-css-grid-1-20250326/#valdef-grid-template-columns-flex-0)) and would not narrow below the breadcrumb's content.
- Tests stand in for `ResizeObserver`, as `packages/ui/test/resize.ts` and `withScreenSize` in `packages/kube/test/workbench.tsx` do: jsdom lays nothing out, so a test sets the widths and checks the stage, and what is drawn is checked in a browser.
- The terminal's chip in the panel's strip still gives way by CSS alone, its words cut down to its icon (ARCHITECTURE 4.6).

## Where it is implemented

- The width hook: [`packages/ui/src/lib/useWidth.ts`](../../packages/ui/src/lib/useWidth.ts).
- The row of actions: `ActionRow` in [`packages/ui/src/components/actions.tsx`](../../packages/ui/src/components/actions.tsx), and the pins in [`packages/kube/src/resourceActions.ts`](../../packages/kube/src/resourceActions.ts).
- The cut in the middle: [`packages/ui/src/lib/cutText.ts`](../../packages/ui/src/lib/cutText.ts) and `CutInTheMiddle` in [`packages/ui/src/components/cut-in-the-middle.tsx`](../../packages/ui/src/components/cut-in-the-middle.tsx), which the title bar's crumbs, an editor tab's title and the scope chip's name use.
- The title bar: [`packages/workbench/src/parts/TitleBar.tsx`](../../packages/workbench/src/parts/TitleBar.tsx) and [`titleBarStage.ts`](../../packages/workbench/src/parts/titleBarStage.ts).
- A row of views: `TabBar` in [`packages/ui/src/components/tab-bar.tsx`](../../packages/ui/src/components/tab-bar.tsx).
- The strip and a list's actions: `useActionsRoom` in [`packages/workbench/src/parts/EditorArea.tsx`](../../packages/workbench/src/parts/EditorArea.tsx), [`strip.ts`](../../packages/workbench/src/parts/strip.ts), [`packages/kube/src/list/ListActions.tsx`](../../packages/kube/src/list/ListActions.tsx) and [`stages.ts`](../../packages/kube/src/list/stages.ts), the scope chip in [`packages/ui/src/components/scope-chip.tsx`](../../packages/ui/src/components/scope-chip.tsx), the room the docked details take in [`ListEditor.tsx`](../../packages/kube/src/list/ListEditor.tsx), and a count's room in `Count` in [`packages/ui/src/components/count.tsx`](../../packages/ui/src/components/count.tsx).
- A list's columns: `drop`, `into` and `coverable` in [`packages/kube/src/columns.ts`](../../packages/kube/src/columns.ts), [`packages/kube/src/list/fit.ts`](../../packages/kube/src/list/fit.ts) and [`ResourceGrid.tsx`](../../packages/kube/src/list/ResourceGrid.tsx), and the held first column and the hover icons' room in [`packages/ui/src/grid/DataGrid.tsx`](../../packages/ui/src/grid/DataGrid.tsx).
- The rule [`.claude/rules/layout.md`](../../.claude/rules/layout.md) holds it for work in the frontend packages.
