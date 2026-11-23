import {
  Copy,
  Eye,
  EyeOff,
  GitCompare,
  History,
  ShipWheel,
  SquareArrowOutUpRight,
  X,
  type LucideIcon,
} from "lucide-react";
import * as v from "valibot";
import { HELM_RELEASES } from "@twigo/protocol";
import type { ComparedPart } from "@twigo/protocol";
import type { Lookup, Workbench } from "@twigo/workbench";
import { OBJECT_SUBJECT } from "../object/pageStates";
import { LIST_URI, objectOf } from "../selection";
import type { ListServices } from "../services";
import { diffUri, helmUri, listUri, parseListUri } from "../uri";
import {
  HELM_NO_COMMAND,
  HELM_PREVIOUS,
  HELM_REVISION,
  HELM_TAB,
} from "./keys";
import { HELM_RESOURCE } from "./status";

/** Where a command of a release applies, as a when-expression. */
const HELM = "resource.group == helm.sh";

const RELEASE = v.object({
  space: v.string(),
  namespace: v.string(),
  name: v.string(),
});

const REVISION = v.object({
  ...RELEASE.entries,
  revision: v.number(),
  /** The highest revision before it that Helm keeps. */
  previous: v.optional(v.number()),
  /** The revision the editor follows. */
  latest: v.optional(v.number()),
});

const PAIR = v.object({ ...RELEASE.entries, from: v.number(), to: v.number() });

type Release = v.InferOutput<typeof RELEASE>;

/** A release as the commands that act on an object take it: its kind, its resource and where it lives. */
export function releaseSubject({ space, namespace, name }: Release) {
  const { gvr, kind, namespaced } = HELM_RESOURCE;
  return { space, gvr, kind, namespaced, namespace, name };
}

/**
 * The verb of the command that prints each view of a release. The chart's
 * defaults have none: `get values` prints the person's values only.
 */
const VERBS: Readonly<Record<string, string>> = {
  overview: "status",
  values: "get values",
  manifest: "get manifest",
  history: "history",
};

export function printsCommand(view: string): boolean {
  return view in VERBS;
}

/**
 * The command that prints the view a person is looking at, with the context
 * and namespace of the release (ARCHITECTURE 4.3): `helm status` for the
 * overview, `get values`, `get manifest` and `history`; none for a view no
 * command prints.
 */
export function helmCommand(
  release: Release,
  context: string,
  view: string,
  revision: number | undefined,
): string | undefined {
  const verb = VERBS[view];
  if (verb === undefined) return undefined;
  const at =
    revision !== undefined && verb !== "history"
      ? ` --revision ${String(revision)}`
      : "";
  return `helm ${verb} ${release.name} --namespace ${release.namespace} --kube-context ${context}${at}`;
}

/**
 * Commands of Helm releases and the menus that place them (ARCHITECTURE 4.3,
 * 4.4, 5.1): Show Helm Releases, Open Release and Copy helm Command on a list's
 * row and on the release's page, and what History does with a revision.
 */
