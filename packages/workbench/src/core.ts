import type { Workbench } from "./services";
import type { KeybindingRule } from "./keybindings/resolver";
import {
  commandsProvider,
  helpProvider,
  spacesProvider,
  symbolsProvider,
} from "./quickaccess/providers";
import { LOCATION_TITLES, LOCATIONS, type Location } from "./views/registry";
import { ChordItem, NamespacesItem, SpaceItem } from "./parts/StatusItems";

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
  const { commands, keybindings, spaces, editors, views, quickAccess } =
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
        LOCATIONS.flatMap((location) =>
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
    run: (uri: string) => void;
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
      run: () => {
        editors.moveActive("right");
      },
    },
    {
      id: "workbench.action.moveEditorToBelowGroup",
      title: "Move Editor into New Group Below",
      run: () => {
        editors.moveActive("bottom");
      },
    },
  ];
  for (const { id, title, key, run } of editor) {
    commands.register({
      id,
      title,
      category: "Editor",
      enablement: "editor.type",
      run: () => {
        const uri = editors.active;
        if (uri) run(uri);
      },
    });
    if (key) rules.push({ key, command: id });
  }

  keybindings.register("core", rules);

  views.registerStatusBarItem({
    id: "workbench.space",
    alignment: "left",
    priority: 100,
    component: SpaceItem,
  });
  views.registerStatusBarItem({
    id: "workbench.namespaces",
    alignment: "left",
    priority: 90,
    component: NamespacesItem,
  });
  views.registerStatusBarItem({
    id: "workbench.chord",
    alignment: "right",
    priority: 100,
    component: ChordItem,
  });
}
