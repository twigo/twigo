import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Kbd } from "./kbd";

// One placeholder for empty / no-results / error / loading regions so states
// stop drifting apart. `hero` centers an icon + title + body + optional action
// and shortcut hint (view roots, the editor watermark); `inline` is a single
// muted line for nested panels. Outer sizing stays with the caller (className).
// `aurora` adds a faint brand glow behind the hero - reserved for the editor
// zero-state so the big empty canvas gets a quiet signature moment.
export function EmptyState({
  icon: Icon,
  iconClassName,
  variant = "muted",
  density = "hero",
  title,
  action,
  kbd,
  aurora = false,
  className,
  children,
}: {
  icon?: LucideIcon;
  iconClassName?: string;
  variant?: "muted" | "error";
  density?: "hero" | "inline";
  title?: string;
  action?: { label: string; onClick: () => void; icon?: LucideIcon };
  kbd?: string;
  aurora?: boolean;
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
        "relative flex animate-in flex-col items-center justify-center gap-2 px-6 text-center text-sm fade-in slide-in-from-bottom-1 duration-300",
        variant === "error" ? "text-error" : "text-muted-foreground",
        className,
      )}
    >
      {aurora && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 [background:radial-gradient(40rem_22rem_at_50%_45%,color-mix(in_oklab,var(--brand)_7%,transparent),transparent_70%)]"
        />
      )}
      {Icon && (
        <div
          className={cn(
            "mb-1 flex size-12 items-center justify-center rounded-xl border",
            variant === "error"
              ? "border-error/25 bg-error/10 text-error"
              : "border-brand/20 bg-gradient-to-b from-brand/15 to-brand/5 text-brand",
          )}
        >
          <Icon className={cn("size-5", iconClassName)} />
        </div>
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
