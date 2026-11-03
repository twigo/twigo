import type { KeybindingRule } from "../keybindings/resolver";
import type { Workbench } from "../services";

/**
 * The commands every list, grid and tree answers while it has the focus
 * (ARCHITECTURE 4.4), as VS Code's `list.*`; each is a binding the user
 * may change.
 */
export function registerListCommands(
  { commands, lists }: Workbench,
  rules: KeybindingRule[],
): void {
  const all: readonly {
    id: string;
    title: string;
    keys: readonly string[];
    run: () => void;
  }[] = [
    {
      id: "list.focusDown",
      title: "Focus Next Row",
      keys: ["j", "down"],
      run: () => lists.focused("move")?.move(1),
    },
    {
      id: "list.focusUp",
      title: "Focus Previous Row",
      keys: ["k", "up"],
      run: () => lists.focused("move")?.move(-1),
    },
    {
      id: "list.expandSelectionDown",
      title: "Mark Rows Downwards",
      keys: ["shift+down"],
      run: () => lists.focused("move")?.move(1, true),
    },
    {
      id: "list.expandSelectionUp",
      title: "Mark Rows Upwards",
      keys: ["shift+up"],
      run: () => lists.focused("move")?.move(-1, true),
    },
    {
      id: "list.focusFirst",
      title: "Focus First Row",
      keys: ["home"],
      run: () => lists.focused("moveToEdge")?.moveToEdge("first"),
    },
    {
      id: "list.focusLast",
      title: "Focus Last Row",
      keys: ["end", "shift+g"],
      run: () => lists.focused("moveToEdge")?.moveToEdge("last"),
    },
    {
      id: "list.select",
      title: "Open",
      keys: ["enter"],
      run: () => lists.focused("activate")?.activate(),
    },
    {
      id: "list.toggleMark",
      title: "Mark Row",
      keys: ["x"],
      run: () => lists.focused("toggleMark")?.toggleMark(),
    },
    {
      id: "list.togglePeek",
      title: "Show or Hide Details",
      keys: ["space"],
      run: () => lists.focused("peek")?.peek(),
    },
    {
      id: "list.collapse",
      title: "Collapse",
      keys: ["left"],
      run: () => lists.focused("collapse")?.collapse(),
    },
    {
      id: "list.expand",
      title: "Expand",
      keys: ["right"],
      run: () => lists.focused("expand")?.expand(),
    },
    {
      id: "list.find",
      title: "Filter Rows",
      keys: ["/", "mod+f"],
      run: () => lists.focused("filter")?.filter(),
    },
  ];
  for (const { id, title, keys, run } of all) {
    commands.register({
      id,
      title,
      category: "List",
      enablement: "listFocus",
      run,
    });
    for (const key of keys) rules.push({ key, command: id, when: "listFocus" });
  }
}
