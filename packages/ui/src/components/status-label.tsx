import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";
import { StatusDot } from "./status-dot";

const WORD = "inline-flex min-w-0 items-center gap-1.5";

const ROOT: Readonly<Record<Tone, string>> = {
  error: `${WORD} text-error`,
  warn: `${WORD} text-warn-foreground`,
  ok: WORD,
  idle: WORD,
};

/**
 * A state as its dot and its words, the words in the tone's colour while it
 * is abnormal: `Reconnecting`, `CrashLoopBackOff`.
 */
export function StatusLabel({
  tone,
  pulse = false,
  hollow = false,
  className,
  children,
}: {
  tone: Tone;
  /** While the state is in flight. */
  pulse?: boolean;
  /** An idle state that is off rather than waiting. */
  hollow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={className ? cn(ROOT[tone], className) : ROOT[tone]}>
      <StatusDot tone={tone} pulse={pulse} hollow={hollow} />
      <span className="truncate">{children}</span>
    </span>
  );
}
