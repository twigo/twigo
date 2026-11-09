import { ChevronDown, ChevronUp, X, type LucideIcon } from "lucide-react";
import type { Area } from "./editors/registry";
import type { Workbench } from "./services";
import type { MenuId } from "./commands/menus";
import type { KeybindingRule } from "./keybindings/resolver";
import {
  commandsProvider,
  helpProvider,
  spacesProvider,
  symbolsProvider,
} from "./quickaccess/providers";
import { LOCATION_TITLES, SIDE_BARS, type Location } from "./views/registry";
import { useChordEntries, useSpaceEntries } from "./parts/StatusItems";
import { useShellEnvironmentEntries } from "./parts/shellEnvironment";
import {
  RETRY_SHELL_ENVIRONMENT,
  SHOW_SHELL_ENVIRONMENT,
} from "./parts/shellEnvironmentIds";
import { useCredentialEntries } from "./parts/credentials/credentialEntries";
import { registerListCommands } from "./lists/commands";
import { registerSpaceColor } from "./spaces/colorCommand";
import { registerContextModes } from "./spaces/modeCommands";
import { registerQuickInputCommands } from "./quickaccess/commands";
import {
  CANCEL_COUNTDOWN,
  COUNTING_DOWN,
  UNDO,
  UNDOABLE,
} from "./operations/service";
import { useOperationEntries } from "./operations/entries";

const TOGGLES: readonly {
  location: Location;
  id: string;
  title: string;
  key: string;
}[] = [
  {
    location: "sidebar",
    id: "workbench.action.toggleSidebarVisibility",
    title: "Toggle Primary Side Bar",
    key: "mod+b",
  },
  {
    location: "panel",
    id: "workbench.action.togglePanel",
    title: "Toggle Panel",
    key: "mod+j",
  },
  {
    location: "secondary",
    id: "workbench.action.toggleAuxiliaryBar",
    title: "Toggle Secondary Side Bar",
    key: "mod+alt+b",
  },
];

