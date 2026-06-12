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

const TONE: Record<ToastKind, string> = {
  error: "border-error/40",
  warning: "border-warn/40",
  info: "border-border",
  success: "border-ok/40",
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
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-md border bg-panel px-3 py-2 text-xs shadow-md duration-200 animate-in fade-in slide-in-from-right-2",
              TONE[t.kind],
            )}
          >
            <Icon
              className={cn("mt-0.5 size-3.5 shrink-0", ICON_TONE[t.kind])}
            />
            <span className="min-w-0 flex-1 break-words text-foreground">
              {t.message}
            </span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
                className="shrink-0 font-medium text-brand hover:underline"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
