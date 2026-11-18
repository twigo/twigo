import { useState, type ReactNode } from "react";
import type { Label, ObjectRef, Span, Value } from "@twigo/protocol";
import { cn, CutInTheMiddle, LinkButton, TonedText } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { ageRole } from "../age";
import { useNow } from "../useNow";
import { splitImage } from "./image";
import { LABELS_SHOWN, splitKey, valueFold } from "./labels";
import { lineCount } from "./lines";
import { isEmpty } from "./stacking";
import { TONE } from "./tone";

const NAME_FLOOR = 24;

const PROSE_LINES = 3;

/** A wrapped line starts under the first line's text, so that a long item does not read as two. */
const HANGING = "pl-3 -indent-3";

function Empty() {
  return <span className="text-quiet">–</span>;
}

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
  if (isEmpty(value)) return <Empty />;
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
          title={value.text}
          className="ident block max-w-full"
        >
          <CutInTheMiddle text={value.text} floor={NAME_FLOOR} separator="-" />
        </LinkButton>
      );
    case "labels":
      return <Labels labels={value.labels} />;
    case "list":
      return (
        <ul className="flex flex-col gap-1">
          {value.items.map((item, index) => (
            <li
              key={index}
              className={item.type === "link" ? undefined : HANGING}
            >
              <ValueView value={item} onOpen={onOpen} compact={compact} />
            </li>
          ))}
        </ul>
      );
  }
}

function Labels({ labels }: { labels: readonly Label[] }) {
  const [all, setAll] = useState(false);
  return (
    <div className="flex flex-col items-start gap-1">
      <ul className="flex w-full flex-col gap-1">
        {(all ? labels : labels.slice(0, LABELS_SHOWN)).map((label) => (
          <LabelLine key={label.key} label={label} />
        ))}
      </ul>
      {labels.length > LABELS_SHOWN && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
          className="rounded-sm text-xs text-support outline-none hover:text-content focus-visible:shadow-[var(--focus-ring)]"
        >
          {all ? "Show fewer" : `Show all ${String(labels.length)}`}
        </button>
      )}
    </div>
  );
}

function LabelLine({ label: { key, value } }: { label: Label }) {
  const fold = valueFold(key, value);
  const [open, setOpen] = useState(false);
  const { prefix, name } = splitKey(key);
  const text = (
    <>
      <span className="text-quiet">{prefix}</span>
      <span>{name}</span>
      {value !== "" && <span className="text-quiet">=</span>}
      {fold === "hidden" && !open ? (
        <span className="text-quiet">…</span>
      ) : (
        value
      )}
    </>
  );
  const line = "ident block text-xs break-all";
  if (fold === "whole")
    return <li className={cn(line, HANGING, "whitespace-pre-wrap")}>{text}</li>;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className={cn(
          line,
          "w-full cursor-pointer rounded-sm text-left outline-none focus-visible:shadow-[var(--focus-ring)]",
        )}
      >
        <span
          className={cn(
            "block",
            HANGING,
            open ? "whitespace-pre-wrap" : "line-clamp-2",
          )}
        >
          {text}
        </span>
      </button>
    </li>
  );
}

function Time({ at }: { at: string }) {
  const now = useNow();
  const when = Date.parse(at);
  if (Number.isNaN(when)) return <span>{at}</span>;
  const age = Math.max(0, now - when);
  return (
    <span title={new Date(when).toLocaleString()} className={ageRole(age)}>
      {humanDuration(age)} ago
    </span>
  );
}

export function ImageName({ image }: { image: string }) {
  const { path, name, digest } = splitImage(image);
  return (
    <code title={image} className="font-mono text-xs break-all">
      {path !== "" && <span className="text-quiet">{path}</span>}
      <span className="text-content">{name}</span>
      {digest !== "" && <span className="text-quiet">{digest}</span>}
    </code>
  );
}

export function Prose({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const folds = lineCount(text) > PROSE_LINES;
  return (
    <div className="flex max-w-160 flex-col items-start">
      <p
        className={cn(
          "w-full break-words",
          folds && !open && "line-clamp-3",
          className,
        )}
      >
        {text}
      </p>
      {folds && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="rounded-sm text-xs text-support outline-none hover:text-content focus-visible:shadow-[var(--focus-ring)]"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
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
  const age = Math.max(0, now - when);
  return (
    <span
      title={new Date(when).toLocaleString()}
      className={cn("tabular-nums", ageRole(age))}
    >
      {humanDuration(age)}
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
