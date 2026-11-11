import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";
import { StatusDot } from "./status-dot";

const TINT: Readonly<Record<Tone, string>> = {
  error: "bg-error/12 text-error",
  warn: "bg-warn/16 text-warn-foreground",
  ok: "bg-ok/14 text-foreground",
  idle: "bg-row-active text-muted-foreground",
};

/** A state in words on its tone's tint, with its dot or an icon in its place: an object's status. */
export function Pill({
  tone,
  icon,
  children,
  className,
}: {
  tone: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs whitespace-nowrap",
        TINT[tone],
        className,
      )}
    >
      {icon ?? <StatusDot tone={tone} />}
      {children}
    </span>
  );
}
