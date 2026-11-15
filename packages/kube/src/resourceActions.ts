import {
  ArrowDownToLine,
  ArrowLeftRight,
  Cable,
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
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PlanRequest, ResourceRef, ShellKind } from "@twigo/protocol";
import type {
  CommandDescriptor,
  Lookup,
  MenuId,
  Workbench,
} from "@twigo/workbench";
import type { ListServices } from "./services";
import { LIST_URI, objectOf, objectOfRow, type Selected } from "./selection";
import { objectUri, parseListUri } from "./uri";

/** Where the actions on a pod, a node, a workload or a job apply, as when-expressions. */
const POD = "resource.group == '' && resource.kind == Pod";
const NODE = "resource.group == '' && resource.kind == Node";
const RESTARTS =
  "resource.group == apps && resource.kind =~ /^(Deployment|StatefulSet|DaemonSet)$/";
const SCALES_PINNED =
  "resource.group == apps && resource.kind =~ /^(Deployment|StatefulSet)$/";
const SUSPENDS =
  "resource.group == batch && resource.kind =~ /^(Job|CronJob)$/";
const CRON_JOB = "resource.group == batch && resource.kind == CronJob";
/** Pinned wherever the item shows. */
const ALWAYS = "true";

/**
 * That a container of the pod runs, as its details' Overview says; the
 * list, the keys and a palette opened outside the details never know, so
 * there `shell_containers` decides.
 */
const RUNS = {
  when: "!resource.noContainerRuns",
  reason: "No container runs",
};

/** That RBAC lets the person patch the object, in the words of what it does. */
const PATCH = (reason: string) => ({
  when: "resource.capability.patch",
  reason,
});

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
 * Commands on a list's selected row and on its marked rows, and
 * the menus that place them (ARCHITECTURE 4.4, 5.1): the row's context
 * menu, the details' row of actions, whose first two pinned verbs the row
 * shows on hover, and the marked rows' bar. Each kind pins its verbs in
 * `resource/details` (4.3): a pod Logs, Shell and Forward, a Deployment or
 * StatefulSet Logs, Restart and Scale, a DaemonSet Logs and Restart, a
 * CronJob Trigger and Suspend or Resume, a node Cordon or Uncordon and
 * Drain, and any other kind Forward where it has one. Delete goes through
 * the command bus, whose plan says how much to ask (6.4); it is ⌘⌫, never a
 * bare key (4.4). A pod's shell and attach open their tab in the panel
 * through `k8s.shell.open`, and a port-forward starts through
 * `k8s.forward.open`.
 */
