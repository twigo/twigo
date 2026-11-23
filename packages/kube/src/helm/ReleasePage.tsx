import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import {
  HELM_RELEASES,
  REFUSED,
  type HelmPart,
  type ObjectRef,
  type Overview as Document,
  type ReleaseSnapshot,
  type Section,
} from "@twigo/protocol";
import {
  ActionRow,
  type ActionGroups,
  EmptyState,
  LinkButton,
  Section as Folding,
  Skeleton,
  TabBar,
} from "@twigo/ui";
import {
  ErrorMessage,
  useChanges,
  useWorkbench,
  variants,
} from "@twigo/workbench";
import { useResources } from "../discovery";
import { yamlOfObject } from "../edit/object";
import { ObjectHeader } from "../object/ObjectHeader";
import { Overview } from "../object/Overview";
import { TONE } from "../object/tone";
import { ObjectViews } from "../object/ObjectViews";
import { FULL_PAGE, useClientWidth, useHeld } from "../object/pageStage";
import {
  OBJECT_FILTERED,
  OBJECT_SUBJECT,
  OBJECT_URI,
  useFiltered,
} from "../object/pageStates";
import { useReveal } from "../object/reveal";
import { RevealButton } from "../object/RevealButton";
import { refUri } from "../object/useObject";
import { useHeader } from "../object/useHeader";
import { Prose } from "../object/values";
import { Vitals } from "../object/Vitals";
import type { ListServices } from "../services";
import type { ReleaseInput } from "../uri";
import { ViewStatus } from "../ViewStatus";
import { HistoryList } from "./HistoryList";
import { printsCommand, releaseSubject } from "./commands";
import {
  HELM_NO_COMMAND,
  HELM_PREVIOUS,
  HELM_REVISION,
  HELM_TAB,
} from "./keys";
import {
  hiddenCount,
  hiddenWords,
  manifestOf,
  partKey,
  spliced,
  valueGlyphs,
  type Glyph,
  type Shown,
} from "./reveals";
import type { Plate, ReleaseTab, TextState } from "./states";
import { TextBar } from "./TextBar";
import { ValuesTree } from "./ValuesTree";
import { useRelease } from "./useRelease";

const MaskedText = lazy(() => import("./MaskedText"));

const KIND = "Helm release";

const TABS: Readonly<
  Record<"four" | "split", readonly (readonly [ReleaseTab, string])[]>
> = {
  four: [
    ["overview", "Overview"],
    ["values", "Values"],
    ["manifest", "Manifest"],
    ["history", "History"],
  ],
  split: [
    ["overview", "Overview"],
    ["values", "Values"],
    ["manifest", "Manifest"],
    ["hooks", "Hooks"],
    ["notes", "Notes"],
    ["history", "History"],
    ["objects", "Objects"],
  ],
};

/** What the split variant gives a view of its own, which its Overview leaves out. */
const OWN: Readonly<Record<string, ReleaseTab>> = {
  "helm.hooks": "hooks",
  "helm.objects": "objects",
  "helm.notes": "notes",
};

/** The core's Overview with Helm's description a field of the Diagnostics section, where the page's filter finds it and the section keeps the Reveal. */
function withDescription(overview: Document, description: string): Document {
  if (description === "") return overview;
  return {
    ...overview,
    sections: overview.sections.map((section) =>
      section.id === "helm.diagnostics"
        ? {
            ...section,
            blocks: [
              ...section.blocks,
              {
                type: "fields",
                fields: [
                  {
                    label: "Description",
                    value: { type: "text", text: description },
                    default: false,
                  },
                ],
              },
            ],
          }
        : section,
    ),
  };
}

/** The core's Overview with Notes, which the page adds after the findings where the chart has any. */
function withNotes(overview: Document, notes: string): Document {
  if (notes === "") return overview;
  const section: Section = {
    id: "helm.notes",
    title: "Notes",
    summary: [],
    tone: null,
    fold: "folded",
    blocks: [
      {
        type: "fields",
        fields: [
          {
            label: "",
            value: { type: "text", text: notes },
            default: false,
          },
        ],
      },
    ],
  };
  const at = overview.sections.findIndex(({ id }) => id === "helm.diagnostics");
  return {
    ...overview,
    sections: [
      ...overview.sections.slice(0, at + 1),
      section,
      ...overview.sections.slice(at + 1),
    ],
  };
}

