import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import type {
  Block,
  Condition,
  DataEntry,
  Field,
  ObjectEvent,
  ObjectRef,
  Overview as Document,
  Value,
} from "@twigo/protocol";
import { cn } from "@twigo/ui";
import { formatBytes, humanDuration } from "@twigo/utils";
import { useNow } from "../useNow";
import { GRID, Properties } from "./Properties";

/** How a link to another object looks. */
export const LINK = "text-brand hover:underline";

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
    <div className="flex flex-col pb-3 text-[13px]">
      {overview.sections.map((section) => {
        const open = !folded.has(section.id);
        return (
          <section
            key={section.id}
            aria-label={section.title}
            className="border-b border-border-subtle last:border-b-0"
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                const next = new Set(folded);
                if (open) next.add(section.id);
                else next.delete(section.id);
                setFolded(next);
              }}
              className="flex h-8 w-full items-center gap-1 px-2 text-left font-semibold"
            >
              {open ? (
                <ChevronDown className="size-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 text-muted-foreground" />
              )}
              {section.title}
            </button>
            {open && (
              <div className="flex flex-col gap-3 px-3 pb-4">
                {section.blocks.map((block, index) => (
                  <BlockView
                    key={index}
                    block={block}
                    onOpen={onOpen}
                    values={values}
                  />
                ))}
              </div>
            )}
          </section>
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
      return <Data entries={block.entries} values={values} />;
    case "tree":
      return <Properties nodes={block.nodes} depth={0} />;
    case "events":
      return <Events events={block.events} />;
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
    <dl className={GRID}>
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0">
            <ValueView value={field.value} onOpen={onOpen} />
          </dd>
        </div>
      ))}
    </dl>
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
      return <span className="break-words">{value.text}</span>;
    case "time":
      return <Time at={value.at} />;
    case "link":
      return (
        <button
          type="button"
          onClick={() => {
            onOpen(value.target);
          }}
          className={cn("text-left break-all", LINK)}
        >
          {value.text}
        </button>
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
      <li className="max-w-full rounded bg-muted px-1.5 py-px text-xs break-all">
        {chip}
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

const TONE_TEXT = {
  neutral: "text-muted-foreground",
  success: "",
  warning: "text-warn",
  danger: "text-error",
} as const;

function Conditions({ conditions }: { conditions: readonly Condition[] }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="w-[30%] pb-1 font-normal">Type</th>
          <th className="w-[14%] pb-1 font-normal">Status</th>
          <th className="pb-1 font-normal">Reason</th>
          <th className="w-[14%] pb-1 text-right font-normal">Since</th>
        </tr>
      </thead>
      <tbody>
        {conditions.map((condition) => (
          <tr key={condition.type} className="align-top">
            <td className="truncate py-0.5 pr-2">{condition.type}</td>
            <td className={cn("py-0.5 pr-2", TONE_TEXT[condition.tone])}>
              {condition.status}
            </td>
            <td className="py-0.5 pr-2 break-words">
              {condition.reason}
              {condition.message && (
                <div className="text-xs text-muted-foreground">
                  {condition.message}
                </div>
              )}
            </td>
            <td className="py-0.5 text-right text-muted-foreground">
              <Age at={condition.lastTransition} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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

function DataRow({
  entry,
  values,
}: {
  entry: DataEntry;
  values: OverviewProps["values"];
}) {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const opens = values !== undefined && !entry.binary;
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
          if (!open && value === undefined)
            void values([entry.key]).then(([read]) => {
              setValue(read ?? null);
            });
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
      {open && (
        <pre className="mb-1 ml-4.5 max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {value ?? ""}
        </pre>
      )}
    </li>
  );
}

export function Events({ events }: { events: readonly ObjectEvent[] }) {
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
                warning ? "text-warn" : "invisible",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={cn("font-medium", warning && "text-warn")}>
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
