import { useState, type ReactNode } from "react";
import type { ObjectRef, Span, Value } from "@twigo/protocol";
import { Chip, cn, LinkButton, TonedText } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { useNow } from "../useNow";
import { TONE } from "./tone";

/** A value of the Overview document, a link opening its object. */
export function ValueView({
  value,
  onOpen,
  compact = false,
}: {
  value: Value;
  onOpen: (target: ObjectRef) => void;
  /** In a table cell: a time as its age alone, its date in its tooltip. */
  compact?: boolean;
}): ReactNode {
  switch (value.type) {
    case "text":
      return compact ? (
        <span>{value.text}</span>
      ) : (
        <span className="break-words whitespace-pre-wrap">{value.text}</span>
      );
    case "code":
      return (
        <code
          className={cn(
            "font-mono text-xs",
            !compact && "break-all whitespace-pre-wrap",
          )}
        >
          {value.text}
        </code>
      );
    case "toned":
      return <TonedText tone={TONE[value.tone]}>{value.text}</TonedText>;
    case "time":
      return compact ? (
        <Age at={value.at} suffix=" ago" />
      ) : (
        <Time at={value.at} />
      );
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
              <ValueView value={item} onOpen={onOpen} compact={compact} />
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
  const now = useNow();
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

/** How long ago, ticking: `12m`. */
export function Age({
  at,
  suffix = "",
}: {
  at: string | null;
  /** After the age: ` ago`. */
  suffix?: string;
}) {
  const now = useNow();
  const when = at === null ? Number.NaN : Date.parse(at);
  if (Number.isNaN(when)) return null;
  return (
    <span title={new Date(when).toLocaleString()} className="tabular-nums">
      {humanDuration(Math.max(0, now - when))}
      {suffix}
    </span>
  );
}

/** A sentence of text and times, the times read as it shows. */
export function Sentence({ spans }: { spans: readonly Span[] }) {
  const now = useNow();
  return (
    <>
      {spans.map((span, index) => {
        switch (span.type) {
          case "text":
            return <span key={index}>{span.text}</span>;
          case "ago": {
            const when = Date.parse(span.at);
            return (
              <span key={index} title={new Date(when).toLocaleString()}>
                {humanDuration(Math.max(0, now - when))} ago
              </span>
            );
          }
          case "until": {
            const when = Date.parse(span.at);
            return (
              <span
                key={index}
                title={new Date(when).toLocaleString()}
                className="tabular-nums"
              >
                {when > now ? `in ${humanDuration(when - now)}` : "now"}
              </span>
            );
          }
        }
      })}
    </>
  );
}
