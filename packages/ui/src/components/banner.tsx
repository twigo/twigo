import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

const TINT = {
  info: "bg-brand/8",
  warn: "bg-warn/10",
} as const;

/**
 * A slim bar across a view that says what holds for all of it: logs of a
 * previous container, streams that wait for the cluster's budget. Its
 * icon says the tone, so it does not rest on hue alone.
 */
export function Banner({
  tone,
  icon: Icon,
  children,
  action,
  className,
}: {
  tone: keyof typeof TINT;
  icon: LucideIcon;
  children: ReactNode;
  /** A button at its end. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-8 flex-none items-center gap-2 border-b border-border-subtle pr-2 pl-3 text-xs",
        TINT[tone],
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          tone === "warn" ? "text-warn-foreground" : "text-brand",
        )}
      />
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {action}
    </div>
  );
}
