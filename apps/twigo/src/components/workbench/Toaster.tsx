import {
  X,
  AlertTriangle,
  Info,
  CircleAlert,
  CircleCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@twigo/ui";
import { useToasts, type ToastKind } from "@/store/toasts";

const ICON: Record<ToastKind, LucideIcon> = {
  error: CircleAlert,
  warning: AlertTriangle,
  info: Info,
  success: CircleCheck,
};

// Surface stays neutral like every other floating layer; severity reads from
// the icon and a thin left accent rule, not a loud full-perimeter border.
const ACCENT: Record<ToastKind, string> = {
  error: "bg-error",
  warning: "bg-warn",
  info: "bg-muted-foreground/40",
  success: "bg-ok",
};

const ICON_TONE: Record<ToastKind, string> = {
  error: "text-error",
  warning: "text-warn",
  info: "text-muted-foreground",
  success: "text-ok",
};

// Reserve the assertive announcement for faults; routine outcomes are polite.
const ROLE: Record<ToastKind, "alert" | "status"> = {
  error: "alert",
  warning: "alert",
  info: "status",
  success: "status",
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-8 right-3 z-50 flex w-72 flex-col gap-1.5"
    >
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            data-twigo-toast=""
            data-state={t.leaving ? "leaving" : "open"}
            role={ROLE[t.kind]}
            className="pointer-events-auto relative flex items-start gap-2 overflow-hidden rounded-md border border-border bg-popover/90 py-2 pl-3.5 pr-2 text-xs shadow-lg backdrop-blur-xl"
          >
            <span
              className={cn("absolute inset-y-0 left-0 w-0.5", ACCENT[t.kind])}
            />
            {/* h-5 matches the message's leading-5 so the icon centers on the
                first line (and stays by the first line when text wraps). */}
            <span className="flex h-5 shrink-0 items-center">
              <Icon className={cn("size-3.5", ICON_TONE[t.kind])} />
            </span>
            <span className="min-w-0 flex-1 break-words leading-5 text-foreground">
              {t.message}
            </span>
            {t.count > 1 && (
              // aria-hidden so a repeat ticking the badge doesn't re-announce.
              <span
                aria-hidden="true"
                className="flex h-5 shrink-0 items-center"
              >
                <span className="rounded bg-muted-foreground/15 px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
                  ×{t.count > 99 ? "99+" : t.count}
                </span>
              </span>
            )}
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
                className="shrink-0 rounded px-1.5 py-0.5 font-medium text-brand transition-colors hover:bg-brand/10 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