/** The workbench's own commands, keys and status-bar items, through the same registries as any feature. */
export function registerCore(workbench: Workbench): void {
  const { commands, keybindings, spaces, editors, views, quickAccess, menus } =
    workbench;
  const rules: KeybindingRule[] = [];

  for (const provider of [
    commandsProvider(workbench),
    helpProvider(workbench),
    spacesProvider(workbench),
    symbolsProvider(workbench),
  ]) {
    quickAccess.register(provider);
  }
  const openers: readonly {
    id: string;
    title: string;
    prefix: string;
    key?: string;
  }[] = [
    {
      id: "workbench.action.quickOpen",
      title: "Go to Resource…",
      prefix: "",
      key: "mod+p",
    },
    {
      id: "workbench.action.showCommands",
      title: "Show All Commands",
      prefix: ">",
      key: "mod+shift+p",
    },
    {
      id: "workbench.action.quickOpenHelp",
      title: "Quick Access Help",
      prefix: "?",
    },
    {
      id: "workbench.action.switchSpace",
      title: "Switch Space…",
      prefix: "ctx ",
    },
    {
      id: "workbench.action.gotoSymbol",
      title: "Go to Symbol in Editor…",
      prefix: "@",
      key: "mod+shift+o",
    },
  ];
  for (const { id, title, prefix, key } of openers) {
    commands.register({
      id,
      title,
      category: "Go",
      run: () => {
        quickAccess.show(prefix);
      },
    });
    if (key) rules.push({ key, command: id });
  }
  commands.register({
    id: "workbench.action.moveView",
    title: "Move View…",
    category: "View",
    run: async () => {
      const view = await quickAccess.pick(
        "Pick a view to move",
        views
          .allViews()
          .map((candidate) => ({ id: candidate.id, label: candidate.title })),
      );
      const space = spaces.active;
      if (!view || !space) return;
      const target = await quickAccess.pick(
        `Move ${view.label} to`,
        SIDE_BARS.flatMap((location) =>
          views.containers(location).map((container) => ({
            id: container.id,
            label: container.title,
            description: LOCATION_TITLES[location],
          })),
        ),
      );
      if (!target) return;
      spaces.update(space.id, (state) => ({
        ...state,
        placement: { ...state.placement, [view.id]: target.id },
      }));
    },
  });

  for (const { location, id, title, key } of TOGGLES) {
    commands.register({
      id,
      title,
      category: "View",
      run: () => {
        const space = spaces.active;
        if (!space) return;
        const { visible } = spaces.state(space.id).parts[location];
        spaces.setPart(space.id, location, { visible: !visible });
      },
    });
    rules.push({ key, command: id });
  }
  const panel: readonly {
    id: string;
    title: string;
    icon: LucideIcon;
    /** Where the panel's title offers it. */
    when: string;
    enablement?: string;
    part: { visible?: boolean; maximized?: boolean };
  }[] = [
    {
      id: "workbench.action.maximizePanel",
      title: "Maximize Panel Size",
      icon: ChevronUp,
      when: "!panelMaximized",
      // Maximizing a maximized panel changes nothing, so it waits for no state.
      part: { visible: true, maximized: true },
    },
    {
      id: "workbench.action.restorePanel",
      title: "Restore Panel Size",
      icon: ChevronDown,
      when: "panelMaximized",
      enablement: "panelMaximized",
      part: { maximized: false },
    },
    {
      id: "workbench.action.closePanel",
      title: "Hide Panel",
      icon: X,
      when: "panelVisible",
      enablement: "panelVisible",
      part: { visible: false },
    },
  ];
  panel.forEach(({ id, title, icon, when, enablement, part }, order) => {
    commands.register({
      id,
      title,
      category: "View",
      icon,
      ...(enablement !== undefined && { enablement }),
      run: () => {
        const space = spaces.active;
        if (space) spaces.setPart(space.id, "panel", part);
      },
    });
    menus.append("panel/title", {
      command: id,
      group: "navigation",
      order,
      when,
    });
  });

  for (let index = 1; index <= 9; index++) {
    const id = `workbench.action.selectSpace${String(index)}`;
    commands.register({
      id,
      title: `Select Space ${String(index)}`,
      category: "Space",
      enablement: `space.count > ${String(index - 1)}`,
      run: () => {
        const space = spaces.list[index - 1];
        if (space) spaces.select(space.id);
      },
    });
    rules.push({ key: `mod+${String(index)}`, command: id });
  }

  const editor: readonly {
    id: string;
    title: string;
    key?: string;
    run: (uri: string, area: Area) => void;
  }[] = [
    {
      id: "workbench.action.closeActiveEditor",
      title: "Close Editor",
      key: "mod+w",
      run: (uri) => {
        editors.close(uri);
      },
    },
    {
      id: "workbench.action.keepEditor",
      title: "Keep Editor",
      key: "mod+k enter",
      run: (uri) => {
        editors.pin(uri);
      },
    },
    {
      id: "workbench.action.moveEditorToRightGroup",
      title: "Move Editor into New Group to the Right",
      key: "mod+\\",
      run: (_uri, area) => {
        editors.moveActive("right", area);
      },
    },
    {
      id: "workbench.action.moveEditorToBelowGroup",
      title: "Move Editor into New Group Below",
      run: (_uri, area) => {
        editors.moveActive("bottom", area);
      },
    },
  ];
  for (const { id, title, key, run } of editor) {
    commands.register({
      id,
      title,
      category: "Editor",
      enablement: "editor.open || panelFocus",
      run: (_args, lookup) => {
        // The panel's editors take the commands while it has the focus, or
        // covers the editor area, whose editors nobody sees.
        const area: Area =
          lookup("panelFocus") === true || !editors.onScreen("editor")
            ? "panel"
            : "editor";
        const uri =
          area === "panel" ? editors.activeIn("panel") : editors.active;
        if (uri) run(uri, area);
      },
    });
    if (key) rules.push({ key, command: id });
  }

  registerListCommands(workbench, rules);
  registerSpaceColor(workbench);
  registerContextModes(workbench);
  registerQuickInputCommands(workbench, rules);
  keybindings.register("core", rules);

  const menubar: readonly [MenuId, string, readonly string[]][] = [
    ["menubar/file", "1_editor", ["workbench.action.closeActiveEditor"]],
    ["menubar/view", "1_parts", TOGGLES.map(({ id }) => id)],
    ["menubar/view", "2_views", ["workbench.action.moveView"]],
    [
      "menubar/view",
      "3_editor",
      [
        "workbench.action.keepEditor",
        "workbench.action.moveEditorToRightGroup",
        "workbench.action.moveEditorToBelowGroup",
      ],
    ],
    [
      "menubar/go",
      "1_quick",
      [
        "workbench.action.quickOpen",
        "workbench.action.showCommands",
        "workbench.action.gotoSymbol",
      ],
    ],
    ["menubar/go", "2_space", ["workbench.action.switchSpace"]],
    [
      "menubar/window",
      "1_spaces",
      Array.from(
        { length: 9 },
        (_, index) => `workbench.action.selectSpace${String(index + 1)}`,
      ),
    ],
    ["menubar/help", "1_help", ["workbench.action.quickOpenHelp"]],
  ];
  for (const [menu, group, ids] of menubar) {
    ids.forEach((command, order) => {
      menus.append(menu, { command, group, order });
    });
  }

  views.registerStatusBarItem({
    id: "workbench.space",
    alignment: "left",
    priority: 1000,
    useEntries: useSpaceEntries,
  });
  views.registerStatusBarItem({
    id: "workbench.operations",
    alignment: "left",
    priority: 180,
    useEntries: useOperationEntries,
  });
  commands.register({
    id: CANCEL_COUNTDOWN,
    title: "Cancel the Countdown",
    category: "View",
    enablement: COUNTING_DOWN,
    run: () => {
      workbench.operations.cancelCountdown();
    },
  });
  commands.register({
    id: UNDO,
    title: "Undo the Last Action",
    category: "View",
    enablement: `space.id in ${UNDOABLE}`,
    run: async () => {
      const space = workbench.spaces.active;
      if (space) await workbench.operations.undo(space.id);
    },
  });
  keybindings.register("core", [
    {
      key: "mod+z",
      command: UNDO,
      when: `listFocus && space.id in ${UNDOABLE}`,
    },
    {
      key: "mod+z",
      command: CANCEL_COUNTDOWN,
      when: `${COUNTING_DOWN} && !inputFocus`,
    },
  ]);
  views.registerStatusBarItem({
    id: "workbench.chord",
    alignment: "right",
    priority: 100,
    useEntries: useChordEntries,
  });

  const { shellEnvironment } = workbench;
  commands.register({
    id: RETRY_SHELL_ENVIRONMENT,
    title: "Retry Loading the Shell Environment",
    category: "Shell Environment",
    enablement: "shellEnvironment == failed",
    run: () => shellEnvironment.retry(),
  });
  commands.register({
    id: SHOW_SHELL_ENVIRONMENT,
    title: "Show Why the Shell Environment Is Not Loaded",
    category: "Shell Environment",
    enablement: "shellEnvironment == failed",
    run: () => {
      shellEnvironment.setDetailsOpen(true);
    },
  });
  views.registerStatusBarItem({
    id: "workbench.shellEnvironment",
    alignment: "left",
    priority: 200,
    useEntries: useShellEnvironmentEntries,
  });
  views.registerStatusBarItem({
    id: "workbench.credentials",
    alignment: "left",
    priority: 190,
    useEntries: useCredentialEntries,
  });
}
