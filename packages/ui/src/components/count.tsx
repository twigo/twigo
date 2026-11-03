import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";

const TONE: Readonly<Record<Tone | "quiet", string>> = {
  error: "text-error",
  warn: "text-warn-foreground",
  ok: "",
  idle: "text-muted-foreground",
  quiet: "text-muted-foreground-2",
};

/** A number as people read it, in tabular figures: `5,000`. */
export function Count({
  value,
  tone,
  className,
}: {
  value: number;
  tone?: Tone | "quiet";
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", tone && TONE[tone], className)}>
      {value.toLocaleString("en")}
    </span>
  );
}
