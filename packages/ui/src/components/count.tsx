import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";

const TONE: Readonly<Record<Tone | "quiet", string>> = {
  error: "text-error",
  warn: "text-warn-foreground",
  ok: "",
  idle: "text-support",
  quiet: "text-quiet",
};

/** A number as people read it, in tabular figures: `5,000`. */
export function Count({
  value,
  tone,
  digits,
  className,
}: {
  value: number;
  tone?: Tone | "quiet";
  /** The characters it keeps room for, so that a count that shrinks keeps its width. */
  digits?: number;
  className?: string;
}) {
  return (
    <span
      style={
        digits === undefined ? undefined : { minWidth: `${String(digits)}ch` }
      }
      className={cn(
        "tabular-nums",
        digits !== undefined && "inline-block",
        tone && TONE[tone],
        className,
      )}
    >
      {value.toLocaleString("en")}
    </span>
  );
}
