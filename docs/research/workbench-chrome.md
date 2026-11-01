# Workbench chrome: switching clusters, the left rail, surfaces and type

Research of 2026-11-01 for M0 step 6, after the owner found the space tabs in the title bar unclear, the one-icon activity bar wasteful, and the type unlike an IDE.
Three surveys read primary sources: docs, release notes and source at tags.
The choices it led to are in [ARCHITECTURE](../ARCHITECTURE.md) 4.1, 4.2 and 4.9.

## What the Kubernetes clients teach

- **Lens took the hotbar away and gave it back.**
  Lens 5 replaced workspaces with a catalog and a hotbar of 40 px cluster tiles ([v5.0.0](https://github.com/lensapp/lens/releases/tag/v5.0.0)).
  Lens 2024 moved clusters into one navigator tree with tabs from several clusters side by side ([Mirantis, 2024-03-12](https://www.mirantis.com/blog/getting-started-with-lens-2024-early-access)).
  Users pushed back in [lensapp/lens#8101](https://github.com/lensapp/lens/issues/8101): it became easy to open the pods of the wrong cluster, and the old hotbar "made the separation between clusters much firmer".
  Lens put the active cluster in the status bar in 2025.1 and brought the hotbar back on 2025-04-10 ([blog](https://lenshq.io/blog/hotbar-is-back/)).
- **A rail alone does not scale.**
  Users ask for more than 12 slots and for folders ([lensapp/lens#7333](https://github.com/lensapp/lens/issues/7333), [freelensapp/freelens#527](https://github.com/freelensapp/freelens/issues/527) "50+ clusters"), and find initials hard to read ([lensapp/lens#3498](https://github.com/lensapp/lens/issues/3498)).
- **Every client lists every context, searchable, recent first.**
  Headlamp opens a cluster popup with search and recents from its top bar ([shortcutsSlice.ts at v0.46.0](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/redux/shortcutsSlice.ts#L63-L67)); Aptakube a context selector on ⌘O that opens tag groups at once ([1.22.0](https://github.com/aptakube/aptakube/releases/tag/1.22.0)); k9s `:ctx` ([context.go at v0.51.0](https://github.com/derailed/k9s/blob/v0.51.0/internal/render/context.go#L54)).
- **Production is colour plus a guard, repeated where damage happens.**
  Aptakube shows a context's colour on its avatar, in tables, dialogs and shell tabs, with Protected and Read-only levels ([1.22.0](https://github.com/aptakube/aptakube/releases/tag/1.22.0)); JET Pilot asks for the cluster's name before a delete ([README at v2.3.0](https://github.com/unxsist/jet-pilot/blob/v2.3.0/README.md)); k9s marks `[R]` or `[RW]` after the context ([types.go at v0.51.0](https://github.com/derailed/k9s/blob/v0.51.0/internal/ui/types.go#L20-L21)).
- **The side bar is a sectioned resource tree, 200–240 px, never a tree of clusters.**

## What the IDEs teach

- **Surfaces became islands.**
  Fleet did it first (December 2024), JetBrains made Islands the default in 2025.3 ([blog, 2025-12](https://blog.jetbrains.com/platform/2025/12/meet-the-islands-theme-the-new-default-look-for-jetbrains-ides/)), VS Code's Modern UI followed as the default in October 2026 ([blog, 2026-10-15](https://code.visualstudio.com/blogs/2026/10/15/modern-ui)).
  In all three the content is the darkest surface, the shell around it lighter, and the status bar takes the shell's colour with no accent fill.
  JetBrains steps from #191A1C to #26282C ([ManyIslandsDark.theme.json at idea/262.11879.100](https://github.com/JetBrains/intellij-community/blob/idea/262.11879.100/platform/platform-resources/src/themes/islands/ManyIslandsDark.theme.json#L404-L428)); VS Code's cards have 4 px gaps, an 8 px radius and a 1 px border ([floatingPanels.css at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/browser/media/floatingPanels.css#L25-L49)).
- **The left rail shrinks or goes.**
  Zed has none and puts panel toggles in the status bar ([docs](https://zed.dev/docs/visual-customization)); Xcode and Nova put the selector on top of the side bar; VS Code's rail is a 36 px card and can move to the top ([activitybarPart.ts at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/browser/parts/activitybar/activitybarPart.ts#L47-L85)).
- **The title bar holds context and search.**
  JetBrains has project and branch widgets with a colour per project ([docs](https://www.jetbrains.com/help/idea/new-ui.html)); VS Code its Command Center ([commandCenterControl.ts at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/browser/parts/titlebar/commandCenterControl.ts#L260)).
- **Tabs connect to their editor.**
  VS Code dropped detached pill tabs as its default because they "made the active file feel detached from its editor" ([blog, 2026-10-15](https://code.visualstudio.com/blogs/2026/10/15/modern-ui)); preview tabs are italic everywhere.
- **Type: 13 px, two weights, no capitals.**
  VS Code uses the system UI font at 13 px ([style.css at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/browser/media/style.css#L12-L50)) with tokens of 13, 12 and 11 px at weights 400 and 600 ([baseSizes.ts at 1.144.0](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/platform/theme/common/sizes/baseSizes.ts#L12-L77)), and dropped all-caps labels in 2026.
  JetBrains uses Inter at 13 px on every OS ([typography](https://plugins.jetbrains.com/docs/intellij/typography.html)).
  Twigo's weights of 510 and 590 sat between those two and read like a web page.

## What tools with many targets teach

- **A rail suits about seven to nine targets, a dropdown of favourites and recents a few dozen, a searchable picker thousands.**
  Number keys stop at nine in Slack ([shortcuts](https://slack.com/help/articles/201374536-Slack-keyboard-shortcuts)) and Warp ([tabs](https://docs.warp.dev/terminal/windows/tabs.md)); Google Cloud's project picker shows up to 4,000 ([docs](https://docs.cloud.google.com/resource-manager/docs/organization-resource-management)).
- **An environment type works better than a free colour.**
  TablePlus has tags from local to production that cannot be removed, and a Safe Mode for production ([connections](https://tableplus.com/docs/gui-tools/manage-connections)); DBeaver's Prod type turns autocommit off and asks before changes ([connection types](https://dbeaver.com/docs/dbeaver/Connection-Types/)); Postman's own screenshot paints "Production" green ([environment colours](https://learning.postman.com/docs/use/send-requests/variables/environment-colors)).
- **Danger shows on big surfaces and in words.**
  TablePlus colours its status bar and writes the tag ([toolbar](https://tableplus.com/docs/gui-tools/the-interface/toolbar)); DataGrip tints the editor ([colour settings](https://www.jetbrains.com/help/datagrip/2025.3/database-color-settings-dialog.html)); the AWS console colours its navigation bar per account ([2025-08-27](https://aws.amazon.com/about-aws/whats-new/2025/08/aws-management-console-assigning-color-aws-account/)).
- **Switching swaps the whole workspace, it never re-targets open tabs.**
  Postman environments and DBeaver's Ctrl+9 re-point open content at a new target, which can leave staging work open against production.

## Decided with the owner, 2026-11-01

- A rail of space tiles at the left, as Lens's hotbar, replaces the activity bar; ⌘1..9 follow its order, and a button opens the picker of every context.
- The title bar is a breadcrumb of the space and its namespace scope that opens the `ctx ` and `ns ` pickers, a search that opens quick access, and the part toggles; a coloured context tints its left end.
- Connected tabs, sentence-case headers, weights 400 and 600.
  Islands were built and tried; the owner preferred flat parts split by hairlines.
- Side by side with vscode.dev in the same browser, Twigo still read as a web page; VS Code's computed styles showed why: the system UI font, text at #CCCCCC, neutral greys with the editor a step lighter than the shell, and smaller title bar controls.
  Twigo took the same kind of ramp and the platform's UI font, without copying VS Code's chrome.

## Left for later

- Environment types (production, staging, development, local) that set the colour and the guard, assigned by rules over context names and kubeconfig files, belong to the policy work of 6.4 in M2.
- Pinned spaces and a rail that keeps more than nine, and grouping the picker by kubeconfig file, come with the catalog in M1.
