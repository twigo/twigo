# Typography: text roles, the type scale, the monospace and font smoothing

Research of 2026-11-14 into why Twigo's text was hard to take in, against the repository at commit 018e664d: how far apart its text tiers were, which cues carried its hierarchy, which monospace logs and YAML landed on, and what font smoothing did to strokes.
It replaces the text tiers of [workbench design](workbench-design.md).
The owner chose on 2026-11-14 and 2026-11-15; the choices are in [ARCHITECTURE](../ARCHITECTURE.md) 4.9 and the [decision on text roles and the type scale](../decisions/text-roles-and-type-scale.md).

Contrast is computed with colorjs.io 0.7.1 from the 8-bit sRGB colours the screen draws, as `packages/ui/src/styles/roles.test.ts` computes it: a token's OKLCH in sRGB rounded to 8 bits, and a selected row's tint composited over the editor.
Its APCA is version 0.0.98G, with the constants of [APCA-W3 0.1.9](https://github.com/Myndex/apca-w3/blob/6c5c066cf0c853507930a4239b129283b8e05353/src/apca-w3.js#L143-L172), and its ratio is that of [WCAG 2.2](https://www.w3.org/TR/WCAG22/#contrast-minimum), whose 4.5:1 every text role keeps.
Lc serves as an even ruler between two texts, not as a pass mark.

## Text tiers before the change

- On the dark editor `#121314` the three tiers were `#d3d4d5` at 12.5:1 and Lc 80, `#acaeb0` at 8.4:1 and Lc 58, and `#8e8f91` at 5.7:1 and Lc 41: steps of 22 and 16 Lc (computed from `theme.css` at 018e664d on 2026-11-15; the mock drew the same colours in headless Chrome on 2026-11-14).
  As one grey against the other, a value stood 1.50:1 from its label, and the label 1.45:1 from the third tier.
- Every tier passed 4.5:1 already, so the tiers were too close rather than too dim.
  The themes compared step further from their text to their muted text, measured the same way on their own surfaces:

| Theme, surface                          | Text, muted text     | Step, Lc | One against the other |
| --------------------------------------- | -------------------- | -------- | --------------------- |
| Twigo before, editor `#121314`          | `#d3d4d5`, `#acaeb0` | 22       | 1.50:1                |
| VS Code Dark 2026, side bar `#191A1B`   | `#bfbfbf`, `#8C8C8C` | 27       | 1.83:1                |
| JetBrains Islands Dark, layer `#191A1C` | `#D1D3D9`, `#9FA2A8` | 28       | 1.71:1                |
| Zed One Dark, panel `#2f343e`           | `#dce0e5`, `#a9afbc` | 29       | 1.66:1                |
| macOS 27.2, window `#1e1e1e`            | `#dddddd`, `#9a9a9a` | 38       | 2.07:1                |

- VS Code's are `foreground` and `descriptionForeground` ([2026-dark.json at 1.146.0](https://github.com/microsoft/vscode/blob/1.146.0/extensions/theme-defaults/themes/2026-dark.json#L7-L10)) on its [side bar](https://github.com/microsoft/vscode/blob/1.146.0/extensions/theme-defaults/themes/2026-dark.json#L82), the default dark theme of that release ([workbenchThemeService.ts](https://github.com/microsoft/vscode/blob/1.146.0/src/vs/workbench/services/themes/common/workbenchThemeService.ts#L43-L44)).
- Islands' are `text-default` and `text-muted` on `layer-0-bg` ([ManyIslandsDark.theme.json at idea/263.7307.200](https://github.com/JetBrains/intellij-community/blob/idea/263.7307.200/platform/platform-resources/src/themes/islands/ManyIslandsDark.theme.json#L152-L164)), with the greys they name at [L14-L26](https://github.com/JetBrains/intellij-community/blob/idea/263.7307.200/platform/platform-resources/src/themes/islands/ManyIslandsDark.theme.json#L14-L26).
- Zed's are `text` and `text.muted` on `panel.background` ([one.json at v1.28.1](https://github.com/zed-industries/zed/blob/v1.28.1/assets/themes/one/one.json#L30-L49)).
- macOS's are AppKit's `labelColor` and `secondaryLabelColor` composited over `windowBackgroundColor` under the dark appearance, read by a Swift script on macOS 27.2 on 2026-11-15.

## Four text roles

| Role    | Carries                                                                     | Dark, OKLCH L | Light, OKLCH L |
| ------- | --------------------------------------------------------------------------- | ------------- | -------------- |
| strong  | the object's title, section titles, the name in the row under the cursor    | 0.96          | 0.18           |
| content | names, values, messages, log lines                                          | 0.90          | 0.25           |
| support | property labels, table headers, healthy states, defaults, secondary columns | 0.75          | 0.48           |
| quiet   | timestamps, units, a zero count, placeholders, hints                        | 0.65          | 0.55           |

Chroma and hue stay those of the old text greys, 0.002 to 0.006 at hue 250.
Computed from `theme.css` with the four roles, on 2026-11-15:

| Role    | Dark editor   | Dark shell    | Dark card, popover, selected row | Light editor   | Light shell    | Light selected row |
| ------- | ------------- | ------------- | -------------------------------- | -------------- | -------------- | ------------------ |
| strong  | 16.6:1, Lc 99 | 15.5:1, Lc 98 | 14.2, 13.4, 10.7:1               | 18.8:1, Lc 105 | 17.5:1, Lc 100 | 14.8:1             |
| content | 13.8:1, Lc 86 | 12.9:1, Lc 85 | 11.8, 11.1, 8.9:1                | 16.0:1, Lc 103 | 14.9:1, Lc 98  | 12.5:1             |
| support | 8.4:1, Lc 58  | 7.8:1, Lc 57  | 7.2, 6.7, 5.4:1                  | 6.5:1, Lc 82   | 6.1:1, Lc 78   | 5.1:1              |
| quiet   | 5.7:1, Lc 41  | 5.4:1, Lc 41  | 4.9, 4.6, 5.4:1                  | 4.8:1, Lc 74   | 4.5:1, Lc 69   | 5.1:1              |

- A selected row's tint, `#293844` in dark and `#d9e6ed` in light, would take quiet to 3.7:1 and 3.8:1, so on a selected row and under the cursor quiet takes support's colour, which the table shows there.
- The figures are those of the 8-bit colours; the unrounded OKLCH values differ in the last digit shown, strong Lc 98 and quiet 5.8:1 on the dark editor.
- Neighbouring roles stand 12.7, 28.3 and 16.2 Lc apart on the dark editor and 2.4, 20.6 and 8.7 on the light one.
  A label and its value, support and content, stand 1.65:1 apart as greys in dark, from 1.50:1.
- In light the two steps below content share 29 Lc: content is Lc 103 on the editor, and the lightest quiet of its hue that keeps 4.5:1 on the shell is the one in use, `#6f7274` at Lc 74 (lightness stepped by 0.001, 2026-11-15); black itself is Lc 106.
  So no light values give both steps 25 Lc, and there a size step or the other weight tells neighbouring roles apart.
- A dimmer set, dark roles at 0.94, 0.87, 0.71 and 0.61, measures Lc 94, 80, 51 and 36 on the editor and puts a value 1.73:1 from its label, but leaves quiet at 4.20:1 on a card and 3.95:1 on a popover (computed the same way, 2026-11-15).

## The type scale

- Before the change body text was 13 px at a line height of 1.45, 18.85 px, and property rows 1.35, 17.55 px; section titles were 11 px at weight 600 in the second tier, smaller and dimmer than what they head; table headers 12 px at 400 in the second tier; the object's title 14 px at 600; logs 12 px on 19 px lines (`index.css`, `property-list.tsx`, `section.tsx`, `DataGrid.tsx`, `Details.tsx` and `LineList.tsx` at 018e664d).
- VS Code sets its workbench at 13 px with a line height of 1.4 em ([style.css at 1.146.0](https://github.com/microsoft/vscode/blob/1.146.0/src/vs/workbench/browser/media/style.css#L48-L50)) and names a ramp in which the subtitle heading is the body's 13 px, labels are 12 to 10 px, and strong text is a size at weight 600, the second of two weights ([baseSizes.ts at 1.146.0](https://github.com/microsoft/vscode/blob/1.146.0/src/vs/platform/theme/common/sizes/baseSizes.ts#L29-L78)).
- macOS's text styles put Headline at Body's 13 pt in bold, both on 16 pt lines, Callout at 12 pt and Subheadline at 11 (`NSFont.preferredFont`, macOS 27.2, 2026-11-15).
- So a heading takes the body's size and the heavier weight, and a label a size below its value: two cues a step.
  Lines of whole pixels keep baselines on the pixel grid at 1x, which 18.85 and 17.55 px did not.
- With `antialiased`, 13 px system-font text light on dark carried 1.70 times the ink of weight 400 at weight 510 and 1.36 times at 600 in headless Chrome 157, and 1.32 and 1.28 times without it (mean grey of 2x screenshots, macOS 27.2, 2026-11-15).
  An offscreen WKWebView drew 510 lighter than 600, 1.18 against 1.32 times with `antialiased` (mean grey of a 2x snapshot, macOS 27.2, 2026-11-15), so the Chrome mock shows a weight of 510 heavier than the app draws it.

## Figures and identifiers

- SF's digits are proportional: at 26 px ten ones measure 117.9 px and ten zeros 160.4 px, and `tabular-nums` makes both 159.9 px (CoreText, macOS 27.2, 2026-11-15).
  Figures that are compared down a column or tick in place need the tabular ones; names and words read better in their own widths.
- SF's stylistic set 6, which the font names High legibility, changes I, l, 0, 4, 6 and 9: the capital I gains serifs, the l a tail and the zero a slash, for 2.8 % more width on `Il1O0 auth-api-1tvckat-lI10O 6 9 12:34`, 447.6 against 435.6 px at 26 px (CoreText, macOS 27.2, 2026-11-15).
  In Inter the same tag selects squared characters ([ss06-squared.fea at v4.1](https://github.com/rsms/inter/blob/v4.1/src/features/ss06-squared.fea#L1)), and a Linux desktop's `system-ui` may be an Inter derivative (not verified).

## The monospace

- Before the change `--font-mono` named "JetBrains Mono" first and nothing bundled it, so WKWebView drew logs in SF Mono, 7.418 px a character at 12 px, and the Chrome mock in Menlo, 7.225 px (macOS 27.2, 2026-11-14).
- JetBrains Mono 2.304, [released](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304) on 2023-01-14 from commit `cd5227bd`, has an x-height of 0.550 em, 7.15 px at 13 px, and an advance of 0.600 em; SF Mono has 0.529 em, 6.35 px at the 12 px the logs had, and 0.618 em (CoreText, macOS 27.2, 2026-11-15).
  Geist Mono 1.9.2 has the same advance and an x-height of 0.530 em, 6.89 px at 13 px ([GeistMono-Regular.ttf at v1.9.2](https://github.com/vercel/geist-font/blob/v1.9.2/fonts/GeistMono/ttf/GeistMono-Regular.ttf), the same run).
- The bundled faces are the release's [webfonts](https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/webfonts) byte for byte: `JetBrainsMono-Regular.woff2`, 92,164 bytes, SHA-256 `a9cb1cd8…f45f2`, and `JetBrainsMono-SemiBold.woff2`, 94,472 bytes, `918edad5…faf1`, beside the release's `OFL.txt`, the SIL Open Font License 1.1.
  Read with CoreText on 2026-11-15, both say "Version 2.304" and map the 128 characters of the box-drawing block, the arrows ← ↑ → ↓, ✓, and Ukrainian ґ, ї, є and і.
- `@fontsource/jetbrains-mono` 5.3.0 on npm carries Google Fonts' build, "Version 2.211", split into Google's subsets: its Latin face maps no box drawing, no ✓ and only ↑ and ↓ of the four arrows ([400.css at 5.3.0](https://unpkg.com/@fontsource/jetbrains-mono@5.3.0/400.css); its faces read with CoreText, 2026-11-15).
- The font ships code ligatures ([README at v2.304](https://github.com/JetBrains/JetBrainsMono/blob/v2.304/README.md#L8)), and its `GSUB` table has `calt` but no `liga`, so its ligatures are contextual alternates and both features go off, as VS Code's editor turns both off by default ([editorOptions.ts at 1.146.0](https://github.com/microsoft/vscode/blob/1.146.0/src/vs/editor/common/config/editorOptions.ts#L1928-L1935)).
- At 13 / 20 against 12 / 19 a line holds 7.7 % fewer characters and a panel 5 % fewer lines, 12/13 and 19/20 of what they held; the two faces add 186,636 bytes.

## Font smoothing

- `-webkit-font-smoothing: antialiased` makes WebKit call `CGContextSetShouldSmoothFonts(false)` on macOS ([FontCascadeCoreText.cpp at WebKit-7625.2.8.11.9](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/WebCore/platform/graphics/coretext/FontCascadeCoreText.cpp#L324-L342), the tag of the installed WebKit, 22625.2.8.11.9).
- In an offscreen WKWebView on macOS 27.2 it removed 26 to 29 % of the ink of weight-400 text at 11 to 13 px in the dark theme and 15 % in the light (ink summed over a line's glyph pixels, the text then `#d3d4d5` on `#121314` and `#313335` on white, 2026-11-14).
  Run again on 2026-11-15 with the same colours, the dark theme lost 25 to 29 % at 14 to 11 px with ink taken as coverage in linear light, and 22 to 24 % with it taken as the distance of sRGB values from the background; the light theme lost 13 % and 15 %.
- On a 1x display the median stroke pixel of 12 px text reached 57 % coverage with smoothing and 50 % with `antialiased` (CoreGraphics bitmap, macOS 27.2, 2026-11-14).
- Chrome on macOS honours the property too: about 20 % less ink on a row of the mock's dark theme (headless Chrome, macOS 27.2, 2026-11-14), and 22.5 % on a 13 px line of `#dddedf` on `#121314` (headless Chrome 157, mean grey of a 2x screenshot, 2026-11-15).
- VS Code leaves smoothing on by default on macOS and says that `antialiased` "can make the font appear lighter overall" ([workbench.contribution.ts at 1.146.0](https://github.com/microsoft/vscode/blob/1.146.0/src/vs/workbench/browser/workbench.contribution.ts#L727-L740)).
- WebKitGTK maps `antialiased` to greyscale edging, and `auto` to the edging each font takes from the system's settings, sub-pixel included ([FontSkia.cpp at webkitgtk-2.54.2](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.2/Source/WebCore/platform/graphics/skia/FontSkia.cpp#L210-L219), [FontRenderOptionsSkia.cpp](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.2/Source/WebCore/platform/graphics/skia/FontRenderOptionsSkia.cpp#L79-L85), [SystemSettingsManager.cpp](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.2/Source/WebKit/WebProcess/glib/SystemSettingsManager.cpp#L51-L64)); not measured on Linux.

## Chosen on 2026-11-14 and 2026-11-15

The owner accepted on 2026-11-14:

- four text roles in place of three tiers, with the rule that two adjacent texts in different roles differ by 25 Lc or by a second cue;
- a type scale with two cues a step: section titles at 13 px, 600 and strong, property labels at 12 px in support beside 13 px values, the object's title at 16 px after its kind, table headers at 12 px and 600, prose at 13 / 20, weights 400 and 600 only;
- tabular figures by column and value type, and SF's high-legibility set on identifiers on macOS;
- JetBrains Mono over Geist Mono, bundled with its ligatures off, and logs and YAML at 13 / 20;
- lightness that says what is worth reading now: units and zero counts quiet, an age under ten minutes in content, one alarm a row, a generated name in three parts.

On 2026-11-15, from live variants in the app's window, he kept the roles at the lightness above over the dimmer set, and the platform's own font smoothing over `antialiased` in the dark theme.
