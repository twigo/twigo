import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

const TINT = {
  info: "bg-brand/8",
  warn: "bg-warn/10",
  error: "bg-error/8",
} as const;

const ICON: Readonly<Record<keyof typeof TINT, string>> = {
  info: "text-brand",
  warn: "text-warn-foreground",
  error: "text-error",
};

/**
 * A slim bar across a view that says what holds for all of it: logs of a
 * previous container, streams that wait for the cluster's budget; its
 * title first, in a heavier weight. Its icon says the tone, so it does not
 * rest on hue alone.
 */
export function Banner({
  tone,
  icon: Icon,
  title,
  children,
  action,
}: {
  tone: keyof typeof TINT;
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  /** A button at its end. */
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-8 flex-none items-center gap-2 border-b border-border-subtle pr-2 pl-3 text-xs",
        TINT[tone],
      )}
    >
      <Icon aria-hidden className={cn("size-3.5 shrink-0", ICON[tone])} />
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium">{title}</span>
        {children !== undefined && <> {children}</>}
      </div>
      {action}
    </div>
  );
}
