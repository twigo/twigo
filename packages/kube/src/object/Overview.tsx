import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Minus,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  Block,
  Condition,
  DataEntry,
  EventList,
  IpcError,
  ObjectEvent,
  ObjectRef,
  Overview as Document,
  Section,
  ShownUsage,
} from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { cn, LinkButton, Section as Folding, Table } from "@twigo/ui";
import { ErrorMessage, useChanges } from "@twigo/workbench";
import { formatBytes } from "@twigo/utils";
import { Containers } from "./Containers";
import { DefaultsLink, Fields } from "./defaults";
import { Diagnostics, type FindingLogsChoice } from "./Diagnostics";
import { EmbeddedList } from "./EmbeddedList";
import { Properties } from "./Properties";
import { usePropertyColumns } from "./propertyColumns";
import type { OverviewStates } from "./overviewStates";
import {
  compile,
  defaultsId,
  keeps,
  viewOf,
  type SectionView,
} from "./pageFilter";
import { outlineOf, type Outline } from "./outline";
import type { GroupFolds, PageStates } from "./pageStates";
import type { Reveal } from "./reveal";
import { RevealButton } from "./RevealButton";
import { numericColumns } from "./numeric";
import { unexplained } from "./conditions";
import { UsageView } from "./Usage";
import { Age, Prose, Sentence, ValueView } from "./values";

export interface OverviewProps {
  readonly overview: Document;
  /** The space the object is in, which its live lists query. */
  readonly space: string;
  /** What the person chose in the Overviews of the object's kind. */
  readonly states: OverviewStates;
  /** The object's resource, `apps/deployments`, which keys `states`. */
  readonly kind: string;
  /** The object shown, as `namespace/name`: a finding the person folded stays folded in it, in its space, only. */
  readonly object: string;
  /** What the editor at `uri` shows of the page beyond its object: its filter. */
  readonly pages: PageStates;
  readonly uri: string;
  /** Opens the object a link points at. */
  readonly onOpen: (target: ObjectRef) => void;
  /** The values of a ConfigMap's keys, null for a binary one. */
  readonly values?: (keys: readonly string[]) => Promise<(string | null)[]>;
  /** Reveals a Secret's value, as its data's keys offer it. */
  readonly reveal?: Reveal | undefined;
  /** Opens a container's logs from a finding about it. */
  readonly onLogs?: ((choice: FindingLogsChoice) => void) | undefined;
  /** Shows the object's Events view, which keeps every event where the section lists the newest. */
  readonly onEvents: () => void;
  /** What the object uses, once it has come: a node's section follows the Diagnostics, a pod's containers draw their own. */
  readonly usage?: ShownUsage | undefined;
  /** The full page, which opens every section but the Metadata. */
  readonly fullPage?: boolean;
  /** What a section holds after its blocks, by its id: what only the webview has, such as a release's notes. */
  readonly slots?: Readonly<Record<string, ReactNode>> | undefined;
}

/**
 * An object described in Rust (ARCHITECTURE 4.3): its sections in order,
 * each opening as its fold says until the person folds or opens it for the
 * kind, and each block drawn by its type. A section's fields that hold the
 * cluster's default hide behind a link at its end. While the page's filter
 * holds text, the sections with a match open and the others hide. While the
 * object is shown, a finding that comes or goes is announced by its title,
 * which, unlike its times, does not tick.
 */
