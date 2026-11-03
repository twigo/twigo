import { useEffect, useState } from "react";
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
  Field,
  ObjectRef,
  Overview as Document,
  Section,
} from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { cn, PropertyList, Section as Folding, Table } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import { formatBytes } from "@twigo/utils";
import { Containers } from "./Containers";
import { Diagnostics } from "./Diagnostics";
import { EmbeddedList } from "./EmbeddedList";
import { Properties } from "./Properties";
import type { OverviewStates } from "./overviewStates";
import { Age, ValueView } from "./values";

export interface OverviewProps {
  readonly overview: Document;
  /** The space the object is in, which its live lists query. */
  readonly space: string;
  /** What the person chose in the Overviews of the object's kind. */
  readonly states: OverviewStates;
  /** The object's resource, `apps/deployments`, which keys `states`. */
  readonly kind: string;
  /** Opens the object a link points at. */
  readonly onOpen: (target: ObjectRef) => void;
  /** The values of a ConfigMap's keys, null for a binary one. */
  readonly values?: (keys: readonly string[]) => Promise<(string | null)[]>;
}

/**
 * An object described in Rust (ARCHITECTURE 4.3): its sections in order,
 * each folding by its id as the kind's other objects do, each block drawn
 * by its type. While the object is shown, a finding that comes or goes is
 * announced by its title, which, unlike its times, does not tick.
 */
export function Overview({
  overview,
  space,
  states,
  kind,
  onOpen,
  values,
}: OverviewProps) {
  useChanges(states.changes);
  const titles = overview.sections.flatMap((section) =>
    section.blocks.flatMap((block) =>
      block.type === "diagnostics"
        ? block.findings.map((finding) => finding.title)
        : [],
    ),
  );
  return (
    <div className="flex flex-col gap-4 px-3.5 pt-3 pb-4 text-[13px]">
      <Announcer titles={titles} />
      {overview.sections.map((section) => {
        const open = states.open(kind, section.id, true);
        return (
          <Folding
            key={section.id}
            title={section.title}
            open={open}
            onToggle={() => {
              states.toggle(kind, section.id);
            }}
          >
            <div className="flex flex-col gap-3">
              {section.blocks.map((block, index) => (
                <BlockView
                  key={index}
                  section={section}
                  block={block}
                  space={space}
                  states={states}
                  kind={kind}
                  onOpen={onOpen}
                  values={values}
                />
              ))}
            </div>
          </Folding>
        );
      })}
    </div>
  );
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
  space,
  states,
  kind,
  onOpen,
  values,
}: {
  /** Whose title names a table and whose id keys a list's state. */
  section: Section;
  block: Block;
  space: string;
  states: OverviewStates;
  kind: string;
  onOpen: (target: ObjectRef) => void;
  values: OverviewProps["values"];
}) {
  switch (block.type) {
    case "fields":
      return <Fields fields={block.fields} onOpen={onOpen} />;
    case "conditions":
      return <Conditions conditions={block.conditions} />;
    case "data":
      return (
        <Data
          entries={block.entries}
          values={block.readable ? values : undefined}
        />
      );
    case "tree":
      return <Properties nodes={block.nodes} depth={0} />;
    case "events":
      return <Events list={block} />;
    case "diagnostics":
      return <Diagnostics findings={block.findings} />;
    case "containers":
      return (
        <Containers
          containers={block.containers}
          states={states}
          kind={kind}
          onOpen={onOpen}
        />
      );
    case "table":
      return (
        <Table
          label={section.title}
          columns={block.columns}
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

function Fields({
  fields,
  onOpen,
}: {
  fields: readonly Field[];
  onOpen: (target: ObjectRef) => void;
}) {
  return (
    <PropertyList
      items={fields.map((field) => ({
        key: field.label,
        label: field.label,
        value: <ValueView value={field.value} onOpen={onOpen} />,
      }))}
    />
  );
}

const CONDITION: Readonly<
  Record<Condition["tone"], { icon: LucideIcon; className: string }>
> = {
  success: { icon: Check, className: "text-ok" },
  danger: { icon: X, className: "text-error" },
  warning: { icon: TriangleAlert, className: "text-warn-foreground" },
  neutral: { icon: Minus, className: "text-muted-foreground" },
};

/**
 * Conditions as chips that read at a glance (ARCHITECTURE 4.3): a mark in
 * the condition's tone, its type and its age, with its status, reason and
 * message in the chip's tooltip; what is wrong says why below them.
 */
function Conditions({ conditions }: { conditions: readonly Condition[] }) {
  const wrong = conditions.filter(
    (condition) =>
      (condition.tone === "danger" || condition.tone === "warning") &&
      (condition.message ?? condition.reason) !== null,
  );
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
              <span className="text-muted-foreground-2">
                <Age at={condition.lastTransition} />
              </span>
            </li>
          );
        })}
      </ul>
      {wrong.map((condition) => (
        <p key={condition.type} className="break-words">
          <span className="font-semibold">{condition.type}</span>
          {condition.reason && (
            <span className="text-muted-foreground"> · {condition.reason}</span>
          )}
          {condition.message && (
            <span className="block text-muted-foreground">
              {condition.message}
            </span>
          )}
        </p>
      ))}
    </div>
  );
}

/** Keys with their sizes; a ConfigMap's value comes when its key opens. */
function Data({
  entries,
  values,
}: {
  entries: readonly DataEntry[];
  values: OverviewProps["values"];
}) {
  if (entries.length === 0)
    return <p className="text-muted-foreground">No data</p>;
  return (
    <ul className="flex flex-col">
      {entries.map((entry) => (
        <DataRow key={entry.key} entry={entry} values={values} />
      ))}
    </ul>
  );
}

/** What a key's value read gave, the last read standing while the next runs. */
type Read =
  | { readonly state: "reading" }
  | { readonly state: "read"; readonly text: string | null }
  | { readonly state: "failed"; readonly message: string };

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
        if (current)
          setRead({ state: "failed", message: toIpcError(error).message });
      },
    );
    return () => {
      current = false;
    };
  }, [open, values, entry]);
  const size = (
    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
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
        className="flex h-6 items-center gap-1 text-left hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-mono text-xs">{entry.key}</span>
        {size}
      </button>
      {open &&
        (read.state === "failed" ? (
          <p className="mb-1 ml-4.5 text-xs text-error">{read.message}</p>
        ) : (
          <pre className="mb-1 ml-4.5 max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {read.state === "read" ? read.text : ""}
          </pre>
        ))}
    </li>
  );
}

/** An object's events, newest first, or why they cannot be listed. */
export function Events({ list }: { list: EventList }) {
  const { events, unavailable } = list;
  if (unavailable !== null) return <p className="text-error">{unavailable}</p>;
  if (events.length === 0)
    return <p className="text-muted-foreground">No events</p>;
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
                  <span className="text-xs text-muted-foreground">
                    ×{event.count}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  <Age at={event.last} />
                </span>
              </div>
              <p className="break-words">{event.message}</p>
              <p className="text-xs text-muted-foreground">
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
