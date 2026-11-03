# Workbench design: the resource list, contrast and the surfaces

Research of 2026-11-02 into Kubernetes clients, IDEs, SaaS and operations tools, and design guidelines, after the workbench of M0 and the editors of step 8.
Four surveys read primary sources: code at tags, release notes, issues with their reactions, and the guidelines themselves; it adds to [workbench chrome](workbench-chrome.md) and [details](details.md).
The owner chose from live mockups on 2026-11-03; the choices are in [ARCHITECTURE](../ARCHITECTURE.md) 4.1, 4.4 and 4.9, and the code that carries them in the [frontend architecture](../decisions/frontend-architecture.md).

## Contrast and shape

- Measured from `theme.css` on 2026-11-02 (OKLCH to sRGB, WCAG 2 and APCA 0.0.98G): dark tertiary text oklch(0.56) on the 0.205 shell is 3.9:1 (APCA Lc −28), light tertiary 0.62 on 0.975 is 3.4:1, and the light warning colour as text, 0.72/0.15/75 on white, 2.5:1.
  WCAG 1.4.3 asks 4.5:1 for text under 24 px ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)), and Lc 30 is APCA's floor even for placeholders ([APCA](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html)).
- The focus ring, 2 px of brand at 45 %, measured about 2.4:1 in dark and 1.9:1 in light against the editor; WCAG 1.4.11 asks 3:1 ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)).
- Error and pending rows differed only by the hue of a 6 px dot.
  WCAG 1.4.1 forbids colour as the only cue ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)), and Carbon asks for two of colour, shape and symbol, with a group taking its worst member's state ([Carbon](https://carbondesignsystem.com/patterns/status-indicator-pattern/)).
- Geist animates a status dot only while its state is in flight ([Geist](https://vercel.com/geist/status-dot)).

## Surfaces

- VS Code's Dark 2026 theme makes the content the darkest surface, #121314 under a #191A1B shell, and its status bar takes the shell's colour, filled only while debugging ([2026-dark.json at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/extensions/theme-defaults/themes/2026-dark.json#L180-L194)); JetBrains Islands and Zed do the same ([Islands at idea/262.11879.100](https://github.com/JetBrains/intellij-community/blob/idea/262.11879.100/platform/platform-resources/src/themes/islands/ManyIslandsDark.theme.json#L1032-L1051), [Zed one.json at v1.26.2](https://github.com/zed-industries/zed/blob/v1.26.2/assets/themes/one/one.json#L40)).
- VS Code's guidelines keep colour in the status bar for its remote indicator and for exceptions ([status bar](https://code.visualstudio.com/api/ux-guidelines/status-bar)).
- VS Code and JetBrains put search in the middle of the title bar ([commandCenterControl.ts at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/browser/parts/titlebar/commandCenterControl.ts#L260)), as Windows does with a 48 px title bar ([title bar](https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design)).

## The resource list

- Column width is the most requested table change in Kubernetes clients ([lens#601](https://github.com/lensapp/lens/issues/601), 165 👍); Lens fits a column on a double click of its separator ([2025.10](https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2025-10-230725/)).
- Apple truncates in the middle, which keeps a name's distinctive end ([HIG](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)); Zed's file finder cuts paths in the middle ([file_finder.rs at v1.26.2](https://github.com/zed-industries/zed/blob/v1.26.2/crates/file_finder/src/file_finder.rs#L2174-L2257)).
- Rancher groups a list by namespace or node and keeps the choice ([en-us.yaml at v2.15.3](https://github.com/rancher/dashboard/blob/v2.15.3/shell/assets/translations/en-us.yaml#L6314-L6321)); Linear's group headers carry counts ([display options](https://linear.app/docs/display-options)).
- Linear marks rows with X, extends with Shift and arrows, and shows a bar of actions for the marked ones ([selection](https://linear.app/docs/select-issues)).
- Row actions only on hover are hard to find, so they also live in the context menu ([NN/g](https://www.nngroup.com/articles/data-tables/)).
- Headlamp's overview opens a list with its filter set from a count ([StatusCharts.tsx at v0.46.0](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/cluster/Charts/StatusCharts.tsx#L72-L83)).
- k9s moved delete off Backspace after deletes of the wrong object ([k9s#44](https://github.com/derailed/k9s/issues/44), [k9s#1016](https://github.com/derailed/k9s/issues/1016)).

## Chosen on 2026-11-03

The owner took the list mockup as a whole, with the darker editor and grouping:

- search in the title bar, a connection dot on each space tile, counts and pinned lists in the explorer;
- the health chips as one control, a filter field that names its syntax, grouping by a column with counts in each group's header;
- names with their generated part quieter, a severity edge on failing and pending rows, restarts as a count and its age;
- row actions on hover, marks with a selection bar;
- a status bar in the shell's colour, coloured only in its context item;
- text tiers at 4.5:1 or more, pending drawn as a ring, a solid focus ring, and in dark the editor darker than the shell.

The owner then took the other mockups as well:

- the details beside the list as an inspector, with their state, owner, actions with keys and the object's views as tabs, Space to show them;
- quick access with icons, matches in bold, abnormal states, Recent first and a footer of keys, under the title bar's search;
- the context picker with each space's tile, server, connection and version, and the contexts by kubeconfig file;
- the cluster's home: its tiles, what needs attention in words, its recent items;
- the logs viewer of ARCHITECTURE 4.6, built with step 10;
- production as a mode and friction by blast radius, ARCHITECTURE 6.4, built with M2.

Left for when their data exists: the production label (environment types, M2), CPU and memory columns (metrics, M2), the container card and the reason a pod fails (describers, step 9).
