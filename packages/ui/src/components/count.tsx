import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";

const TONE: Readonly<Record<Tone | "quiet", string>> = {
  error: "text-error",
  warn: "text-warn-foreground",
  ok: "",
  idle: "text-support",
  quiet: "text-quiet",
};

/** What the most `digits` figures write, as zeros: in tabular figures every digit is as wide as a zero, so the room equals the figures'. */
const reserve = (digits: number) =>
  (10 ** digits - 1).toLocaleString("en").replace(/\d/g, "0");

/** A number as people read it, in tabular figures: `5,000`. */
export function Count({
  value,
  tone,
  digits,
  className,
}: {
  value: number;
  tone?: Tone | "quiet";
  /** The digits it keeps room for, so that a count that shrinks keeps its width. */
  digits?: number;
  className?: string;
}) {
  return (
    <span
      data-reserve={digits === undefined ? undefined : reserve(digits)}
      className={cn(
        "tabular-nums",
        digits !== undefined &&
          "inline-block after:invisible after:block after:h-0 after:overflow-hidden after:content-[attr(data-reserve)]",
        tone && TONE[tone],
        className,
      )}
    >
      {value.toLocaleString("en")}
    </span>
  );
}
