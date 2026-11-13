import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";

const FILL: Readonly<Record<Tone, string>> = {
  error: "bg-error",
  warn: "bg-warn",
  ok: "bg-muted-foreground",
  idle: "bg-muted-foreground",
};

/**
 * How much of a whole is used, as a bar that changes without animation.
 * `max` is the whole, and a value past it fills the bar; `mark` is a place
 * on it, such as what was requested. The words beside it say the figures,
 * and its tone is also said by them, so no state rests on hue alone.
 */
export function Meter({
  label,
  value,
  max,
  mark,
  tone = "idle",
  className,
}: {
  label: string;
  value: number;
  max: number;
  mark?: number;
  tone?: Tone;
  className?: string;
}) {
  const share = (of: number) =>
    `${String(Math.min(1, Math.max(0, of / max)) * 100)}%`;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className={cn("relative h-2 w-full min-w-12", className)}
    >
      <span className="absolute inset-0 overflow-hidden rounded-xs bg-foreground/12">
        <span
          className={cn("absolute inset-y-0 left-0", FILL[tone])}
          style={{ width: share(value) }}
        />
      </span>
      {mark !== undefined && (
        <span
          aria-hidden
          className="absolute -inset-y-0.5 w-px bg-foreground"
          style={{ left: share(mark) }}
        />
      )}
    </div>
  );
}
