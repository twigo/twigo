import {
  Copy,
  FileCode,
  PanelRight,
  ScrollText,
  SquareArrowOutUpRight,
  Trash2,
  X,
} from "lucide-react";
import type { MenuId, Workbench } from "@twigo/workbench";
import type { ListServices } from "./services";
import { objectOf, type Selected } from "./selection";
import { objectUri, parseListUri } from "./uri";

/**
 * Commands on the active list's selected row and on its marked rows, and
 * the menus that place them (ARCHITECTURE 4.4, 5.1): the row's context
 * menu, its hover buttons and the marked rows' bar, and an object editor's
 * title. Delete goes through the command bus, whose plan says how much to
 * ask (6.4); it is ⌘⌫, never a bare key (4.4). Shell joins them with its
 * command.
 */
export function registerResourceActions(
  workbench: Workbench,
  { selection, statuses, states }: ListServices,
): void {
  const { commands, menus, editors, keybindings } = workbench;
  /** The active list editor and its selected row. */
  const target = (): { uri: string; selected: Selected } | undefined => {
    const uri = editors.active;
    const selected = uri === undefined ? undefined : selection.get(uri);
    return uri && selected ? { uri, selected } : undefined;
  };
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  const actions: readonly {
    id: string;
    title: string;
    icon?: typeof Copy;
    key?: string;
    when?: string;
    menus: readonly (readonly [MenuId, string])[];
    run: () => void | Promise<void>;
  }[] = [
    {
      id: "k8s.resource.details",
      title: "Open Details",
      icon: PanelRight,
      menus: [
        ["resource/context", "navigation"],
        ["resource/inline", "navigation"],
      ],
      run: () => {
        const found = target();
        if (found)
          selection.set(found.uri, { ...found.selected, reveal: true });
      },
    },
    {
      id: "k8s.resource.logs",
      title: "Logs",
      icon: ScrollText,
      key: "l",
      when: "resource.logs",
      menus: [
        ["resource/context", "navigation"],
        ["resource/inline", "navigation"],
        ["resource/details", "navigation"],
      ],
      run: async () => {
        const found = target();
        const space = found && parseListUri(found.uri)?.space;
        if (!found || space === undefined) return;
        const { namespace, name } = objectOf(found.selected);
        if (namespace === undefined) return;
        await commands.execute("k8s.logs.open", workbench.keys.lookup(null), {
          space,
          gvr: found.selected.gvr,
          namespace,
          name,
        });
      },
    },
    {
      id: "k8s.resource.yaml",
      title: "Show YAML",
      icon: FileCode,
      key: "e",
      menus: [
        ["resource/context", "navigation"],
        ["resource/details", "navigation"],
      ],
      run: () => {
        const found = target();
        if (!found) return;
        states.setDetailsTab(found.uri, "yaml");
        selection.set(found.uri, { ...found.selected, reveal: true });
      },
    },
    {
      id: "k8s.resource.openEditor",
      title: "Open in Editor",
      icon: SquareArrowOutUpRight,
      menus: [
        ["resource/context", "navigation"],
        ["resource/inline", "navigation"],
        ["resource/details", "navigation"],
      ],
      run: () => {
        const found = target();
        const space = found && parseListUri(found.uri)?.space;
        if (!found || space === undefined) return;
        const { namespace, name } = objectOf(found.selected);
        editors.pin(found.uri);
        editors.open(
          objectUri({
            space,
            gvr: found.selected.gvr,
            ...(namespace !== undefined && { namespace }),
            name,
          }),
        );
      },
    },
    {
      id: "k8s.resource.copyName",
      title: "Copy Name",
      icon: Copy,
      menus: [
        ["resource/context", "2_copy"],
        ["resource/inline", "2_copy"],
      ],
      run: async () => {
        const found = target();
        if (found) await copy(objectOf(found.selected).name);
      },
    },
    {
      id: "k8s.resource.copyNamespacedName",
      title: "Copy Namespace/Name",
      when: "resource.namespaced",
      menus: [["resource/context", "2_copy"]],
      run: async () => {
        const found = target();
        const { namespace, name } = found ? objectOf(found.selected) : {};
        if (namespace && name) await copy(`${namespace}/${name}`);
      },
    },
    {
      id: "k8s.resource.copyMarkedNames",
      title: "Copy Names",
      icon: Copy,
      menus: [["resource/marked", "1_copy"]],
      run: async () => {
        const uri = editors.active;
        const list = uri === undefined ? undefined : statuses.get(uri);
        if (!uri || !list) return;
        const names = [...selection.marks(uri)].map(
          (id) => id.split("/").pop() ?? id,
        );
        await copy(names.sort().join("\n"));
      },
    },
    {
      id: "k8s.resource.delete",
      title: "Delete",
      icon: Trash2,
      key: "mod+backspace",
      menus: [
        ["resource/context", "9_delete"],
        ["resource/details", "9_delete"],
      ],
      run: async () => {
        const found = target();
        const space = found && parseListUri(found.uri)?.space;
        if (!found || space === undefined) return;
        const { gvr, namespaced } = found.selected;
        const { namespace, name } = objectOf(found.selected);
        await workbench.operations.run(
          {
            action: "delete",
            space,
            target: { gvr, namespaced, namespace: namespace ?? null, name },
          },
          { icon: Trash2, destructive: true },
        );
      },
    },
    {
      id: "k8s.list.clearMarks",
      title: "Clear Marks",
      icon: X,
      menus: [["resource/marked", "9_clear"]],
      run: () => {
        const uri = editors.active;
        if (uri) selection.mark(uri, [...selection.marks(uri)], false);
      },
    },
  ];
  const keys: { key: string; command: string; when: string }[] = [];
  actions.forEach(
    ({ id, title, icon, key, when, menus: placed, run }, order) => {
      // The row's details and the marked rows' bar sit beside the grid, so a
      // command needs a selected row or marks, not the grid's focus; its key
      // works only in the grid.
      const needs = placed.some(([menu]) => menu === "resource/marked")
        ? "listMarked"
        : "resource.selected";
      commands.register({
        id,
        title,
        category: "Resource",
        ...(icon && { icon }),
        enablement: when ? `${needs} && ${when}` : needs,
        run,
      });
      if (key) keys.push({ key, command: id, when: "listFocus" });
      for (const [menu, group] of placed) {
        menus.append(menu, {
          command: id,
          group,
          order,
          ...(when && { when }),
        });
      }
    },
  );
  keybindings.register("core", [
    ...keys,
    {
      key: "escape",
      command: "k8s.list.clearMarks",
      when: "listMarked && !detailsOpen",
    },
  ]);
}