/**
 * What a view of the page draws of the Overview, which the page's filter
 * reads: the split variant keeps the notes, the hooks and the objects in
 * views of their own, each section of which is open there.
 */
function pageOverview(
  overview: Document,
  view: ReleaseTab,
  split: boolean,
  notes: string,
  description: string,
): Document {
  const described = withDescription(overview, description);
  return split
    ? {
        ...described,
        sections: described.sections
          .filter(({ id }) => (OWN[id] ?? "overview") === view)
          .map((section) =>
            view === "overview"
              ? section
              : { ...section, fold: "open" as const },
          ),
      }
    : withNotes(described, notes);
}

function foundTone(overview: Document | undefined) {
  const tone = overview?.sections.find(
    ({ id }) => id === "helm.diagnostics",
  )?.tone;
  return tone ? TONE[tone] : undefined;
}

interface ReleasePageProps {
  /** What the page's state is kept by: the editor's URI, or the list's for its inspector. */
  readonly uri: string;
  readonly release: ReleaseInput;
  readonly services: ListServices;
  /** Beside the header's name: Copy Name, and for the inspector Open and Close; `run` executes a command on this release. */
  readonly controls: (run: (command: string) => void) => ReactNode;
  /** Opens a revision in an editor of its own. */
  readonly onOpenRevision: (revision: number) => void;
  /** Opens the release anew, where Twigo stopped it or could not open it. */
  readonly onReopen: () => void;
}

/**
 * A Helm release as the object page's frame draws it (ARCHITECTURE 4.3): the
 * header, the vitals, a row of views and the view, in the editor and in the
 * list's inspector alike. Rust follows the revision the page shows, the
 * latest unless one is pinned, and sends the parts of the views that are
 * shown.
 */
