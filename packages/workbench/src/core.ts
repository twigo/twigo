import type { Workbench } from "./services";
import type { KeybindingRule } from "./keybindings/resolver";
import type { Location } from "./views/registry";
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
  const { commands, keybindings, spaces, editors, views } = workbench;
  const rules: KeybindingRule[] = [];

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
