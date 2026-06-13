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
            role="status"
            className="pointer-events-auto relative flex items-start gap-2 overflow-hidden rounded-md border border-border bg-popover/90 py-2 pl-3.5 pr-2 text-xs shadow-lg backdrop-blur-xl duration-200 animate-in fade-in slide-in-from-right-2"
          >
            <span
              className={cn("absolute inset-y-0 left-0 w-0.5", ACCENT[t.kind])}
            />
            <Icon
              className={cn("mt-px size-3.5 shrink-0", ICON_TONE[t.kind])}
            />
            <span className="min-w-0 flex-1 break-words leading-relaxed text-foreground">
              {t.message}
            </span>
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