export function ReleasePage({
  uri,
  release,
  services,
  controls,
  onOpenRevision,
  onReopen,
}: ReleasePageProps) {
  const workbench = useWorkbench();
  const { backend, keys, menus, spaces, colors } = workbench;
  const { releases: states } = services;
  useChanges(states.changes);
  useChanges(menus.changes);
  useChanges(spaces.changes);
  useChanges(colors.changes);
  // @todo: drop this read once the owner has chosen the release editor's views (tabs:four, tabs:split, tabs:page), keeping the choice's branch
  const { tabs: layout } = variants();
  const asked = layout === "page" ? "page" : states.tab(uri);
  const tab: ReleaseTab = asked === "page" ? "overview" : asked;
  const view =
    layout === "page"
      ? "page"
      : tab === "values" && states.plate(uri) === "defaults"
        ? "defaults"
        : tab;
  const wanted = (shown: ReleaseTab) => layout === "page" || tab === shown;
  const { snapshot, id } = useRelease(
    backend,
    { space: release.space, namespace: release.namespace, name: release.name },
    {
      revision: release.revision ?? null,
      parts: {
        overview: true,
        values: wanted("values"),
        manifest: wanted("manifest"),
        history: wanted("history"),
      },
    },
  );
  const { revision, previous, epoch } = snapshot;
  const shown = states.shown(uri, epoch);
  const marks = states.marks(uri, snapshot.life);
  useEffect(
    () => () => {
      states.leave(uri, epoch);
    },
    [states, uri, epoch],
  );
  const request = useMemo(
    () =>
      id &&
      (async ({
        at,
        part,
      }: {
        at: number;
        part: HelmPart;
      }): Promise<{
        action: "revealHelm";
        release: number;
        revision: number;
        part: HelmPart;
      }> => ({
        action: "revealHelm",
        release: await id(),
        revision: at,
        part,
      })),
    [id],
  );
  const reveal = useReveal(request);
  const showOne = async (part: HelmPart): Promise<boolean> => {
    if (revision === undefined || reveal === undefined) return false;
    const answer = await reveal({ at: revision, part });
    if (!answer || latest.current.epoch !== epoch) return false;
    states.reveal(uri, epoch, { part, ...answer });
    return true;
  };
  const show = (part: HelmPart) => {
    void showOne(part);
  };
  /** One request after another, each with the mode's friction, ending at the first the person does not confirm. */
  const showAll = async (parts: readonly HelmPart[]) => {
    for (const part of parts) {
      if (!(await showOne(part))) return;
    }
  };
  const hide = (parts: readonly HelmPart[]) => {
    states.hide(uri, epoch, parts.map(partKey));
  };
  const onGlyph = (glyph: Glyph) => {
    if (glyph.revealed) hide([glyph.part]);
    else show(glyph.part);
  };
  const header = snapshot.overview?.header;
  const { verdict, strip, line } = useHeader({
    gvr: HELM_RELEASES,
    header,
    found: foundTone(snapshot.overview),
    usage: undefined,
  });
  const [element, setElement] = useState<HTMLElement | null>(null);
  const wide = useHeld(useClientWidth(element), FULL_PAGE);
  const [text, setText] = useState<TextState>();
  const notes = shown.get(partKey({ kind: "notes" }));
  const description = shown.get(partKey({ kind: "description" }));
  const notesText = notes?.value ?? snapshot.notes?.text ?? "";
  const descriptionText =
    description?.value ?? snapshot.description?.text ?? "";
  const loaded = snapshot.overview;
  const shownOverview =
    loaded &&
    pageOverview(
      loaded,
      "overview",
      layout === "split",
      notesText,
      descriptionText,
    );
  const filterable = layout !== "page" && tab === "overview";
  const filtered = useFiltered(services.pages, uri) && filterable;
  const under = text?.glyphs.find((each) => each.line === text.line);
  const latest = useRef({ text, under, show, showAll, hide, epoch });
  const subject = JSON.stringify(releaseSubject(release));
  useEffect(() => {
    if (!element) return;
    const scope = keys.scope(element);
    scope.set(OBJECT_SUBJECT, subject);
    scope.set("resource.selected", true);
    scope.set("resource.group", HELM_RELEASES.group);
    scope.set("resource.kind", "HelmRelease");
    scope.set("resource.namespaced", true);
    scope.set(HELM_TAB, view);
    scope.set(HELM_NO_COMMAND, !printsCommand(view));
    scope.set(HELM_REVISION, revision === undefined ? "" : String(revision));
    scope.set(HELM_PREVIOUS, previous === undefined ? "" : String(previous));
    scope.set("helm.page", uri);
    scope.set("helm.canReveal", under !== undefined && !under.revealed);
    scope.set("helm.canHide", under?.revealed === true);
    scope.set("helm.canRevealAll", (text?.reveal.length ?? 0) > 0);
    scope.set("helm.canHideAll", (text?.revealed.length ?? 0) > 0);
    scope.set("helm.marked", marks.size > 0);
    scope.set("pageFocus", filterable);
    scope.set(OBJECT_URI, filterable ? uri : undefined);
    scope.set(OBJECT_FILTERED, filtered);
    return () => {
      scope.dispose();
    };
  }, [
    keys,
    element,
    subject,
    view,
    revision,
    previous,
    uri,
    under,
    text,
    marks,
    filterable,
    filtered,
  ]);
  useEffect(() => {
    latest.current = { text, under, show, showAll, hide, epoch };
  });
  useEffect(
    () =>
      states.register(uri, {
        reveal: () => {
          const { under: at, show: run } = latest.current;
          if (at && !at.revealed) run(at.part);
        },
        hide: () => {
          const { under: at, hide: run } = latest.current;
          if (at?.revealed) run([at.part]);
        },
        revealAll: () => {
          const { text: now, showAll: run } = latest.current;
          if (now) void run(now.reveal);
        },
        hideAll: () => {
          const { text: now, hide: run } = latest.current;
          if (now) run(now.revealed);
        },
      }),
    [states, uri],
  );
  const resources = useResources(services.discovery, release.space);
  const open = (target: ObjectRef) => {
    if (resources.state !== "ready") return;
    const next = refUri(release.space, resources.value, target);
    if (next) workbench.editors.open(next);
  };
  const lookup = keys.lookup(element);
  const body = (view: ReleaseTab) => (
    <Body
      view={view}
      uri={uri}
      release={release}
      snapshot={snapshot}
      shown={shown}
      notes={notesText}
      notesHidden={snapshot.notes?.hidden === true && !notes}
      description={descriptionText}
      descriptionHidden={snapshot.description?.hidden === true && !description}
      revealed={{
        notes: notes !== undefined,
        description: description !== undefined,
      }}
      services={services}
      onGlyph={onGlyph}
      onText={setText}
      onReveal={show}
      onHide={hide}
      onOpen={open}
      onOpenRevision={onOpenRevision}
      markedBar={(marked) => [
        ...(marked.length === 2
          ? workbench.actions("helm/revisions", lookup, {
              space: release.space,
              namespace: release.namespace,
              name: release.name,
              from: Math.min(...marked),
              to: Math.max(...marked),
            })
          : []),
        ...workbench.actions("helm/marked", (key) =>
          key === "helm.marked" ? true : lookup(key),
        ),
      ]}
      revisionMenu={(at, marked) => {
        const names = {
          space: release.space,
          namespace: release.namespace,
          name: release.name,
        };
        if (marked.length === 2 && marked.includes(at)) {
          return workbench.actions("helm/revisions", lookup, {
            ...names,
            from: Math.min(...marked),
            to: Math.max(...marked),
          });
        }
        const previous = (snapshot.history ?? [])
          .map((each) => each.revision)
          .filter((each) => each < at)
          .sort((a, b) => b - a)[0];
        return workbench
          .actions("helm/revision", lookup, {
            ...names,
            revision: at,
            ...(previous !== undefined && { previous }),
            ...(snapshot.latest !== undefined && { latest: snapshot.latest }),
          })
          .map((group) =>
            group.filter(
              ({ id }) =>
                !(
                  id === "helm.revision.compareWithPrevious" &&
                  previous === undefined
                ) &&
                !(
                  id === "helm.revision.compareWithCurrent" &&
                  at === snapshot.latest
                ),
            ),
          );
      }}
      split={layout === "split"}
    />
  );
  const space = spaces.list.find((each) => each.id === release.space);
  const color = space && colors.ofSpace(space);
  const problem = snapshot.problem;
  const exists = snapshot.exists || snapshot.status.state !== "ready";
  return (
    <div
      ref={setElement}
      role="region"
      aria-label={`${KIND} ${release.name}`}
      className="flex h-full min-h-0 flex-col bg-editor"
    >
      <ObjectHeader
        object={uri}
        gvr={HELM_RELEASES}
        kind={KIND}
        name={release.name}
        generated={null}
        controls={controls((command) => {
          void workbench.commands.execute(command, lookup, JSON.parse(subject));
        })}
        {...(wide &&
          space && { space: { name: space.contexts.join(" + "), color } })}
        namespace={release.namespace}
        owner={undefined}
        node={undefined}
        created={header?.created ?? undefined}
        verdict={verdict}
        sentence={header?.sentence ?? []}
        verdictLine={line}
        onOpen={open}
        actions={
          <ActionRow
            label="Release actions"
            actions={workbench.actions(
              "resource/details",
              lookup,
              JSON.parse(subject) as unknown,
            )}
          />
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {layout !== "page" && (
          <ObjectViews
            tab={tab}
            tabs={TABS[layout].map(([id, title]) => ({ id, title }))}
            snapshot={{
              overview: shownOverview,
              events: undefined,
              usage: undefined,
            }}
            onChange={(next) => {
              states.setTab(uri, next);
            }}
            pages={services.pages}
            uri={uri}
            kind={KIND}
          />
        )}
        {(layout === "page" || tab === "overview") && (
          <Vitals cells={strip} verdict={verdict} />
        )}
        <div className="min-h-0 flex-1 overflow-auto [--label-column:112px]">
          {REFUSED.has(snapshot.status.state) ? (
            <ViewStatus
              status={snapshot.status}
              what="the release"
              onRetry={onReopen}
              releases={{ where: release.namespace }}
            />
          ) : !exists ? (
            <EmptyState icon={CircleAlert} title="This release is gone">
              Helm no longer keeps any revision of {release.name} in{" "}
              {release.namespace}.
            </EmptyState>
          ) : problem ? (
            <EmptyState
              icon={CircleAlert}
              title={problemTitle(problem.code, revision)}
            >
              <ErrorMessage error={problem} />
              {snapshot.latest !== undefined &&
                problem.code === "helm.revision-gone" && (
                  <p>
                    <LinkButton
                      onClick={() => {
                        onOpenRevision(snapshot.latest ?? 0);
                      }}
                    >
                      Open revision {snapshot.latest}
                    </LinkButton>
                  </p>
                )}
            </EmptyState>
          ) : layout === "page" ? (
            <Page body={body} snapshot={snapshot} />
          ) : (
            body(tab)
          )}
        </div>
      </div>
    </div>
  );
}

function problemTitle(code: string, revision: number | undefined): string {
  if (code === "helm.revision-gone")
    return `Revision ${String(revision ?? "")} is no longer kept`;
  return "This revision cannot be read";
}

/** The page variant: every part in the order `helm get all` prints, each a section. */
function Page({
  body,
  snapshot,
}: {
  body: (view: ReleaseTab) => ReactNode;
  snapshot: ReleaseSnapshot;
}) {
  const [shut, setShut] = useState<ReadonlySet<ReleaseTab>>(new Set());
  const section = (view: ReleaseTab, title: string) => (
    <Folding
      key={view}
      id={`helm.page.${view}`}
      title={title}
      open={!shut.has(view)}
      onToggle={() => {
        const next = new Set(shut);
        if (!next.delete(view)) next.add(view);
        setShut(next);
      }}
      className="mt-6"
    >
      <div className="h-[480px] max-h-[60vh] min-h-40 overflow-auto">
        {body(view)}
      </div>
    </Folding>
  );
  return (
    <div className="flex flex-col pb-4">
      {body("overview")}
      {section("values", "Values")}
      {section("manifest", "Manifest")}
      {section(
        "history",
        `History${snapshot.history ? ` · ${String(snapshot.history.length)}` : ""}`,
      )}
    </div>
  );
}

function Body({
  view,
  uri,
  release,
  snapshot,
  shown,
  notes,
  notesHidden,
  description,
  descriptionHidden,
  revealed,
  services,
  onGlyph,
  onText,
  onReveal,
  onHide,
  onOpen,
  onOpenRevision,
  revisionMenu,
  markedBar,
  split,
}: {
  onText: (state: TextState | undefined) => void;
  view: ReleaseTab;
  uri: string;
  release: ReleaseInput;
  snapshot: ReleaseSnapshot;
  shown: ReadonlyMap<string, Shown>;
  notes: string;
  notesHidden: boolean;
  description: string;
  descriptionHidden: boolean;
  revealed: { notes: boolean; description: boolean };
  services: ListServices;
  onGlyph: (glyph: Glyph) => void;
  onReveal: (part: HelmPart) => void;
  onHide: (parts: readonly HelmPart[]) => void;
  onOpen: (target: ObjectRef) => void;
  onOpenRevision: (revision: number) => void;
  revisionMenu: (revision: number, marked: readonly number[]) => ActionGroups;
  /** What the bar over marked revisions offers. */
  markedBar: (marked: readonly number[]) => ActionGroups;
  split: boolean;
}) {
  const { releases: states, overviews, pages } = services;
  const overview = snapshot.overview;
  if (view === "values" || view === "manifest") {
    const values = snapshot.values;
    const manifest = snapshot.manifest;
    if (view === "values" && values === undefined) return <Loading />;
    if (view === "manifest" && manifest === undefined) return <Loading />;
  }
  switch (view) {
    case "values":
      return snapshot.values ? (
        <ValuesView
          uri={uri}
          values={snapshot.values}
          shown={shown}
          states={states}
          onGlyph={onGlyph}
          onText={onText}
        />
      ) : null;
    case "manifest":
      return snapshot.manifest ? (
        <ManifestView
          uri={uri}
          manifest={snapshot.manifest}
          shown={shown}
          onGlyph={onGlyph}
          onText={onText}
        />
      ) : null;
    case "history":
      return snapshot.history ? (
        <div className="relative h-full min-h-48">
          <HistoryList
            uri={uri}
            life={snapshot.life}
            lines={snapshot.history}
            latest={snapshot.latest}
            states={states}
            menu={revisionMenu}
            bar={markedBar}
            onOpen={onOpenRevision}
          />
        </div>
      ) : (
        <Loading />
      );
    default:
      break;
  }
  if (overview === undefined) return <Loading />;
  const notesText = (
    <NotesBody
      text={notes}
      hidden={notesHidden}
      revealed={revealed.notes}
      onReveal={() => {
        onReveal({ kind: "notes" });
      }}
      onHide={() => {
        onHide([{ kind: "notes" }]);
      }}
    />
  );
  if (view === "notes") {
    return (
      <div className="p-3.5 text-body">
        {notes === "" ? (
          <p className="text-support">This chart has no notes.</p>
        ) : (
          notesText
        )}
      </div>
    );
  }
  const document = pageOverview(overview, view, split, notes, description);
  const slots = {
    "helm.diagnostics": (
      <RevealControl
        hidden={descriptionHidden}
        revealed={revealed.description}
        what="the description"
        onReveal={() => {
          onReveal({ kind: "description" });
        }}
        onHide={() => {
          onHide([{ kind: "description" }]);
        }}
      />
    ),
    "helm.notes": (
      <RevealControl
        hidden={notesHidden}
        revealed={revealed.notes}
        what="the notes"
        onReveal={() => {
          onReveal({ kind: "notes" });
        }}
        onHide={() => {
          onHide([{ kind: "notes" }]);
        }}
      />
    ),
  };
  return (
    <Overview
      overview={document}
      space={release.space}
      states={overviews}
      kind={`${HELM_RELEASES.group}/${HELM_RELEASES.resource}`}
      object={`${release.namespace}/${release.name}`}
      pages={pages}
      uri={uri}
      onOpen={onOpen}
      onEvents={() => undefined}
      slots={slots}
    />
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/** A text the core scrubbed of the values of the revision's Secrets, with a Reveal of the whole where it took any out. */
function Scrubbed({
  text,
  hidden,
  revealed,
  what,
  onReveal,
  onHide,
}: {
  text: string;
  hidden: boolean;
  revealed: boolean;
  what: string;
  onReveal: () => void;
  onHide: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Prose
        text={text}
        className="text-prose whitespace-pre-line text-content"
      />
      <RevealControl
        hidden={hidden}
        revealed={revealed}
        what={what}
        onReveal={onReveal}
        onHide={onHide}
      />
    </div>
  );
}

/** What a scrubbed text offers: the Reveal of a Secret's key, where a value of the revision's Secrets was taken out, and Hide once it is shown. */
function RevealControl({
  hidden,
  revealed,
  what,
  onReveal,
  onHide,
}: {
  hidden: boolean;
  revealed: boolean;
  what: string;
  onReveal: () => void;
  onHide: () => void;
}) {
  if (!hidden && !revealed) return null;
  return (
    <div className="flex justify-end">
      <RevealButton
        label={what}
        showing={revealed}
        onClick={revealed ? onHide : onReveal}
      />
    </div>
  );
}

function NotesBody(props: {
  text: string;
  hidden: boolean;
  revealed: boolean;
  onReveal: () => void;
  onHide: () => void;
}) {
  return <Scrubbed {...props} what="the notes" />;
}

function ValuesView({
  uri,
  values,
  shown,
  states,
  onGlyph,
  onText,
}: {
  uri: string;
  values: { user: string; defaults: string };
  shown: ReadonlyMap<string, Shown>;
  states: ListServices["releases"];
  onGlyph: (glyph: Glyph) => void;
  onText: (state: TextState | undefined) => void;
}) {
  useChanges(states.changes);
  const plate: Plate = states.plate(uri);
  const defaults = plate === "defaults";
  // @todo: drop this read once the owner has chosen how a masked value looks (mask:token, mask:tree), keeping the choice's branch
  const tree = variants().mask === "tree" && states.form(uri) === "tree";
  const own = useMemo(
    () =>
      new Map(
        [...shown].filter(
          ([, { part }]) =>
            part.kind === "values" && part.defaults === defaults,
        ),
      ),
    [shown, defaults],
  );
  const json = defaults ? values.defaults : values.user;
  const masked = useMemo(() => JSON.parse(json) as unknown, [json]);
  const document = useMemo(() => spliced(masked, own), [masked, own]);
  const text = useMemo(() => yamlOfObject(document), [document]);
  const glyphs = useMemo(
    () => valueGlyphs(text, defaults, own),
    [text, defaults, own],
  );
  const hidden = hiddenCount(text);
  const whole = useMemo<HelmPart>(
    () => ({ kind: "values", defaults, path: [] }),
    [defaults],
  );
  const [line, setLine] = useState(1);
  useEffect(() => {
    onText({
      glyphs,
      line,
      hidden,
      revealed: [...own.values()].map(({ part }) => part),
      reveal: hidden > 0 ? [whole] : [],
    });
    return () => {
      onText(undefined);
    };
  }, [onText, glyphs, line, hidden, own, whole]);
  return (
    <div className="flex h-full min-h-48 flex-col">
      <TabBar
        label="Values of the release"
        tabs={[
          { value: "user" as const, label: "Your values" },
          { value: "defaults" as const, label: "Chart defaults" },
        ]}
        value={plate}
        onChange={(next) => {
          states.setPlate(uri, next);
        }}
        className="w-full shadow-[inset_0_-1px_0_var(--border-subtle)]"
      />
      {variants().mask === "tree" && (
        <TabBar
          label="How the values read"
          tabs={[
            { value: "tree" as const, label: "Tree" },
            { value: "yaml" as const, label: "YAML" },
          ]}
          value={states.form(uri)}
          onChange={(next) => {
            states.setForm(uri, next);
          }}
          className="w-full shadow-[inset_0_-1px_0_var(--border-subtle)]"
        />
      )}
      {masked === null ? (
        <EmptyState icon={CircleAlert} title="No values were set">
          This revision was installed with the chart's defaults.
        </EmptyState>
      ) : (
        <>
          <TextBar
            uri={uri}
            note={hiddenWords(hidden)}
            canReveal={hidden > 0}
            canHide={own.size > 0}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {tree ? (
              <ValuesTree
                document={document}
                defaults={defaults}
                shown={own}
                onGlyph={onGlyph}
              />
            ) : (
              <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
                <MaskedText
                  id={`${uri}/${plate}`}
                  text={text}
                  glyphs={glyphs}
                  onGlyph={onGlyph}
                  onCursor={setLine}
                />
              </Suspense>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ManifestView({
  uri,
  manifest,
  shown,
  onGlyph,
  onText,
}: {
  uri: string;
  manifest: Parameters<typeof manifestOf>[0];
  shown: ReadonlyMap<string, Shown>;
  onGlyph: (glyph: Glyph) => void;
  onText: (state: TextState | undefined) => void;
}) {
  const { text, glyphs } = useMemo(
    () => manifestOf(manifest, shown),
    [manifest, shown],
  );
  const hiding = useMemo(
    () => glyphs.filter(({ revealed }) => !revealed),
    [glyphs],
  );
  const hidden =
    hiddenCount(text) +
    hiding.filter(({ part }) => part.kind === "document").length;
  const revealed = useMemo(
    () =>
      [...shown.values()]
        .map(({ part }) => part)
        .filter(({ kind }) => kind === "secret" || kind === "document"),
    [shown],
  );
  const [line, setLine] = useState(1);
  useEffect(() => {
    onText({
      glyphs,
      line,
      hidden,
      revealed,
      reveal: hiding.map(({ part }) => part),
    });
    return () => {
      onText(undefined);
    };
  }, [onText, glyphs, line, hidden, revealed, hiding]);
  return (
    <div className="flex h-full min-h-48 flex-col">
      <TextBar
        uri={uri}
        note={`${hiddenWords(hidden)} · @ lists the documents`}
        canReveal={hiding.length > 0}
        canHide={revealed.length > 0}
      />
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
          <MaskedText
            id={`${uri}/manifest`}
            text={text}
            glyphs={glyphs}
            onGlyph={onGlyph}
            onCursor={setLine}
            symbols={uri}
          />
        </Suspense>
      </div>
    </div>
  );
}
