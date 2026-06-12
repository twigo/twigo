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
  variant = "muted",
  density = "hero",
  title,
  action,
  kbd,
  className,
  children,
}: {
  icon?: LucideIcon;
  variant?: "muted" | "error";
  density?: "hero" | "inline";
  title?: string;
  action?: { label: string; onClick: () => void; icon?: LucideIcon };
  kbd?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  if (density === "inline") {
    return (
      <p
        className={cn(
          "flex items-start gap-1.5 px-2 py-3 text-xs leading-relaxed",
          variant === "error" ? "text-error" : "text-muted-foreground",
          className,
        )}
      >
        {Icon && <Icon className="mt-0.5 size-3.5 shrink-0 opacity-60" />}
        <span>{children}</span>
      </p>
    );
  }

  const ActionIcon = action?.icon;
  return (
    <div
      className={cn(
        "flex animate-in flex-col items-center justify-center gap-2 px-6 text-center text-sm fade-in slide-in-from-bottom-1 duration-300",
        variant === "error" ? "text-error" : "text-muted-foreground",
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn(
            "size-8",
            variant === "error" ? "opacity-70" : "opacity-30",
          )}
        />
      )}
      {title && <p className="font-medium text-foreground">{title}</p>}
      {children}
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={action.onClick}
        >
          {ActionIcon && <ActionIcon />}
          {action.label}
        </Button>
      )}
      {kbd && <Kbd className="mt-1">{kbd}</Kbd>}
    </div>
  );
}