export function Overview({
  overview,
  space,
  states,
  kind,
  object,
  pages,
  uri,
  onOpen,
  values,
  reveal,
  onLogs,
  onEvents,
  usage,
  fullPage = false,
  slots,
}: OverviewProps) {
  useChanges(states.changes);
  useChanges(pages.changes);
  const text = pages.text(uri);
  const { filter } = useMemo(() => compile(text), [text]);
  const shut = pages.shut(uri);
  const root = useRef<HTMLDivElement>(null);
  const goToMatch = pages.wantsMatch(uri);
  useEffect(() => {
    if (!goToMatch) return;
    root.current
      ?.querySelector<HTMLElement>("[data-section] button[aria-expanded]")
      ?.focus();
    pages.matched(uri);
  }, [goToMatch, pages, uri]);
  const titles = overview.sections.flatMap((section) =>
    section.blocks.flatMap((block) =>
      block.type === "diagnostics"
        ? block.findings.map((finding) => finding.title)
        : [],
    ),
  );
  const parts: Part[] = outlineOf(
    overview,
    usage !== undefined && kind === "/nodes",
    fullPage,
  ).map((entry) => {
    const section = overview.sections.find(({ id }) => id === entry.id);
    const revealed = states.open(kind, defaultsId(entry.id), false);
    return {
      ...entry,
      revealed,
      view: section && viewOf(section, filter, revealed),
    };
  });
  const shown = filter
    ? parts.filter((part) => keeps(filter, part.view, part.title))
    : parts;
  const identity = `${space}/${object}`;
  const isOpen = ({ id, fold }: Part) =>
    filter ? !shut.has(id) : states.section(kind, identity, id, fold);
  const toggle = (part: Part, all: boolean) => {
    const targets = all ? shown : [part];
    if (filter)
      pages.setShut(
        uri,
        targets.map(({ id }) => id),
        isOpen(part),
      );
    else if (all) states.setSections(kind, identity, shown, !isOpen(part));
    else states.setSection(kind, identity, part, !isOpen(part));
  };
  const groupsOf = (part: Part, { narrowed }: SectionView): GroupFolds => ({
    open: (id, normally) =>
      pages.group(uri, `${part.id}/${id}`) ?? (narrowed.has(id) || normally),
    set: (id, open) => {
      pages.setGroup(uri, `${part.id}/${id}`, open);
    },
    narrowed: (id) => narrowed.has(id),
  });
  const opens = shown.map(isOpen);
  const rendered = shown.map((part, index) => {
    const open = opens[index] === true;
    const { view } = part;
    const groups =
      view === undefined || filter === null ? undefined : groupsOf(part, view);
    const spacing =
      index === 0
        ? undefined
        : !open && opens[index - 1] === false
          ? "mt-1"
          : "mt-6";
    return (
      <Folding
        key={part.id}
        id={part.id}
        title={part.title}
        summary={part.summary.length > 0 && <Sentence spans={part.summary} />}
        tone={part.tone}
        open={open}
        onToggle={(all) => {
          toggle(part, all);
        }}
        className={spacing}
      >
        {view === undefined ? (
          usage && <UsageView usage={usage} />
        ) : (
          <div className="flex flex-col gap-3">
            {view.blocks.map((block, at) => (
              <BlockView
                key={at}
                section={part}
                block={block}
                groups={groups}
                whole={view.whole}
                space={space}
                states={states}
                kind={kind}
                onOpen={onOpen}
                values={values}
                reveal={reveal}
                onLogs={onLogs}
                onEvents={onEvents}
                usage={usage}
              />
            ))}
            {view.folds && (
              <DefaultsLink
                count={view.defaults}
                revealed={part.revealed}
                onToggle={() => {
                  states.toggle(kind, defaultsId(part.id));
                }}
              />
            )}
            {slots?.[part.id]}
          </div>
        )}
      </Folding>
    );
  });
  return (
    <div ref={root} className="flex flex-col py-4 text-body">
      <Announcer titles={titles} />
      {rendered}
      {filter && shown.length === 0 && (
        <p className="px-3.5 text-support">Nothing here matches “{text}”</p>
      )}
    </div>
  );
}

/** A section as the Overview draws it: what its header says, and, but for the usage section, what its blocks leave of it. */
interface Part extends Outline {
  readonly revealed: boolean;
  readonly view: SectionView | undefined;
}

/**
 * What changed among the findings, said once: the titles that came, and
 * those that went as resolved. A live region reads text that changes, not
 * text that leaves, so it is told the change rather than the list. The
 * findings of the first document are on screen and not said; those that
 * read the object's events come a moment later, once the events are
 * listed, and are said as they come.
 */
function Announcer({ titles }: { titles: readonly string[] }) {
  const key = titles.join("\n");
  const [seen, setSeen] = useState({ key, said: "" });
  if (seen.key !== key) {
    const before = new Set(seen.key === "" ? [] : seen.key.split("\n"));
    const now = new Set(titles);
    const came = titles.filter((title) => !before.has(title));
    const went = [...before].filter((title) => !now.has(title));
    setSeen({
      key,
      said: [...came, ...went.map((title) => `Resolved: ${title}`)].join(". "),
    });
  }
  return (
    <p className="sr-only" aria-live="polite">
      {seen.said}
    </p>
  );
}

