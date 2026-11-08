import {
  Check,
  Eye,
  FilePlus,
  GitCompare,
  GitMerge,
  RefreshCw,
  Target,
  Trash2,
  Undo2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toIpcError, type ObjectRef, type ResourceRef } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import type { ContextValue, MenuId, Workbench } from "@twigo/workbench";
import { sameGvr, type Discovery } from "../discovery";
import { refUri } from "../object/useObject";
import type { ObjectTabs } from "../object/tabs";
import { diffUri, parseObjectUri } from "../uri";
import { placementOf } from "./placement";
import { comparisons } from "./compare";
import { parseManifest } from "./object";
import type { Answered, Preview, Subject } from "./previews";
import {
  EDIT_KEYS,
  editKeys,
  editorSpace,
  sourceOf,
  type EditServices,
} from "./services";

/** The object a manifest names: the reference to find it by and the words for the person. */
interface Made {
  readonly ref: ObjectRef;
  readonly what: string;
}

export interface EditContext {
  readonly discovery: Discovery;
  readonly edits: EditServices;
  readonly tabs: ObjectTabs;
}

/**
 * The commands of editing a manifest and applying it (ARCHITECTURE 4.3,
 * 6.5), the menus that place them, and ⌘S. They act on the editor they are
 * given as `{ uri }`, else on the active one; the bars and pages of the
 * editors draw them from `edit/*` menus.
 */
