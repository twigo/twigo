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
 * rest on hue alone. Its text is one line that is cut at its end, and
 * `detail` stands under it as a second line that is not.
 */
export function Banner({
  lead,
  tone,
  icon: Icon,
  title,
  children,
  detail,
  action,
}: {
  /** What it speaks about, as a tile, which leads it. */
  lead?: ReactNode;
  tone: keyof typeof TINT;
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  detail?: ReactNode;
  /** A button at its end. */
  action?: ReactNode;
}) {
  const stacked = detail !== undefined;
  return (
    <div
      data-tone={tone}
      className={cn(
        "flex min-h-8 flex-none items-center gap-2 border-b border-border-subtle pr-2 pl-3 text-xs",
        TINT[tone],
      )}
    >
      {lead}
      <span
        className={cn(
          "flex h-4 shrink-0 items-center",
          stacked && "mt-2 self-start",
        )}
      >
        <Icon aria-hidden className={cn("size-3.5", ICON[tone])} />
      </span>
      <div className={cn("min-w-0 flex-1", stacked && "py-2")}>
        <div className="truncate">
          <span className="font-medium">{title}</span>
          {children !== undefined && <> {children}</>}
        </div>
        {detail}
      </div>
      {action}
    </div>
  );
}