function BlockView({
  section,
  block,
  groups,
  whole,
  space,
  states,
  kind,
  onOpen,
  values,
  reveal,
  onLogs,
  onEvents,
  usage,
}: {
  /** Whose title names a table and whose id keys a list's state. */
  section: Pick<Section, "id" | "title">;
  block: Block;
  groups: GroupFolds | undefined;
  whole: boolean;
  space: string;
  states: OverviewStates;
  kind: string;
  onOpen: (target: ObjectRef) => void;
  values: OverviewProps["values"];
  reveal: OverviewProps["reveal"];
  onLogs: OverviewProps["onLogs"];
  onEvents: OverviewProps["onEvents"];
  usage: OverviewProps["usage"];
}) {
  const columns = usePropertyColumns();
  switch (block.type) {
    case "fields":
      return <Fields fields={block.fields} onOpen={onOpen} columns={columns} />;
    case "conditions":
      return <Conditions conditions={block.conditions} />;
    case "data":
      return (
        <Data
          entries={block.entries}
          values={block.readable ? values : undefined}
          reveal={block.readable ? undefined : reveal}
        />
      );
    case "tree":
      return <Properties nodes={block.nodes} depth={0} groups={groups} />;
    case "events":
      return <NewestEvents list={block} onAll={onEvents} whole={whole} />;
    case "diagnostics":
      return <Diagnostics findings={block.findings} onLogs={onLogs} />;
    case "containers":
      return (
        <Containers
          containers={block.containers}
          states={states}
          kind={kind}
          usage={usage}
          onOpen={onOpen}
          groups={groups}
        />
      );
    case "table":
      return (
        <Table
          label={section.title}
          columns={block.columns}
          numeric={numericColumns(block.columns, block.rows)}
          rows={block.rows.map((row) =>
            row.map((value, index) => (
              <ValueView key={index} value={value} onOpen={onOpen} compact />
            )),
          )}
        />
      );
    case "list":
      return (
        <EmbeddedList
          list={block}
          space={space}
          states={states}
          kind={kind}
          id={section.id}
          onOpen={onOpen}
        />
      );
  }
}

const CONDITION: Readonly<
  Record<Condition["tone"], { icon: LucideIcon; className: string }>
> = {
  success: { icon: Check, className: "text-ok" },
  danger: { icon: X, className: "text-error" },
  warning: { icon: TriangleAlert, className: "text-warn-foreground" },
  neutral: { icon: Minus, className: "text-support" },
};

/**
 * Conditions as chips that read at a glance (ARCHITECTURE 4.3): a mark in
 * the condition's tone, its type and its age, with its status, reason and
 * message in the chip's tooltip; what is wrong and not yet said by the
 * Diagnostics says why below them, once for conditions that say the same.
 */
