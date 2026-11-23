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
import * as v from "valibot";
import type {
  Cell,
  PlanRequest,
  ResourceRef,
  ShellKind,
} from "@twigo/protocol";
import type {
  CommandDescriptor,
  Lookup,
  MenuId,
  Workbench,
} from "@twigo/workbench";
import { singularTitle } from "./kinds";
import type { ListServices } from "./services";
import {
  cellsOf,
  LIST_URI,
  objectOf,
  objectOfRow,
  type Selected,
} from "./selection";
import { OBJECT_SUBJECT } from "./object/pageStates";
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
/** Rows that are objects of the cluster's API: a Helm release is read from Secrets and has no YAML, verbs or capabilities of its own. */
const OBJECT = "resource.group != helm.sh";

/** Where a key of a verb works: in a focused list, and on the Overview of an object editor that has its object, the other views and a text field there taking typing. */
const FOCUSED = `listFocus || (pageFocus && !inputFocus && ${OBJECT_SUBJECT})`;

/**
 * That a container of the pod runs, as the Overview of an open object says on
 * every view of its details and its editor; the list, its keys and a palette
 * opened outside them never know, so there `shell_containers` decides.
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

/**
 * The replicas a row says its object wants: a ReplicaSet's Desired, or what
 * follows the slash of a Deployment's or StatefulSet's Ready.
 */
export function replicasOf(
  cell: (column: string) => Cell | undefined,
): number | undefined {
  const desired = cell("Desired");
  if (typeof desired === "number") return desired;
  if (typeof desired === "string" && /^\d+$/.test(desired))
    return Number(desired);
  const ready = cell("Ready");
  const wanted =
    typeof ready === "string" ? Number(ready.split("/")[1]) : Number.NaN;
  return Number.isInteger(wanted) ? wanted : undefined;
}

/**
 * The object a command acts on, as an object's page names it: the commands of
 * `resource/details` take it from their argument where there is one, and from
 * the list's selected row where there is not.
 */
const SUBJECT = v.object({
  space: v.string(),
  gvr: v.object({
    group: v.string(),
    version: v.string(),
    resource: v.string(),
  }),
  kind: v.string(),
  namespaced: v.boolean(),
  namespace: v.optional(v.string()),
  name: v.string(),
  /** What a row says it wants, which Scale offers as its start. */
  replicas: v.optional(v.number()),
});

