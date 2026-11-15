import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { ButtonTip } from "./tip";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A button that is only an icon: its label is its accessible name and its
 * tooltip, with the keys that do the same when there are some, and why it
 * cannot run, or what a lock will answer, when there is a reason. A
 * disabled one keeps the focus, so that its tooltip can say why.
 */
export function IconButton({
  icon: Icon,
  label,
  keys,
  pressed,
  disabled = false,
  locked = false,
  reason,
  size = "sm",
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  keys?: string;
  pressed?: boolean;
  disabled?: boolean;
  locked?: boolean;
  reason?: string;
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
          aria-disabled={disabled || undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (!disabled) onClick();
          }}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-md text-support outline-none hover:bg-row-hover hover:text-content focus-visible:shadow-[var(--focus-ring)] aria-pressed:bg-row-active aria-pressed:text-content",
            size === "sm" ? "size-6 [&_svg]:size-3.5" : "size-7 [&_svg]:size-4",
            (disabled || locked) && "opacity-50",
            disabled && "hover:bg-transparent hover:text-support",
            className,
          )}
        >
          <Icon aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <ButtonTip label={label} keys={keys} reason={reason} locked={locked} />
      </TooltipContent>
    </Tooltip>
  );
}
