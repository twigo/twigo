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
- Decide a stage by widths the stage cannot change: what each stage takes at its natural size, from hidden copies (`ActionRow`, the title bar), from a row that never shrinks, read at that stage against a room it does not move (a list's actions), or from the widths in effect (a list editor's columns); never from a part that its stage squeezed or cut.
- Where a width on a boundary could flip a stage or cut a text, hold a margin: 16 px before a fuller stage comes back, or half a pixel for each rounded width added up.
- Fold before cutting text; a text whose end tells things apart is cut in the middle, with a floor.
- Measure once per part, never per row, and read a stage that moves what is around it in a layout effect, before paint.
- Test stages with a stand-in for `ResizeObserver` (`packages/ui/test/resize.ts`, `withScreenSize`): jsdom lays nothing out, so look at what is drawn in a browser.
