---
paths:
  - "apps/**"
  - "packages/**"
---

# Typography

- Colour text only through the four roles and the tones ([decision](../../docs/decisions/text-roles-and-type-scale.md)): `text-strong` for titles and the row in hand, `text-content` for names, values and messages, `text-support` for labels, headers and secondary columns, `text-quiet` for timestamps, units, zeros and hints; a field's placeholder on its well is `text-support`, since the well takes quiet under 4.5:1.
  Beyond them only the brand for links, matches and accents, a filled surface's own foreground token, and a log's ANSI colours.
- Two adjacent texts in different roles differ by 25 Lc or by a second cue: a size step or the other weight.
  Of neighbouring roles only content and support in dark part by lightness alone; in the light theme content and support are 20.5 Lc apart and support and quiet 8.8, and no light values give both steps 25 Lc while quiet keeps 4.5:1 on the shell, so there the second cue carries the rule.
- Sizes only from the scale (`text-2xs`, `text-xs`, `text-label`, `text-body`, `text-prose`, `text-sm`, `text-title`, `text-base`, `text-lg`); a literal only with a whole-pixel line height and a reason.
  A new step joins the font sizes of `cn`'s tailwind-merge, or a role class beside it drops it.
- Weights 400 and 600 only, never 510.
- `tabular-nums` only on numeric columns and values, never on a whole row.
- Monospace through `font-mono`, which turns ligatures off; never `-webkit-font-smoothing` or Tailwind's `antialiased`.