export function registerEdits(
  workbench: Workbench,
  { discovery, edits, tabs }: EditContext,
): void {
  const { commands, menus, keybindings, editors, keys, quickAccess, spaces } =
    workbench;
  const { copies, previews } = edits;

  /** The editor a command acts on: a diff's is the editor whose edit it shows. */
  const editorOf = (args: unknown): string | undefined => {
    const uri =
      typeof args === "object" &&
      args !== null &&
      "uri" in args &&
      typeof args.uri === "string"
        ? args.uri
        : editors.active;
    return uri === undefined ? undefined : sourceOf(uri);
  };

  /** Whether the space the editor belongs to is the one shown: what opens or closes tabs waits otherwise. */
  const inView = (uri: string): boolean => {
    const space = editorSpace(uri);
    return space === undefined || space === spaces.active?.id;
  };

  const reference = (uri: string): ResourceRef | undefined => {
    const input = parseObjectUri(uri);
    if (!input) return undefined;
    const resources = discovery.get(input.space);
    const known =
      resources.state === "ready"
        ? resources.value.find((resource) => sameGvr(resource.gvr, input.gvr))
        : undefined;
    return {
      gvr: input.gvr,
      namespaced: known?.namespaced ?? input.namespace !== undefined,
      namespace: input.namespace ?? null,
      name: input.name,
    };
  };

  const chooseTarget = async (uri: string): Promise<string | undefined> => {
    const active = spaces.active?.id;
    const picked = await quickAccess.pick(
      "Apply to which context?",
      spaces.list
        .filter(({ contexts }) => contexts.length === 1)
        .sort((a, b) => Number(b.id === active) - Number(a.id === active))
        .map(({ id, name }) => ({
          id,
          label: name,
          ...(id === active && { description: "Active" }),
        })),
    );
    if (!picked) return undefined;
    if (picked.id !== copies.get(uri)?.target) {
      copies.retarget(uri, picked.id);
      dropPreview(uri);
    }
    return picked.id;
  };

  const subjectOf = async (uri: string): Promise<Subject | undefined> => {
    const copy = copies.get(uri);
    if (!copy) return undefined;
    if (copy.base === undefined) {
      const space = copy.target ?? (await chooseTarget(uri));
      return space === undefined
        ? undefined
        : { space, opened: null, text: copy.text };
    }
    const target = reference(uri);
    if (!target || copy.lock === undefined) return undefined;
    return {
      space: copy.space,
      opened: {
        target,
        base: JSON.parse(copy.base) as unknown,
        lock: copy.lock,
        ...(copy.locked !== undefined && {
          locked: JSON.parse(copy.locked) as unknown,
        }),
      },
      text: copy.text,
    };
  };

  const closeDiffs = (uri: string) => {
    editors.close(diffUri({ kind: "apply", editor: uri }));
    editors.close(diffUri({ kind: "server", editor: uri }));
  };

  const dropPreview = (uri: string) => {
    previews.clear(uri);
    closeDiffs(uri);
  };

  const back = (uri: string) => {
    if (!inView(uri)) return;
    editors.open(uri);
    copies.focus(uri);
  };

  /**
   * Puts an answer in front of the person: a ready one in a tab of its own,
   * the others in the editor's bar. A preview a newer one or a clear
   * replaced is nothing to show, and one that came after the person went to
   * another space stays with its editor, whose bar offers to show it.
   */
  const present = (uri: string, result: Preview | undefined) => {
    if (result === undefined || !inView(uri)) return;
    if (parseObjectUri(uri)) tabs.set(uri, "yaml");
    const page =
      result.state === "answered" && placementOf(result.answer) === "page";
    editors.close(diffUri({ kind: "apply", editor: uri }));
    if (page) {
      editors.open(diffUri({ kind: "apply", editor: uri }));
      previews.shown(uri);
    } else {
      back(uri);
    }
  };

  const preview = async (
    uri: string,
    choices?: { force?: boolean; drop?: readonly string[] },
  ) => {
    const subject = await subjectOf(uri);
    if (!subject) return;
    present(uri, await previews.run(uri, subject, choices));
  };

  const madeBy = (text: string): Made | undefined => {
    const parsed = parseManifest(text);
    if (!parsed.ok) return undefined;
    const { apiVersion, kind, metadata } = parsed.object as {
      apiVersion?: string;
      kind?: string;
      metadata?: { name?: string; namespace?: string };
    };
    if (!apiVersion || !kind || !metadata?.name) return undefined;
    const slash = apiVersion.lastIndexOf("/");
    return {
      ref: {
        group: slash < 0 ? "" : apiVersion.slice(0, slash),
        version: apiVersion.slice(slash + 1),
        kind,
        namespace: metadata.namespace ?? "default",
        name: metadata.name,
      },
      what: `${kind} ${metadata.namespace === undefined ? "" : `${metadata.namespace}/`}${metadata.name}`,
    };
  };

  const nameOf = (space: string): string =>
    spaces.list.find(({ id }) => id === space)?.name ?? space;

  /**
   * Opens the object a manifest made once the space's discovery says where its
   * kind lives, which discovery follows for the space shown only, and says
   * what keeps it from opening.
   */
  const openMade = async (space: string, made: Made): Promise<boolean> => {
    try {
      const uri = refUri(space, await discovery.resources(space), made.ref);
      if (uri === undefined) {
        notify.warning(`${nameOf(space)} does not serve ${made.ref.kind}`);
        return false;
      }
      editors.open(uri);
      return true;
    } catch (error) {
      notify.error(
        `Cannot open ${made.what} in ${nameOf(space)}: ${toIpcError(error).message}`,
      );
      return false;
    }
  };

  /**
   * The plan of `last` is done. The edit ends only if its text is still what
   * the plan sent: what was typed while it ran stays, to be applied or
   * discarded, and the object it was based on is then changed on the server.
   * A new manifest applied to another space than its editor's stays too, for
   * the person to apply elsewhere, and the toast says what was made where.
   */
  const finish = (uri: string, last: Answered) => {
    const copy = copies.get(uri);
    if (answered(uri)?.answer === last.answer) dropPreview(uri);
    if (copy?.text !== last.subject.text) {
      back(uri);
      return;
    }
    if (copy.base !== undefined) {
      copies.applied(
        uri,
        last.answer.state === "ready" ? last.answer.result : undefined,
      );
      back(uri);
      return;
    }
    const target = last.subject.space;
    const made = madeBy(copy.text);
    if (target !== copy.space) {
      const name = nameOf(target);
      const verb =
        last.answer.state !== "ready"
          ? "Recreated"
          : last.answer.live === null
            ? "Created"
            : "Updated";
      notify.success(
        made ? `${verb} ${made.what} in ${name}` : `Applied to ${name}`,
        made && {
          action: {
            label: `Open in ${name}`,
            run: () => {
              spaces.select(target);
              void openMade(target, made);
            },
          },
        },
      );
      back(uri);
      return;
    }
    copies.applied(uri);
    if (made) {
      void openMade(target, made).then((opened) => {
        if (opened) editors.close(uri);
      });
    }
  };

  const confirm = async (uri: string, id: number, look: LucideIcon) => {
    const last = answered(uri);
    if (!last || last.planning) return;
    previews.planning(uri, last.answer, true);
    let outcome: Awaited<ReturnType<typeof workbench.operations.run>>;
    try {
      outcome = await workbench.operations.run(
        { action: "apply", space: last.subject.space, preview: id },
        { icon: look },
      );
    } finally {
      previews.planning(uri, last.answer, false);
    }
    if (outcome.state === "done") {
      finish(uri, last);
    } else if (
      outcome.state !== "refused" &&
      answered(uri)?.answer === last.answer
    ) {
      // The plan took the preview, whatever came of it.
      dropPreview(uri);
      back(uri);
    }
  };

  const answered = (uri: string): Answered | undefined => {
    const last = previews.get(uri);
    return last?.state === "answered" ? last : undefined;
  };

  type Place = readonly [MenuId, string, string?];
  const definitions: readonly {
    id: string;
    title: string;
    icon: LucideIcon;
    enablement?: string;
    menus: readonly Place[];
    run: (uri: string) => void | Promise<void>;
  }[] = [
    {
      id: "k8s.edit.apply",
      title: "Apply…",
      icon: Check,
      enablement: "edit.dirty",
      menus: [["edit/toolbar", "navigation", "edit.dirty"]],
      run: (uri) => preview(uri),
    },
    {
      id: "k8s.edit.discard",
      title: "Discard Changes",
      icon: Undo2,
      enablement: "edit.dirty",
      menus: [["edit/toolbar", "navigation", "edit.dirty"]],
      run: (uri) => {
        copies.drop(uri);
        dropPreview(uri);
        back(uri);
      },
    },
    {
      id: "k8s.edit.compareWith",
      title: "Compare with…",
      icon: GitCompare,
      enablement: "edit.object",
      menus: [["edit/toolbar", "navigation", "edit.object"]],
      run: async (uri) => {
        const ref = reference(uri);
        if (!ref) return;
        const picked = await quickAccess.pick(
          "Compare with…",
          comparisons(workbench, uri, ref.namespaced),
        );
        if (picked) {
          editors.open(
            diffUri({
              kind: "objects",
              space: parseObjectUri(uri)?.space ?? "",
              left: uri,
              right: picked.id,
            }),
          );
        }
      },
    },
    {
      id: "k8s.edit.compareServer",
      title: "Compare",
      icon: GitCompare,
      enablement: "edit.object && edit.dirty",
      menus: [["edit/changed", "navigation"]],
      run: (uri) => {
        editors.open(diffUri({ kind: "server", editor: uri }));
      },
    },
    {
      id: "k8s.edit.reload",
      title: "Reload",
      icon: RefreshCw,
      enablement: "edit.object && edit.dirty",
      menus: [
        ["edit/changed", "navigation"],
        ["edit/server", "navigation"],
      ],
      run: (uri) => {
        copies.drop(uri);
        dropPreview(uri);
        back(uri);
      },
    },
    {
      id: "k8s.edit.keepMine",
      title: "Keep mine",
      icon: GitMerge,
      enablement: "edit.object && edit.dirty && edit.keepable",
      menus: [
        ["edit/changed", "navigation", "edit.keepable"],
        ["edit/server", "navigation", "edit.keepable"],
      ],
      run: async (uri) => {
        const stale = answered(uri)?.answer.state === "stale";
        copies.keepMine(uri);
        dropPreview(uri);
        if (stale) await preview(uri);
        else back(uri);
      },
    },
    {
      id: "k8s.edit.force",
      title: "Force",
      icon: Zap,
      enablement: "edit.conflicts",
      menus: [["edit/conflicts", "navigation"]],
      run: async (uri) => {
        present(uri, await previews.again(uri, { force: true }));
      },
    },
    {
      id: "k8s.edit.dropMine",
      title: "Drop my change",
      icon: X,
      enablement: "edit.conflicts",
      menus: [["edit/conflicts", "navigation"]],
      run: async (uri) => {
        const last = answered(uri);
        if (last?.answer.state !== "conflicts") return;
        present(
          uri,
          await previews.again(uri, {
            drop: [
              ...new Set([
                ...last.dropped,
                ...last.answer.conflicts.map(({ path }) => path),
              ]),
            ],
          }),
        );
      },
    },
    {
      id: "k8s.edit.recreate",
      title: "Delete and recreate",
      icon: Trash2,
      enablement: "edit.recreate",
      menus: [["edit/immutable", "navigation", "edit.recreate"]],
      run: async (uri) => {
        const last = answered(uri);
        if (last?.answer.state !== "immutable" || last.answer.recreate === null)
          return;
        await confirm(uri, last.answer.recreate, Trash2);
      },
    },
    {
      id: "k8s.edit.confirm",
      title: "Apply",
      icon: Check,
      enablement: "edit.applicable",
      menus: [["edit/diff", "navigation", "edit.ready && !edit.policyLocked"]],
      run: async (uri) => {
        const last = answered(uri);
        if (last?.answer.state !== "ready") return;
        if (last.subject.text !== copies.get(uri)?.text) {
          notify.info("The YAML changed after this preview: apply it again.");
          return;
        }
        await confirm(uri, last.answer.id, Check);
      },
    },
    {
      id: "k8s.edit.dismiss",
      title: "Dismiss",
      icon: X,
      enablement: "edit.answered",
      menus: [["edit/answer", "navigation"]],
      run: (uri) => {
        dropPreview(uri);
        back(uri);
      },
    },
    {
      id: "k8s.edit.show",
      title: "Show Preview",
      icon: Eye,
      enablement: "edit.unshown",
      menus: [["edit/preview", "navigation"]],
      run: (uri) => {
        editors.open(diffUri({ kind: "apply", editor: uri }));
        previews.shown(uri);
      },
    },
    {
      id: "k8s.manifest.target",
      title: "Change Target Context…",
      icon: Target,
      enablement: "edit.new && edit.dirty",
      menus: [["edit/toolbar", "navigation", "edit.new && edit.dirty"]],
      run: async (uri) => {
        await chooseTarget(uri);
      },
    },
  ];

  definitions.forEach(
    ({ id, title, icon, enablement, menus: placed, run }, order) => {
      commands.register({
        id,
        title,
        category: "Edit",
        icon,
        ...(enablement && { enablement }),
        run: async (args) => {
          const uri = editorOf(args);
          if (uri !== undefined) await run(uri);
        },
      });
      if (enablement) {
        menus.append("commandPalette", { command: id, when: enablement });
      }
      for (const [menu, group, when] of placed) {
        menus.append(menu, {
          command: id,
          group,
          order,
          ...(when && { when }),
        });
      }
    },
  );

  commands.register({
    id: "k8s.manifest.new",
    title: "New Manifest",
    category: "File",
    icon: FilePlus,
    enablement: "space.count > 0",
    run: () => {
      const space = spaces.active?.id;
      if (space !== undefined) editors.open(copies.nextManifest(space));
    },
  });
  menus.append("menubar/file", {
    command: "k8s.manifest.new",
    group: "1_new",
  });

  keybindings.register("core", [
    {
      key: "mod+s",
      command: "k8s.edit.apply",
      when: "editorFocus && edit.dirty && editor.type != kube.diff",
    },
  ]);

  const follow = () => {
    const active = editors.active;
    const now: Readonly<Record<string, ContextValue>> =
      active === undefined ? {} : editKeys(edits, sourceOf(active));
    for (const key of EDIT_KEYS) keys.set(key, now[key]);
  };
  editors.changes.subscribe(follow);
  copies.changes.subscribe(follow);
  previews.changes.subscribe(follow);
  follow();
}
