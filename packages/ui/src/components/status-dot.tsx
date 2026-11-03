import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";

const SHAPE: Readonly<Record<Tone, string>> = {
  error: "bg-error",
  warn: "shadow-[inset_0_0_0_1.5px_var(--warn)]",
  ok: "bg-ok",
  idle: "bg-muted-foreground-2",
};

/**
 * A state as a dot: error filled, warn a ring, ok filled green, idle grey.
 * It pulses only while the state is in flight, and is hidden from screen
 * readers unless it has a label, since the text beside it says the state.
 */
export function StatusDot({
  tone,
  pulse = false,
  size = "sm",
  label,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  size?: "sm" | "md";
  label?: string;
  className?: string;
}) {
  return (
    <span
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "sm" ? "size-1.5" : "size-2",
        SHAPE[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}