export function registerResourceActions(
  workbench: Workbench,
  { selection, statuses, states }: ListServices,
): void {
  const { commands, menus, editors, keybindings } = workbench;
  /**
   * The list editor a command was run from, as its lookup says, else the
   * active one: a press that moves no focus leaves another list active.
   */
  const listIn = (lookup: Lookup): string | undefined => {
    const uri = lookup(LIST_URI);
    return typeof uri === "string" ? uri : editors.active;
  };
  /** That list editor and its selected row. */
  const target = (
    lookup: Lookup,
  ): { uri: string; selected: Selected } | undefined => {
    const uri = listIn(lookup);
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
    lookup: Lookup,
    request: (space: string, found: { selected: Selected }) => PlanRequest,
    look: { icon: LucideIcon },
  ) => {
    const found = target(lookup);
    const space = found && parseListUri(found.uri)?.space;
    if (!found || space === undefined) return;
    await workbench.operations.run(request(space, found), look);
  };
  const node = (found: { selected: Selected }) => objectOf(found.selected).name;
  /** Forwards a port of the selected pod, Service or workload; `pick` asks which whatever their number. */
  const forward = async (lookup: Lookup, pick: boolean) => {
    const found = target(lookup);
    const space = found && parseListUri(found.uri)?.space;
    if (!found || space === undefined) return;
    const { namespace, name } = objectOf(found.selected);
    if (namespace === undefined) return;
    await commands.execute("k8s.forward.open", workbench.keys.lookup(null), {
      space,
      gvr: found.selected.gvr,
      namespace,
      name,
      ...(pick && { pick }),
    });
  };
  /** Opens a shell, or an attach, in a container of the selected pod. */
  const shell = async (lookup: Lookup, kind: ShellKind) => {
    const found = target(lookup);
    const space = found && parseListUri(found.uri)?.space;
    if (!found || space === undefined) return;
    const { namespace, name } = objectOf(found.selected);
    if (namespace === undefined) return;
    await commands.execute("k8s.shell.open", workbench.keys.lookup(null), {
      space,
      gvr: found.selected.gvr,
      namespace,
      name,
      kind,
    });
  };

  const actions: readonly {
    id: string;
    title: string;
    icon?: typeof Copy;
    key?: string;
    /** Where the key works, beyond the grid's focus. */
    keyWhen?: string;
    /** Where it applies: the details keep its place there while a requirement fails. */
    when?: string;
    requires?: CommandDescriptor["requires"];
    danger?: true;
    sends?: CommandDescriptor["sends"];
    /** Each menu, its group, and in `resource/details` where it is pinned. */
    menus: readonly (readonly [MenuId, string, string?])[];
    run: (lookup: Lookup) => void | Promise<void>;
  }[] = [
    {
      id: "k8s.resource.details",
      title: "Open Details",
      icon: PanelRight,
      menus: [["resource/context", "navigation"]],
      run: (lookup) => {
        const found = target(lookup);
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
        ["resource/details", "navigation", `${POD} || ${RESTARTS}`],
      ],
      run: async (lookup) => {
        const found = target(lookup);
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
      id: "k8s.resource.shell",
      title: "Shell",
      icon: SquareTerminal,
      key: "s",
      when: "resource.shell",
      requires: [RUNS],
      sends: "exec",
      menus: [
        ["resource/context", "navigation"],
        ["resource/details", "navigation", ALWAYS],
      ],
      run: (lookup) => shell(lookup, "shell"),
    },
    {
      id: "k8s.resource.attach",
      title: "Attach",
      icon: Cable,
      when: "resource.shell",
      requires: [RUNS],
      sends: "exec",
      menus: [
        ["resource/context", "navigation"],
        ["resource/details", "navigation"],
      ],
      run: (lookup) => shell(lookup, "attach"),
    },
    {
      id: "k8s.resource.forward",
      title: "Forward",
      icon: ArrowLeftRight,
      key: "f",
      when: "resource.forward",
      menus: [
        ["resource/context", "navigation"],
        ["resource/details", "navigation", `!(${RESTARTS})`],
      ],
      run: (lookup) => forward(lookup, false),
    },
    {
      id: "k8s.resource.forwardPick",
      title: "Forward Port…",
      icon: ArrowLeftRight,
      key: "shift+f",
      when: "resource.forward",
      menus: [
        ["resource/context", "navigation"],
        ["resource/details", "navigation"],
      ],
      run: (lookup) => forward(lookup, true),
    },
    {
      id: "k8s.resource.yaml",
      title: "Show YAML",
      icon: FileCode,
      key: "e",
      menus: [["resource/context", "navigation"]],
      run: (lookup) => {
        const found = target(lookup);
        if (!found) return;
        states.setDetailsTab(found.uri, "yaml");
        selection.set(found.uri, { ...found.selected, reveal: true });
      },
    },
    {
      id: "k8s.resource.openEditor",
      title: "Open in Editor",
      icon: SquareArrowOutUpRight,
      menus: [["resource/context", "navigation"]],
      run: (lookup) => {
        const found = target(lookup);
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
      menus: [["resource/context", "2_copy"]],
      run: async (lookup) => {
        const found = target(lookup);
        if (found) await copy(objectOf(found.selected).name);
      },
    },
    {
      id: "k8s.resource.copyNamespacedName",
      title: "Copy Namespace/Name",
      when: "resource.namespaced",
      menus: [["resource/context", "2_copy"]],
      run: async (lookup) => {
        const found = target(lookup);
        const { namespace, name } = found ? objectOf(found.selected) : {};
        if (namespace && name) await copy(`${namespace}/${name}`);
      },
    },
    {
      id: "k8s.resource.copyMarkedNames",
      title: "Copy Names",
      icon: Copy,
      menus: [["resource/marked", "1_copy"]],
      run: async (lookup) => {
        const uri = listIn(lookup);
        const list = uri === undefined ? undefined : statuses.get(uri);
        if (!uri || !list) return;
        const names = [...selection.marks(uri)].map(
          (id) => id.split("/").pop() ?? id,
        );
        await copy(names.sort().join("\n"));
      },
    },
    {
      id: "k8s.resource.restart",
      title: "Restart",
      icon: RotateCcw,
      key: "shift+r",
      when: RESTARTS,
      requires: [PATCH("You may not restart it")],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", ALWAYS],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => ({
            action: "restart",
            space,
            target: reference(found),
          }),
          { icon: RotateCcw },
        ),
    },
    {
      id: "k8s.resource.scale",
      title: "Scale…",
      icon: Scaling,
      key: "shift+s",
      when: "resource.scalable",
      requires: [
        {
          when: "resource.capability.patch/scale",
          reason: "You may not scale it",
        },
      ],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", SCALES_PINNED],
      ],
      run: async (lookup) => {
        const found = target(lookup);
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
          lookup,
          (space) => ({
            action: "scale",
            space,
            target: reference(found),
            replicas: Number(typed.trim()),
          }),
          { icon: Scaling },
        );
      },
    },
    {
      id: "k8s.node.cordon",
      title: "Cordon",
      icon: CircleSlash,
      key: "shift+c",
      when: `${NODE} && !resource.cordoned`,
      requires: [PATCH("You may not cordon it")],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", ALWAYS],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => ({
            action: "cordon",
            space,
            node: node(found),
            unschedulable: true,
          }),
          { icon: CircleSlash },
        ),
    },
    {
      id: "k8s.node.uncordon",
      title: "Uncordon",
      icon: CircleCheck,
      key: "shift+u",
      when: `${NODE} && resource.cordoned`,
      requires: [PATCH("You may not uncordon it")],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", ALWAYS],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => ({
            action: "cordon",
            space,
            node: node(found),
            unschedulable: false,
          }),
          { icon: CircleCheck },
        ),
    },
    {
      id: "k8s.node.drain",
      title: "Drain",
      icon: ArrowDownToLine,
      key: "shift+d",
      when: NODE,
      requires: [
        PATCH("You may not cordon it"),
        {
          when: "capability.create.pods/eviction",
          reason: "You may not evict its pods",
        },
      ],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", ALWAYS],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => ({ action: "drain", space, node: node(found) }),
          { icon: ArrowDownToLine },
        ),
    },
    {
      id: "k8s.cronjob.trigger",
      title: "Trigger",
      icon: Play,
      key: "shift+t",
      when: CRON_JOB,
      requires: [
        {
          when: "capability.create.jobs.batch",
          reason: "You may not create Jobs here",
        },
      ],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", ALWAYS],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => {
            const { namespace, name } = objectOf(found.selected);
            return {
              action: "trigger",
              space,
              namespace: namespace ?? "",
              name,
            };
          },
          { icon: Play },
        ),
    },
    {
      id: "k8s.resource.suspend",
      title: "Suspend",
      icon: CirclePause,
      key: "shift+p",
      when: `${SUSPENDS} && !resource.suspended && !resource.ended`,
      requires: [PATCH("You may not suspend it")],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", CRON_JOB],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => ({
            action: "suspend",
            space,
            target: reference(found),
            suspend: true,
          }),
          { icon: CirclePause },
        ),
    },
    {
      id: "k8s.resource.resume",
      title: "Resume",
      icon: CirclePlay,
      key: "shift+o",
      when: `${SUSPENDS} && resource.suspended && !resource.ended`,
      requires: [PATCH("You may not resume it")],
      sends: "write",
      menus: [
        ["resource/context", "5_actions"],
        ["resource/details", "5_actions", CRON_JOB],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => ({
            action: "suspend",
            space,
            target: reference(found),
            suspend: false,
          }),
          { icon: CirclePlay },
        ),
    },
    {
      id: "k8s.resource.delete",
      title: "Delete",
      icon: Trash2,
      key: "mod+backspace",
      keyWhen: "!listMarked",
      requires: [
        { when: "resource.capability.delete", reason: "You may not delete it" },
      ],
      danger: true,
      sends: "write",
      menus: [
        ["resource/context", "9_delete"],
        ["resource/details", "9_delete"],
      ],
      run: (lookup) =>
        act(
          lookup,
          (space, found) => ({
            action: "delete",
            space,
            targets: [reference(found)],
          }),
          { icon: Trash2 },
        ),
    },
    {
      id: "k8s.resource.deleteMarked",
      title: "Delete",
      icon: Trash2,
      key: "mod+backspace",
      keyWhen: "listMarked",
      when: "marked.capability.delete",
      danger: true,
      sends: "write",
      menus: [["resource/marked", "8_delete"]],
      run: async (lookup) => {
        const uri = listIn(lookup);
        const list = uri === undefined ? undefined : parseListUri(uri);
        if (!uri || !list) return;
        const namespaced = lookup("resource.namespaced") === true;
        const marked = [...selection.marks(uri)];
        const targets = marked.map((id) => {
          const { namespace, name } = objectOfRow(id, namespaced);
          return {
            gvr: list.gvr,
            namespaced,
            namespace: namespace ?? null,
            name,
          };
        });
        const outcome = await workbench.operations.run(
          { action: "delete", space: list.space, targets },
          { icon: Trash2 },
        );
        if (outcome.state === "done" || outcome.state === "stopped") {
          selection.mark(uri, marked, false);
        }
      },
    },
    {
      id: "k8s.list.clearMarks",
      title: "Clear Marks",
      icon: X,
      menus: [["resource/marked", "9_clear"]],
      run: (lookup) => {
        const uri = listIn(lookup);
        if (uri) selection.mark(uri, [...selection.marks(uri)], false);
      },
    },
  ];
  const keys: { key: string; command: string; when: string }[] = [];
  actions.forEach(
    (
      {
        id,
        title,
        icon,
        key,
        keyWhen,
        when,
        requires = [],
        danger,
        sends,
        menus: placed,
        run,
      },
      order,
    ) => {
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
        ...(requires.length > 0 && { requires }),
        ...(danger && { danger }),
        ...(sends && { sends }),
        run: (_args, lookup) => run(lookup),
      });
      if (key) {
        keys.push({
          key,
          command: id,
          when: keyWhen ? `listFocus && ${keyWhen}` : "listFocus",
        });
      }
      // The details keep a verb in its place while it cannot run, saying
      // why; the other menus leave it out.
      const runs = [when, ...requires.map((needed) => needed.when)]
        .filter((part) => part !== undefined)
        .join(" && ");
      for (const [menu, group, pin] of placed) {
        const shown = menu === "resource/details" ? when : runs;
        menus.append(menu, {
          command: id,
          group,
          order,
          ...(shown && { when: shown }),
          ...(pin && { pin }),
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