export type Subject = v.InferOutput<typeof SUBJECT>;

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
   * The list editor a command was run from, as its lookup says, and none
   * where it says none: the active editor may be another list than the one
   * a press that moves no focus was on.
   */
  const listIn = (lookup: Lookup): string | undefined => {
    const uri = lookup(LIST_URI);
    return typeof uri === "string" ? uri : undefined;
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
  /** The object a command is asked about: its argument's, else the object editor's it is run from, else the selected row's. */
  const subjectOf = (lookup: Lookup, args: unknown): Subject | undefined => {
    const given = v.safeParse(SUBJECT, args);
    if (given.success) return given.output;
    const editor = lookup(OBJECT_SUBJECT);
    if (typeof editor === "string") return v.parse(SUBJECT, JSON.parse(editor));
    const found = target(lookup);
    const space = found && parseListUri(found.uri)?.space;
    if (!found || space === undefined) return undefined;
    const { gvr, kind, namespaced } = found.selected;
    const { namespace, name } = objectOf(found.selected);
    const replicas = replicasOf(cellsOf(found.selected));
    return {
      space,
      gvr,
      kind,
      namespaced,
      ...(namespace !== undefined && { namespace }),
      name,
      ...(replicas !== undefined && { replicas }),
    };
  };
  const reference = (subject: Subject): ResourceRef => ({
    gvr: subject.gvr,
    namespaced: subject.namespaced,
    namespace: subject.namespace ?? null,
    name: subject.name,
  });
  /** Where a command that opens a session finds the subject: none for a cluster-scoped one. */
  const placeOf = (subject: Subject | undefined) =>
    subject?.namespace === undefined
      ? undefined
      : {
          space: subject.space,
          gvr: subject.gvr,
          namespace: subject.namespace,
          name: subject.name,
        };
  /** Plans and runs a request of the bus on the subject's space. */
  const act = async (
    subject: Subject | undefined,
    request: (subject: Subject) => PlanRequest,
    look: { icon: LucideIcon },
  ) => {
    if (subject) await workbench.operations.run(request(subject), look);
  };
  /** Forwards a port of the subject Pod, Service or workload, which the person picks. */
  const forward = async (subject: Subject | undefined) => {
    const place = placeOf(subject);
    if (place)
      await commands.execute(
        "k8s.forward.open",
        workbench.keys.lookup(null),
        place,
      );
  };
  /** Opens a shell, or an attach, in a container of the subject pod. */
  const shell = async (subject: Subject | undefined, kind: ShellKind) => {
    const place = placeOf(subject);
    if (place)
      await commands.execute("k8s.shell.open", workbench.keys.lookup(null), {
        ...place,
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
    run: (lookup: Lookup, args: unknown) => void | Promise<void>;
  }[] = [
    {
      id: "k8s.resource.details",
      title: "Open Details",
      icon: PanelRight,
      when: LIST_URI,
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
      run: async (lookup, args) => {
        const place = placeOf(subjectOf(lookup, args));
        if (place)
          await commands.execute(
            "k8s.logs.open",
            workbench.keys.lookup(null),
            place,
          );
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
      run: (lookup, args) => shell(subjectOf(lookup, args), "shell"),
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
      run: (lookup, args) => shell(subjectOf(lookup, args), "attach"),
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
      run: (lookup, args) => forward(subjectOf(lookup, args)),
    },
    {
      id: "k8s.resource.yaml",
      title: "Show YAML",
      icon: FileCode,
      key: "e",
      when: `${LIST_URI} && ${OBJECT}`,
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
      key: "mod+enter",
      when: `${LIST_URI} && ${OBJECT}`,
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
      run: async (lookup, args) => {
        const subject = subjectOf(lookup, args);
        if (subject) await copy(subject.name);
      },
    },
    {
      id: "k8s.resource.copyNamespacedName",
      title: "Copy Namespace/Name",
      when: "resource.namespaced",
      menus: [["resource/context", "2_copy"]],
      run: async (lookup, args) => {
        const { namespace, name } = subjectOf(lookup, args) ?? {};
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
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          (subject) => ({
            action: "restart",
            space: subject.space,
            target: reference(subject),
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
      run: async (lookup, args) => {
        const subject = subjectOf(lookup, args);
        if (!subject) return;
        const { name, replicas: now } = subject;
        const what = `${singularTitle(subject.kind)} ${name}`;
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
          subject,
          () => ({
            action: "scale",
            space: subject.space,
            target: reference(subject),
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
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          ({ space, name }) => ({
            action: "cordon",
            space,
            node: name,
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
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          ({ space, name }) => ({
            action: "cordon",
            space,
            node: name,
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
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          ({ space, name }) => ({ action: "drain", space, node: name }),
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
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          ({ space, namespace, name }) => ({
            action: "trigger",
            space,
            namespace: namespace ?? "",
            name,
          }),
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
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          (subject) => ({
            action: "suspend",
            space: subject.space,
            target: reference(subject),
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
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          (subject) => ({
            action: "suspend",
            space: subject.space,
            target: reference(subject),
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
      when: OBJECT,
      requires: [
        { when: "resource.capability.delete", reason: "You may not delete it" },
      ],
      danger: true,
      sends: "write",
      menus: [
        ["resource/context", "9_delete"],
        ["resource/details", "9_delete"],
      ],
      run: (lookup, args) =>
        act(
          subjectOf(lookup, args),
          (subject) => ({
            action: "delete",
            space: subject.space,
            targets: [reference(subject)],
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
      when: `marked.capability.delete && ${OBJECT}`,
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
        run: (args, lookup) => run(lookup, args),
      });
      if (key) {
        keys.push({
          key,
          command: id,
          when: keyWhen ? `(${FOCUSED}) && ${keyWhen}` : FOCUSED,
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
