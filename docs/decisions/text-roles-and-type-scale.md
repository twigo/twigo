# Text takes one of four roles and a size from the scale

Decided 2026-11-14 with the owner; the roles' lightness and the font smoothing settled on 2026-11-15 from live variants in the app's window (ARCHITECTURE 4.9; [research](../research/typography.md)).

## Decision

- Text is coloured through four roles, `text-strong`, `text-content`, `text-support` and `text-quiet`, and the tones (`text-error`, `text-warn-foreground`, `text-ok`):
  - strong for the object's title, section titles and the name in the row under the cursor;
  - content for names, values, messages and log lines;
  - support for property labels, table headers and secondary columns;
  - quiet for timestamps, units, a zero count, placeholders and hints.
- Besides the roles and the tones, the brand marks links, matches and accents such as a pod that joined a logs tab, a filled surface takes its own foreground token, as `text-primary-foreground` on `bg-primary`, and a log line keeps its ANSI colours.
- Each role is 4.5:1 or more by WCAG 2 on the shell, the editor, a card, a popover and a selected row, where quiet takes support's colour.
  `packages/ui/src/styles/roles.test.ts` resolves `theme.css` and holds that, and the WCAG and APCA figures the comment over the roles states.
- Two adjacent pieces of text in different roles differ by 25 Lc or more, or by a second cue: a size step or the other weight.
  On the editor neighbouring roles stand 12.7, 28.3 and 16.2 Lc apart in dark and 2.4, 20.6 and 8.7 in light, so of neighbours only content and support in dark part by lightness alone.
  In the light theme content and support are 20.6 Lc apart and support and quiet 8.7, and no light values give both steps 25 Lc while quiet keeps 4.5:1 on the shell, so there the rule rests on the second cue.
  The design keeps a few pairs with neither: the strong name in the row under the cursor beside the row's other cells; a generated name's hash and its last segment, and a log time's unchanged and changed parts, 16.2 Lc apart in dark and 8.7 in light; and in the light theme a value beside text in support that qualifies it, 20.6 Lc apart, as Usage's figure and its limits.
- Sizes come from the scale in `theme.css`, each a size with its own whole-pixel line height: `2xs` 11 / 16, `xs` 12 / 16, `label` 12 / 18, `body` 13 / 18, `prose` 13 / 20, `sm` 14 / 20, `title` 16 / 22, `base` 16 / 24 and `lg` 18 / 28.
  `base` is for the device code of a sign-in and `lg` for the name of a space over its Home, and each is Tailwind's own step, as `xs` and `sm` are.
  A literal size stays only with a whole-pixel line height and a reason it cannot be a step.
  A new step joins the font sizes that `cn`'s tailwind-merge knows, which otherwise takes it for a colour and drops it beside a role.
- Two weights, 400 and 600, and never 510.
- `tabular-nums` goes on numeric columns and values (counts, ratios, quantities, durations, clocks, addresses), never on a whole row.
- Monospace text is `font-mono`, whose family token turns `liga` and `calt` off.
- Text keeps the platform's own font smoothing: nothing sets `-webkit-font-smoothing`, and Tailwind's `antialiased` is not used.

## Why

The three tiers before passed 4.5:1 but stood 22 Lc from text to muted text on the dark editor, where the themes compared step 27 to 38 Lc, and 16 Lc to the third, and they carried the hierarchy alone: a label, its value and a timestamp had one size and one weight.
Roles name what the text is worth to the reader now, so a component says which it shows and the tokens decide how that looks, and the rule of 25 Lc or a second cue can be checked per component.
Whole-pixel line heights keep baselines on the pixel grid, and numbers compared down a column need equal widths, while names and words read better in their own.
Weight 510 of the system font is out because Chrome draws it heavier than 600 with `antialiased` and without it, so the mock would mislead ([research](../research/typography.md)); WKWebView drew it lighter than 600 with `antialiased`, which the app no longer sets, and without it that is not measured.
JetBrains Mono's ligatures are contextual alternates, which `liga` alone would leave on, and `antialiased` takes about a quarter of the ink from light text on dark in WKWebView, which the owner declined after comparing both in the app's window.