export function registerHelm(
  workbench: Workbench,
  { selection, releases }: Pick<ListServices, "selection" | "releases">,
): void {
  const { commands, menus, editors, keybindings, spaces } = workbench;
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };
  /** The release a command is asked about: its argument's, else the page's it is run from, else the list's selected row. */
  const releaseOf = (lookup: Lookup, args: unknown): Release | undefined => {
    const given = v.safeParse(RELEASE, args);
    if (given.success) return given.output;
    const page = lookup(OBJECT_SUBJECT);
    if (typeof page === "string") {
      const parsed = v.safeParse(RELEASE, JSON.parse(page));
      if (parsed.success) return parsed.output;
    }
    const uri = lookup(LIST_URI);
    const selected = typeof uri === "string" ? selection.get(uri) : undefined;
    const space =
      typeof uri === "string" ? parseListUri(uri)?.space : undefined;
    if (!selected || space === undefined) return undefined;
    const { namespace, name } = objectOf(selected);
    return namespace === undefined ? undefined : { space, namespace, name };
  };
  const contextOf = (space: string) => spaces.get(space)?.contexts[0];
  const numberOf = (lookup: Lookup, key: string): number | undefined => {
    const value = lookup(key);
    return typeof value === "string" && value !== ""
      ? Number(value)
      : undefined;
  };
  const revisionOf = (lookup: Lookup) => numberOf(lookup, HELM_REVISION);

  const place = (
    id: string,
    title: string,
    icon: LucideIcon,
    where: readonly (readonly [Parameters<typeof menus.append>[0], string])[],
    run: (lookup: Lookup, args: unknown) => void | Promise<void>,
    options: { when?: string; enablement?: string; key?: string } = {},
  ) => {
    commands.register({
      id,
      title,
      category: "Helm",
      icon,
      ...(options.enablement && { enablement: options.enablement }),
      run: (args, lookup) => run(lookup, args),
    });
    for (const [menu, group] of where) {
      menus.append(menu, {
        command: id,
        group,
        ...(options.when && { when: options.when }),
      });
    }
    if (options.key) {
      keybindings.register("core", [
        {
          key: options.key,
          command: id,
          when: `listFocus && ${options.when ?? "true"}`,
        },
      ]);
    }
  };

  commands.register({
    id: "helm.list.open",
    title: "Show Helm Releases",
    category: "Helm",
    icon: ShipWheel,
    run: () => {
      const space = spaces.active;
      if (space) editors.open(listUri({ space: space.id, gvr: HELM_RELEASES }));
    },
  });
  menus.append("menubar/go", {
    command: "helm.list.open",
    group: "3_kubernetes",
    order: 2,
  });

  place(
    "helm.release.open",
    "Open Release",
    SquareArrowOutUpRight,
    [["resource/context", "navigation"]],
    (lookup, args) => {
      const release = releaseOf(lookup, args);
      if (!release) return;
      const list = lookup(LIST_URI);
      if (typeof list === "string") editors.pin(list);
      editors.open(helmUri(release));
    },
    {
      when: `${HELM} && ${LIST_URI}`,
      enablement: `resource.selected && ${HELM}`,
      key: "mod+enter",
    },
  );
  place(
    "helm.release.copyCommand",
    "Copy helm Command",
    Copy,
    [
      ["resource/context", "2_copy"],
      ["resource/details", "2_copy"],
    ],
    async (lookup, args) => {
      const release = releaseOf(lookup, args);
      const context = release && contextOf(release.space);
      if (!release || context === undefined) return;
      const view = lookup(HELM_TAB);
      const command = helmCommand(
        release,
        context,
        typeof view === "string" ? view : "overview",
        revisionOf(lookup),
      );
      if (command !== undefined) await copy(command);
    },
    {
      when: HELM,
      enablement: `resource.selected && ${HELM} && !${HELM_NO_COMMAND}`,
    },
  );
  place(
    "helm.release.compareWithPrevious",
    "Compare with Previous",
    GitCompare,
    [["resource/details", "navigation"]],
    (lookup, args) => {
      const release = releaseOf(lookup, args);
      const shown = revisionOf(lookup);
      const previous = numberOf(lookup, HELM_PREVIOUS);
      if (!release || shown === undefined || previous === undefined) return;
      editors.open(
        diffUri({
          kind: "release",
          release,
          from: previous,
          to: shown,
          part: "values",
        }),
      );
    },
    {
      when: `${HELM} && ${HELM_PREVIOUS}`,
      enablement: `${HELM} && ${HELM_PREVIOUS}`,
    },
  );

  /** Reveal and Hide on the page a person is looking at, the eye's verbs: in the palette, and where they apply to the whole text, in the More menu and the bar over the text. */
  const eye = (
    id: string,
    title: string,
    icon: LucideIcon,
    verb: "reveal" | "hide" | "revealAll" | "hideAll",
    key: string,
    more: boolean,
  ) => {
    commands.register({
      id,
      title,
      category: "Helm",
      icon,
      enablement: key,
      run: (_args, lookup) => {
        const uri = lookup("helm.page");
        if (typeof uri === "string") releases.act(uri, verb);
      },
    });
    if (more) {
      menus.append("resource/details", {
        command: id,
        group: "3_reveal",
        when: key,
      });
      menus.append("helm/text", {
        command: id,
        group: "navigation",
        when: key,
      });
    }
  };
  eye(
    "helm.value.reveal",
    "Reveal Value",
    Eye,
    "reveal",
    "helm.canReveal",
    false,
  );
  eye("helm.value.hide", "Hide Value", EyeOff, "hide", "helm.canHide", false);
  eye(
    "helm.text.revealAll",
    "Reveal All",
    Eye,
    "revealAll",
    "helm.canRevealAll",
    true,
  );
  eye(
    "helm.text.hideAll",
    "Hide All",
    EyeOff,
    "hideAll",
    "helm.canHideAll",
    true,
  );

  commands.register({
    id: "helm.revisions.clearMarks",
    title: "Clear Marks",
    category: "Helm",
    icon: X,
    enablement: "helm.marked",
    run: (_args, lookup) => {
      const uri = lookup("helm.page");
      if (typeof uri === "string") releases.clearMarks(uri);
    },
  });
  menus.append("helm/marked", {
    command: "helm.revisions.clearMarks",
    group: "9_clear",
  });
  keybindings.register("core", [
    {
      key: "escape",
      command: "helm.revisions.clearMarks",
      when: "helm.marked && !detailsOpen",
    },
  ]);

  const compare = (
    id: string,
    title: string,
    menu: "helm/revision" | "helm/revisions",
    schema: typeof REVISION | typeof PAIR,
    run: (arg: never) => void,
  ) => {
    commands.register({
      id,
      title,
      category: "Helm",
      icon: id.includes("compare") ? GitCompare : History,
      run: (args) => {
        const parsed = v.safeParse(schema, args);
        if (parsed.success) run(parsed.output as never);
      },
    });
    menus.append(menu, { command: id, group: "navigation" });
    // It acts on the revision its caller names, so the palette has nothing to give it.
    menus.append("commandPalette", { command: id, when: "false" });
  };
  compare(
    "helm.revision.open",
    "Open Revision",
    "helm/revision",
    REVISION,
    (revision: v.InferOutput<typeof REVISION>) => {
      editors.open(helmUri({ ...revision, revision: revision.revision }));
    },
  );
  const compareRevisions = (
    release: Release,
    from: number,
    to: number,
    part: ComparedPart,
  ) => {
    editors.open(diffUri({ kind: "release", release, from, to, part }));
  };
  compare(
    "helm.revision.compareWithPrevious",
    "Compare with Previous",
    "helm/revision",
    REVISION,
    (revision: v.InferOutput<typeof REVISION>) => {
      if (revision.previous !== undefined)
        compareRevisions(
          revision,
          revision.previous,
          revision.revision,
          "values",
        );
    },
  );
  compare(
    "helm.revision.compareWithCurrent",
    "Compare with Current",
    "helm/revision",
    REVISION,
    (revision: v.InferOutput<typeof REVISION>) => {
      if (revision.latest !== undefined)
        compareRevisions(
          revision,
          revision.revision,
          revision.latest,
          "values",
        );
    },
  );
  for (const [part, title] of [
    ["values", "Compare Values"],
    ["defaults", "Compare Defaults"],
    ["manifest", "Compare Manifests"],
  ] as const) {
    compare(
      `helm.revisions.${part}`,
      title,
      "helm/revisions",
      PAIR,
      (pair: v.InferOutput<typeof PAIR>) => {
        compareRevisions(pair, pair.from, pair.to, part);
      },
    );
  }
}
