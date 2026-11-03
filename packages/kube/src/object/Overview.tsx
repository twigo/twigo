import { useEffect, useState, type ReactNode } from "react";
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
  Value,
} from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { Chip, cn, LinkButton, PropertyList, Section } from "@twigo/ui";
import { formatBytes, humanDuration } from "@twigo/utils";
import { useNow } from "../useNow";
import { Properties } from "./Properties";

export interface OverviewProps {
  readonly overview: Document;
  /** Opens the object a link points at. */
  readonly onOpen: (target: ObjectRef) => void;
  /** The values of a ConfigMap's keys, null for a binary one. */
  readonly values?: (keys: readonly string[]) => Promise<(string | null)[]>;
}

/**
 * An object described in Rust (ARCHITECTURE 4.3): its sections in order,
 * each folding by its id, each block drawn by its type.
 */
export function Overview({ overview, onOpen, values }: OverviewProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="flex flex-col gap-4 px-3.5 pt-3 pb-4 text-[13px]">
      {overview.sections.map((section) => {
        const open = !folded.has(section.id);
        return (
          <Section
            key={section.id}
            title={section.title}
            open={open}
            onToggle={() => {
              const next = new Set(folded);
              if (open) next.add(section.id);
              else next.delete(section.id);
              setFolded(next);
            }}
          >
            <div className="flex flex-col gap-3">
              {section.blocks.map((block, index) => (
                <BlockView
                  key={index}
                  block={block}
                  onOpen={onOpen}
                  values={values}
                />
              ))}
            </div>
          </Section>
        );
      })}
    </div>
  );
}

function BlockView({
  block,
  onOpen,
  values,
}: {
  block: Block;
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

function ValueView({
  value,
  onOpen,
}: {
  value: Value;
  onOpen: (target: ObjectRef) => void;
}): ReactNode {
  switch (value.type) {
    case "text":
      return (
        <span className="break-words whitespace-pre-wrap">{value.text}</span>
      );
    case "time":
      return <Time at={value.at} />;
    case "link":
      return (
        <LinkButton
          onClick={() => {
            onOpen(value.target);
          }}
          className="break-all"
        >
          {value.text}
        </LinkButton>
      );
    case "labels":
      return (
        <ul className="flex flex-wrap gap-1">
          {value.labels.map((label) => (
            <LabelChip key={label.key} name={label.key} value={label.value} />
          ))}
        </ul>
      );
    case "list":
      return (
        <ul className="flex flex-col">
          {value.items.map((item, index) => (
            <li key={index}>
              <ValueView value={item} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      );
  }
}

/** Long and multiline values fold to one line and open whole on a click. */
function LabelChip({ name, value }: { name: string; value: string }) {
  const long = value.length > 60 || value.includes("\n");
  const [open, setOpen] = useState(false);
  const chip = (
    <>
      <span className="text-muted-foreground">{name}</span>
      {value !== "" && <span>={value}</span>}
    </>
  );
  if (!long)
    return (
      <li className="max-w-full">
        <Chip>{chip}</Chip>
      </li>
    );
  return (
    <li className="max-w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className={cn(
          "max-w-full rounded bg-muted px-1.5 py-px text-left text-xs",
          open ? "break-all whitespace-pre-wrap" : "block truncate",
        )}
      >
        {chip}
      </button>
    </li>
  );
}

function Time({ at }: { at: string }) {
  const now = useNow(1000);
  const when = Date.parse(at);
  if (Number.isNaN(when)) return <span>{at}</span>;
  const date = new Date(when).toLocaleString();
  return (
    <span title={date}>
      {humanDuration(Math.max(0, now - when))} ago
      <span className="ml-2 text-muted-foreground">{date}</span>
    </span>
  );
}

function Age({ at }: { at: string | null }) {
  const now = useNow(1000);
  const when = at === null ? Number.NaN : Date.parse(at);
  if (Number.isNaN(when)) return null;
  return (
    <span title={new Date(when).toLocaleString()} className="tabular-nums">
      {humanDuration(Math.max(0, now - when))}
    </span>
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
