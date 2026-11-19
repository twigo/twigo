---
paths:
  - "packages/ui/**"
  - "packages/workbench/**"
  - "packages/kube/**"
---

# Giving way

- A part that can be too narrow gives way in a fixed order of stages, kept in one place beside it, and takes the fullest that fits ([decision](../../docs/decisions/parts-give-way-by-width.md)).
  Decide the stage in code, and let CSS cut no more than a text within its stage.
  The terminal's chip in the panel's strip is the one part that still gives way by CSS alone.
- Decide a stage by widths the stage cannot change: what each stage takes at its natural size, from hidden copies (`ActionRow`, the title bar, `TabBar`, the scope chip, an object's header lines and vitals), from a row that never shrinks, read at that stage against a room it does not move (a list's actions), or from the widths in effect (a list editor's columns); never from a part that its stage squeezed or cut.
- Where a width on a boundary could flip a stage or cut a text, hold a margin: 16 px before a fuller stage comes back, or half a pixel for each rounded width added up.
  An object's header lines hold it between reads of one object and drop it for another (its URI or its `created`) and for a copy whose cut has not read its font, so the same room gives the same stage whichever object came before.
- An object page's parts read their widths with `useClientWidth` and `useChildWidths` (`pageStage.ts`: the header's lines, the vitals, the containers and the full page), which report a resize at the start of the next frame, `requestAnimationFrame(() => flushSync(redraw))`, never through a store change inside an observer's delivery, which takes `useWidth`'s pending updates along and raises Chrome's "ResizeObserver loop" error.
  The title bar, `ActionRow`, `TabBar`, a list's actions, an embedded list and the page's filter row read theirs with `useWidth` (`packages/ui/src/lib/useWidth.ts`), which sets its state in the observer's callback.
  A width that narrows at once paints one frame at the old stage in the header's lines, the one part measured; what `useWidth` sets renders in a task of React's scheduler after the frame that reported, and its frames at the old stage are not measured (the decision has the numbers).
- An age in a part that has stages keeps the room of the widest age of its range (`widestDuration`), so that a tick moves no width.
- Fold before cutting text; a text whose end tells things apart is cut in the middle, with a floor, by `CutInTheMiddle` (`packages/ui`): an editor tab whose registration says `titleEndTells`, a crumb, the scope chip's name.
  The header's two lines are facts, not controls: they cut before they drop, the first line's name giving up its generated part first, as a list row's does, the age never leaving, and a text a cut cannot shorten keeps its whole width in the stage's count.
- A strip's tabs come first: a group's actions get what the strip leaves beside its tabs, the space before and between them, the overflow button and the space after the actions (`strip.ts`), and a constant there moves with the tab's CSS in `styles.css`.
- Measure once per part, never per row, and read a stage that moves what is around it before paint: in a layout effect (a list's actions, `TabBar`, the page's filter row), or as the element attaches, in the render that follows (`pageStage.ts`).
- Test stages with a stand-in for `ResizeObserver` (`packages/ui/test/resize.ts`, `withScreenSize`): jsdom lays nothing out, so look at what is drawn in a browser.
