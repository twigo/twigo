import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Kbd } from "./kbd";

// One placeholder for empty / no-results / error / loading regions so states
// stop drifting apart. `hero` centers an icon + title + body + optional action
// and shortcut hint (view roots, the editor watermark); `inline` is a single
// muted line for nested panels. Outer sizing stays with the caller (className).
export function EmptyState({
  icon: Icon,
  iconClassName,
  variant = "muted",
  density = "hero",
  title,
  action,
  secondary,
  kbd,
  role,
  className,
  children,
}: {
  icon?: LucideIcon;
  iconClassName?: string;
  variant?: "muted" | "error";
  density?: "hero" | "inline";
  title?: string;
  action?: { label: string; onClick: () => void; icon?: LucideIcon };
  /** Beside `action` and after it, such as a button to report the problem. */
  secondary?: React.ReactNode;
  kbd?: string;
  /** `status` for a line that says what is going on, which a screen reader reads out as it comes. */
  role?: "status";
  className?: string;
  children?: React.ReactNode;
}) {
  if (density === "inline") {
    return (
      <p
        role={role}
        className={cn(
          "flex items-start gap-1.5 px-2 py-3 text-xs leading-5",
          variant === "error" ? "text-error" : "text-support",
          className,
        )}
      >
        {Icon && (
          <Icon
            className={cn("mt-0.5 size-3.5 shrink-0 opacity-60", iconClassName)}
          />
        )}
        <span>{children}</span>
      </p>
    );
  }

  const ActionIcon = action?.icon;
  return (
    <div
      className={cn(
        "flex animate-in flex-col items-center justify-center gap-2 px-6 text-center text-sm fade-in slide-in-from-bottom-1 duration-300",
        variant === "error" ? "text-error" : "text-support",
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn(
            "size-8",
            variant === "error" ? "opacity-70" : "opacity-30",
            iconClassName,
          )}
        />
      )}
      {title && <p className="font-medium text-content">{title}</p>}
      {children}
      {(action || secondary) && (
        <div className="mt-1 flex items-center gap-2">
          {action && (
            <Button variant="outline" size="sm" onClick={action.onClick}>
              {ActionIcon && <ActionIcon />}
              {action.label}
            </Button>
          )}
          {secondary}
        </div>
      )}
      {kbd && <Kbd className="mt-1">{kbd}</Kbd>}
    </div>
  );
}
