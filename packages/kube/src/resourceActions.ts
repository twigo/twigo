import {
  ArrowDownToLine,
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleSlash,
  Copy,
  FileCode,
  PanelRight,
  Play,
  RotateCcw,
  Scaling,
  ScrollText,
  SquareArrowOutUpRight,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PlanRequest, ResourceRef } from "@twigo/protocol";
import type { Lookup, MenuId, Workbench } from "@twigo/workbench";
import type { ListServices } from "./services";
import { objectOf, objectOfRow, type Selected } from "./selection";
import { objectUri, parseListUri } from "./uri";

/** Where the actions on a node, a workload or a job apply, as when-expressions. */
const NODE = "resource.group == '' && resource.kind == Node";
const RESTARTS =
  "resource.group == apps && resource.kind =~ /^(Deployment|StatefulSet|DaemonSet)$/";
const SUSPENDS =
  "resource.group == batch && resource.kind =~ /^(Job|CronJob)$/";
const CRON_JOB = "resource.group == batch && resource.kind == CronJob";

/** A kind as a sentence names it: `StatefulSet` → `stateful set`. */
function kindWords(kind: string): string {
  return kind.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * The replicas a row says its object wants: a ReplicaSet's Desired, or what
 * follows the slash of a Deployment's or StatefulSet's Ready.
 */
export function replicasOf({ columns, row }: Selected): number | undefined {
  const at = (name: string) =>
    columns.findIndex((column) => column.name === name);
  const desired = row.cells[at("Desired")];
  if (typeof desired === "number") return desired;
  const ready = row.cells[at("Ready")];
  const wanted =
    typeof ready === "string" ? Number(ready.split("/")[1]) : Number.NaN;
  return Number.isInteger(wanted) ? wanted : undefined;
}

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
  /** The selected row's object, for a request of the bus. */
  const reference = (found: { selected: Selected }): ResourceRef => {
    const { gvr, namespaced } = found.selected;
    const { namespace, name } = objectOf(found.selected);
    return { gvr, namespaced, namespace: namespace ?? null, name };
  };
  /** Plans and runs a request of the bus on the selected row's space. */
  const act = async (
    request: (space: string, found: { selected: Selected }) => PlanRequest,
    look: { icon: LucideIcon; destructive: boolean },
  ) => {
    const found = target();
    const space = found && parseListUri(found.uri)?.space;
    if (!found || space === undefined) return;
    await workbench.operations.run(request(space, found), look);
  };
  const node = (found: { selected: Selected }) => objectOf(found.selected).name;

  const actions: readonly {
    id: string;
    title: string;
    icon?: typeof Copy;
    key?: string;
    /** Where the key works, beyond the grid's focus. */
    keyWhen?: string;
    when?: string;
    menus: readonly (readonly [MenuId, string])[];
    run: (lookup: Lookup) => void | Promise<void>;
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
      id: "k8s.resource.scale",
      title: "Scale…",
      icon: Scaling,
      key: "shift+s",
      when: "resource.scalable && resource.capability.patch/scale",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: async () => {
        const found = target();
        if (!found) return;
        const { name } = objectOf(found.selected);
        const now = replicasOf(found.selected);
        const what = `${kindWords(found.selected.kind)} ${name}`;
        const typed = await workbench.quickAccess.input({
          placeholder: "Replicas",
          prompt:
            now === undefined
              ? `Scale ${what}`
              : `Scale ${what}, now at ${String(now)}`,
          acceptLabel: "Scale",
          value: now === undefined ? "" : String(now),
          validate: (value) =>
            /^\d{1,6}$/.test(value.trim())
              ? undefined
              : "Type a count of replicas: 0 or more",
        });
        if (typed === undefined) return;
        await act(
          (space) => ({
            action: "scale",
            space,
            target: reference(found),
            replicas: Number(typed.trim()),
          }),
          { icon: Scaling, destructive: Number(typed.trim()) === 0 },
        );
      },
    },
    {
      id: "k8s.resource.restart",
      title: "Restart",
      icon: RotateCcw,
      key: "shift+r",
      when: `${RESTARTS} && resource.capability.patch`,
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: () =>
        act(
          (space, found) => ({
            action: "restart",
            space,
            target: reference(found),
          }),
          { icon: RotateCcw, destructive: false },
        ),
    },
    {
      id: "k8s.node.cordon",
      title: "Cordon",
      icon: CircleSlash,
      key: "shift+c",
      when: `${NODE} && !resource.cordoned && resource.capability.patch`,
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: () =>
        act(
          (space, found) => ({
            action: "cordon",
            space,
            node: node(found),
            unschedulable: true,
          }),
          { icon: CircleSlash, destructive: false },
        ),
    },
    {
      id: "k8s.node.uncordon",
      title: "Uncordon",
      icon: CircleCheck,
      key: "shift+u",
      when: `${NODE} && resource.cordoned && resource.capability.patch`,
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: () =>
        act(
          (space, found) => ({
            action: "cordon",
            space,
            node: node(found),
            unschedulable: false,
          }),
          { icon: CircleCheck, destructive: false },
        ),
    },
    {
      id: "k8s.node.drain",
      title: "Drain",
      icon: ArrowDownToLine,
      key: "shift+d",
      when: `${NODE} && resource.capability.patch && capability.create.pods/eviction`,
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: () =>
        act((space, found) => ({ action: "drain", space, node: node(found) }), {
          icon: ArrowDownToLine,
          destructive: true,
        }),
    },
    {
      id: "k8s.cronjob.trigger",
      title: "Trigger",
      icon: Play,
      key: "shift+t",
      when: `${CRON_JOB} && capability.create.jobs.batch`,
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: () =>
        act(
          (space, found) => {
            const { namespace, name } = objectOf(found.selected);
            return {
              action: "trigger",
              space,
              namespace: namespace ?? "",
              name,
            };
          },
          { icon: Play, destructive: false },
        ),
    },
    {
      id: "k8s.resource.suspend",
      title: "Suspend",
      icon: CirclePause,
      key: "shift+p",
      when: `${SUSPENDS} && !resource.suspended && resource.capability.patch`,
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: () =>
        act(
          (space, found) => ({
            action: "suspend",
            space,
            target: reference(found),
            suspend: true,
          }),
          { icon: CirclePause, destructive: false },
        ),
    },
    {
      id: "k8s.resource.resume",
      title: "Resume",
      icon: CirclePlay,
      key: "shift+o",
      when: `${SUSPENDS} && resource.suspended && resource.capability.patch`,
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions"],
      ],
      run: () =>
        act(
          (space, found) => ({
            action: "suspend",
            space,
            target: reference(found),
            suspend: false,
          }),
          { icon: CirclePlay, destructive: false },
        ),
    },
    {
      id: "k8s.resource.delete",
      title: "Delete",
      icon: Trash2,
      key: "mod+backspace",
      keyWhen: "!listMarked",
      when: "resource.capability.delete",
      menus: [
        ["resource/context", "9_delete"],
        ["resource/details", "9_delete"],
      ],
      run: () =>
        act(
          (space, found) => ({
            action: "delete",
            space,
            targets: [reference(found)],
          }),
          { icon: Trash2, destructive: true },
        ),
    },
    {
      id: "k8s.resource.deleteMarked",
      title: "Delete",
      icon: Trash2,
      key: "mod+backspace",
      keyWhen: "listMarked",
      when: "resource.capability.delete",
      menus: [["resource/marked", "8_delete"]],
      run: async (lookup) => {
        const uri = editors.active;
        const list = uri === undefined ? undefined : parseListUri(uri);
        if (!uri || !list) return;
        const namespaced = lookup("resource.namespaced") === true;
        const targets = [...selection.marks(uri)].map((id) => {
          const { namespace, name } = objectOfRow(id, namespaced);
          return {
            gvr: list.gvr,
            namespaced,
            namespace: namespace ?? null,
            name,
          };
        });
        await workbench.operations.run(
          { action: "delete", space: list.space, targets },
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
    ({ id, title, icon, key, keyWhen, when, menus: placed, run }, order) => {
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
        run: (_args, lookup) => run(lookup),
      });
      if (key) {
        keys.push({
          key,
          command: id,
          when: keyWhen ? `listFocus && ${keyWhen}` : "listFocus",
        });
      }
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
