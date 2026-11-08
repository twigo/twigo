import {
  Check,
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
import type { ObjectRef, ResourceRef } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import type { ContextValue, MenuId, Workbench } from "@twigo/workbench";
import { sameGvr, type Discovery } from "../discovery";
import { refUri } from "../object/useObject";
import type { ObjectTabs } from "../object/tabs";
import { diffUri, parseObjectUri } from "../uri";
import { placementOf } from "./placement";
import { comparisons } from "./compare";
import { parseManifest } from "./object";
import type { Preview, Subject } from "./previews";
import { EDIT_KEYS, editKeys, type EditServices } from "./services";

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

  const editorOf = (args: unknown): string | undefined =>
    typeof args === "object" &&
    args !== null &&
    "uri" in args &&
    typeof args.uri === "string"
      ? args.uri
      : editors.active;

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
    copies.retarget(uri, picked.id);
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

  const present = (uri: string, result: Preview) => {
    if (parseObjectUri(uri)) tabs.set(uri, "yaml");
    const page =
      result.state === "answered" && placementOf(result.answer) === "page";
    editors.close(diffUri({ kind: "apply", editor: uri }));
    if (page) {
      editors.open(diffUri({ kind: "apply", editor: uri }));
    } else {
      editors.open(uri);
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

  const openCreated = (uri: string, space: string, text: string) => {
    const parsed = parseManifest(text);
    const resources = discovery.get(space);
    if (!parsed.ok || resources.state !== "ready") return;
    const { apiVersion, kind, metadata } = parsed.object as {
      apiVersion?: string;
      kind?: string;
      metadata?: { name?: string; namespace?: string };
    };
    if (!apiVersion || !kind || !metadata?.name) return;
    const slash = apiVersion.lastIndexOf("/");
    const created: ObjectRef = {
      group: slash < 0 ? "" : apiVersion.slice(0, slash),
      version: apiVersion.slice(slash + 1),
      kind,
      namespace: metadata.namespace ?? "default",
      name: metadata.name,
    };
    const target = refUri(space, resources.value, created);
    if (!target) return;
    editors.open(target);
    editors.close(uri);
  };

  const finish = (uri: string) => {
    const copy = copies.get(uri);
    const last = previews.get(uri);
    copies.drop(uri);
    previews.clear(uri);
    closeDiffs(uri);
    if (copy?.base === undefined && copy && last?.state === "answered") {
      openCreated(uri, last.subject.space, copy.text);
    } else {
      editors.open(uri);
    }
  };

  const confirm = async (
    uri: string,
    id: number,
    space: string,
    look: LucideIcon,
  ) => {
    const outcome = await workbench.operations.run(
      { action: "apply", space, preview: id },
      { icon: look },
    );
    if (outcome.state === "done") finish(uri);
  };

  const answered = (uri: string) => {
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
        previews.clear(uri);
        closeDiffs(uri);
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
          await comparisons(workbench, uri, ref.namespaced),
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
      enablement: "edit.dirty",
      menus: [["edit/changed", "navigation"]],
      run: (uri) => {
        editors.open(diffUri({ kind: "server", editor: uri }));
      },
    },
    {
      id: "k8s.edit.reload",
      title: "Reload",
      icon: RefreshCw,
      enablement: "edit.dirty",
      menus: [["edit/changed", "navigation"]],
      run: (uri) => {
        copies.drop(uri);
        previews.clear(uri);
        closeDiffs(uri);
        editors.open(uri);
      },
    },
    {
      id: "k8s.edit.keepMine",
      title: "Keep mine",
      icon: GitMerge,
      enablement: "edit.dirty",
      menus: [["edit/changed", "navigation"]],
      run: async (uri) => {
        const stale = answered(uri)?.answer.state === "stale";
        copies.keepMine(uri);
        previews.clear(uri);
        closeDiffs(uri);
        if (stale) await preview(uri);
        else editors.open(uri);
      },
    },
    {
      id: "k8s.edit.force",
      title: "Force",
      icon: Zap,
      enablement: "edit.conflicts",
      menus: [["edit/conflicts", "navigation"]],
      run: async (uri) => {
        const next = await previews.again(uri, { force: true });
        if (next) present(uri, next);
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
        const next = await previews.again(uri, {
          drop: [
            ...new Set([
              ...last.dropped,
              ...last.answer.conflicts.map(({ path }) => path),
            ]),
          ],
        });
        if (next) present(uri, next);
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
        await confirm(uri, last.answer.recreate, last.subject.space, Trash2);
      },
    },
    {
      id: "k8s.edit.confirm",
      title: "Apply",
      icon: Check,
      enablement: "edit.applicable",
      menus: [["edit/diff", "navigation", "edit.ready"]],
      run: async (uri) => {
        const last = answered(uri);
        if (last?.answer.state !== "ready") return;
        if (last.subject.text !== copies.get(uri)?.text) {
          notify.info("The YAML changed after this preview: apply it again.");
          return;
        }
        await confirm(uri, last.answer.id, last.subject.space, Check);
      },
    },
    {
      id: "k8s.edit.dismiss",
      title: "Dismiss",
      icon: X,
      enablement: "edit.answered",
      menus: [["edit/answer", "navigation"]],
      run: (uri) => {
        previews.clear(uri);
        closeDiffs(uri);
        editors.open(uri);
      },
    },
    {
      id: "k8s.manifest.target",
      title: "Change Target Context…",
      icon: Target,
      enablement: "edit.new",
      menus: [["edit/toolbar", "navigation", "edit.new"]],
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
    run: () => {
      editors.open(copies.nextManifest());
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
      when: "editorFocus && edit.dirty",
    },
  ]);

  const follow = () => {
    const uri = editors.active;
    const now: Readonly<Record<string, ContextValue>> =
      uri === undefined ? {} : editKeys(edits, uri);
    for (const key of EDIT_KEYS) keys.set(key, now[key]);
  };
  editors.changes.subscribe(follow);
  copies.changes.subscribe(follow);
  previews.changes.subscribe(follow);
  follow();
}
