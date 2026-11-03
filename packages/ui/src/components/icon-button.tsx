import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A button that is only an icon: its label is its accessible name and its
 * tooltip, with the keys that do the same when there are some.
 */
export function IconButton({
  icon: Icon,
  label,
  keys,
  pressed,
  size = "sm",
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  keys?: string;
  pressed?: boolean;
  size?: "sm" | "md";
  onClick: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-row-hover hover:text-foreground focus-visible:shadow-[var(--focus-ring)] aria-pressed:bg-row-active aria-pressed:text-foreground",
            size === "sm" ? "size-6 [&_svg]:size-3.5" : "size-7 [&_svg]:size-4",
            className,
          )}
        >
          <Icon aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        <span>{label}</span>
        {keys && <span className="text-muted-foreground">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