function Conditions({ conditions }: { conditions: readonly Condition[] }) {
  const said = unexplained(conditions);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-1.5">
        {conditions.map((condition) => {
          const { icon: Icon, className } = CONDITION[condition.tone];
          return (
            <li
              key={condition.type}
              title={[
                `${condition.type}: ${condition.status}`,
                condition.reason,
                condition.message,
                condition.lastHeartbeat &&
                  `Last heartbeat ${new Date(condition.lastHeartbeat).toLocaleString()}`,
              ]
                .filter(Boolean)
                .join("\n")}
              className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs shadow-[inset_0_0_0_1px_var(--border)]"
            >
              <Icon
                aria-label={condition.status}
                className={cn("size-3", className)}
              />
              {condition.type}
              <Age at={condition.lastTransition} />
            </li>
          );
        })}
      </ul>
      {said.map(({ types, reason, message }) => (
        <div key={types.join(",")} className="flex flex-col">
          <p className="break-words">
            <span className="font-semibold">{types.join(", ")}</span>
            {reason && <span className="text-support"> · {reason}</span>}
          </p>
          {message && (
            <Prose text={message} className="text-prose text-content" />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Keys with their sizes; a ConfigMap's value comes when its key opens, and
 * a Secret's on a Reveal.
 */
function Data({
  entries,
  values,
  reveal,
}: {
  entries: readonly DataEntry[];
  values: OverviewProps["values"];
  reveal: OverviewProps["reveal"];
}) {
  if (entries.length === 0) return <p className="text-support">No data</p>;
  return (
    <ul className="flex flex-col">
      {entries.map((entry) =>
        reveal ? (
          <SecretRow key={entry.key} entry={entry} reveal={reveal} />
        ) : (
          <DataRow key={entry.key} entry={entry} values={values} />
        ),
      )}
    </ul>
  );
}

/**
 * What a Reveal gave, which leaves the webview as the row hides it or goes,
 * and holds only for the object whose `reveal` gave it.
 */
type Shown =
  | { readonly state: "hidden" }
  | { readonly state: "revealing"; readonly by: Reveal }
  | {
      readonly state: "shown";
      readonly by: Reveal;
      readonly value: string;
      readonly binary: boolean;
    };

/**
 * A Secret's key, whose value stays in Rust until a Reveal (ARCHITECTURE
 * 3.6), and stays shown only until Hide or the row goes.
 */
function SecretRow({ entry, reveal }: { entry: DataEntry; reveal: Reveal }) {
  const [shown, setShown] = useState<Shown>({ state: "hidden" });
  // A row that now shows another object's key drops the last one's value,
  // rather than only hiding it.
  if (shown.state !== "hidden" && shown.by !== reveal) {
    setShown({ state: "hidden" });
  }
  const showing = shown.state === "shown" && shown.by === reveal;
  return (
    <li className="flex flex-col">
      <div className="flex h-6 items-center gap-2">
        <span className="truncate font-mono text-xs">{entry.key}</span>
        <span className="ml-auto shrink-0 text-xs text-support tabular-nums">
          {entry.binary && "binary, "}
          {formatBytes(entry.bytes)}
        </span>
        <RevealButton
          label={entry.key}
          showing={showing}
          loading={shown.state === "revealing" && shown.by === reveal}
          onClick={() => {
            if (showing) {
              setShown({ state: "hidden" });
              return;
            }
            setShown({ state: "revealing", by: reveal });
            void reveal(entry.key).then((revealed) => {
              // An answer for an object the row no longer shows is dropped.
              setShown((current) =>
                current.state !== "revealing" || current.by !== reveal
                  ? current
                  : revealed
                    ? { state: "shown", by: reveal, ...revealed }
                    : { state: "hidden" },
              );
            });
          }}
        />
      </div>
      {showing && (
        <pre className="mb-1 ml-0 max-h-80 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">
          {shown.value}
          {shown.binary && (
            <span className="mt-1 block font-sans text-support">base64</span>
          )}
        </pre>
      )}
    </li>
  );
}

/** What a key's value read gave, the last read standing while the next runs. */
type Read =
  | { readonly state: "reading" }
  | { readonly state: "read"; readonly text: string | null }
  | { readonly state: "failed"; readonly error: IpcError };

function DataRow({
  entry,
  values,
}: {
  entry: DataEntry;
  values: OverviewProps["values"];
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read>({ state: "reading" });
  const opens = values !== undefined && !entry.binary;
  useEffect(() => {
    if (!open || !values) return;
    let current = true;
    values([entry.key]).then(
      ([text]) => {
        if (current) setRead({ state: "read", text: text ?? null });
      },
      (error: unknown) => {
        if (current) setRead({ state: "failed", error: toIpcError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [open, values, entry]);
  const size = (
    <span className="ml-auto shrink-0 text-xs text-support tabular-nums">
      {entry.binary && "binary, "}
      {formatBytes(entry.bytes)}
    </span>
  );
  if (!opens)
    return (
      <li className="flex h-6 items-center gap-2">
        <span className="truncate font-mono text-xs">{entry.key}</span>
        {size}
      </li>
    );
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex h-6 items-center gap-1 text-left hover:text-content"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-support" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-support" />
        )}
        <span className="truncate font-mono text-xs">{entry.key}</span>
        {size}
      </button>
      {open &&
        (read.state === "failed" ? (
          <p className="mb-1 ml-4.5 text-xs text-error">
            <ErrorMessage error={read.error} />
          </p>
        ) : (
          <pre className="mb-1 ml-4.5 max-h-80 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {read.state === "read" ? read.text : ""}
          </pre>
        ))}
    </li>
  );
}

const NEWEST = 3;

/**
 * The newest events of an object, its warnings first, and a link to the Events
 * view, which keeps the whole list, where there are more. Where the page's
 * filter keeps the section by its rows, it draws every event the filter keeps,
 * since the filter shows what a fold hides, and the link goes: its count would
 * be the filter's.
 */
function NewestEvents({
  list,
  onAll,
  whole,
}: {
  list: EventList;
  onAll: () => void;
  whole: boolean;
}) {
  const { events } = list;
  const warned = (event: ObjectEvent) => event.type === "Warning";
  const ordered = [
    ...events.filter(warned),
    ...events.filter((event) => !warned(event)),
  ];
  const shown = whole ? ordered.slice(0, NEWEST) : ordered;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Events list={{ ...list, events: shown }} />
      {whole && events.length > shown.length && (
        <LinkButton onClick={onAll}>All {events.length} events</LinkButton>
      )}
    </div>
  );
}

/** An object's events, newest first, or why they cannot be listed. */
export function Events({ list }: { list: EventList }) {
  const { events, unavailable } = list;
  if (unavailable !== null) {
    return (
      <p className="text-error">
        <ErrorMessage error={unavailable} />
      </p>
    );
  }
  if (events.length === 0) return <p className="text-support">No events</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {events.map((event, index) => {
        const warning = event.type === "Warning";
        return (
          <li key={index} className="flex gap-2">
            <TriangleAlert
              aria-label={warning ? "Warning" : undefined}
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                warning ? "text-warn-foreground" : "invisible",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "font-medium",
                    warning && "text-warn-foreground",
                  )}
                >
                  {event.reason}
                </span>
                {event.count > 1 && (
                  <span className="text-xs text-support">×{event.count}</span>
                )}
                <span className="ml-auto shrink-0 text-xs">
                  <Age at={event.last} />
                </span>
              </div>
              <Prose text={event.message} className="text-prose text-content" />
              <p className="text-xs text-support">
                {event.source}
                {event.fieldPath && ` · ${event.fieldPath}`}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
