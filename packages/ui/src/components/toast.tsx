import type { CSSProperties, ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Toaster as SonnerToaster, toast } from "sonner";
import { cn } from "../lib/cn";

export type Tone = "success" | "error" | "warning" | "info";

const TONE: Readonly<
  Record<Tone, { icon: LucideIcon; text: string; rule: string }>
> = {
  success: { icon: CircleCheck, text: "text-ok", rule: "bg-ok" },
  error: { icon: CircleAlert, text: "text-error", rule: "bg-error" },
  warning: { icon: TriangleAlert, text: "text-warn", rule: "bg-warn" },
  info: {
    icon: Info,
    text: "text-muted-foreground",
    rule: "bg-muted-foreground/40",
  },
};

export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastProps {
  id: string | number;
  tone: Tone;
  message: ReactNode;
  action: ToastAction | undefined;
}

/**
 * A toast is a popover surface with the tone as its icon and a thin rule,
 * not a filled box (ARCHITECTURE 4.9).
 */
export function Toast({ id, tone, message, action }: ToastProps) {
  const { icon: Icon, text, rule } = TONE[tone];
  return (
    <div
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      className="relative flex w-[var(--width)] items-start gap-2 overflow-hidden rounded-md border border-border bg-popover/90 py-2 pr-2 pl-3.5 font-sans text-xs shadow-lg backdrop-blur-xl"
    >
      <span className={cn("absolute inset-y-0 left-0 w-0.5", rule)} />
      <span className="flex h-5 shrink-0 items-center">
        <Icon aria-hidden className={cn("size-3.5", text)} />
      </span>
      <span className="min-w-0 flex-1 leading-5 break-words text-foreground">
        {message}
      </span>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.run();
            toast.dismiss(id);
          }}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-brand transition-colors hover:bg-brand/10 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => toast.dismiss(id)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

const WIDTH = { "--width": "288px" } as CSSProperties;

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      visibleToasts={3}
      gap={6}
      offset={{ bottom: 32, right: 12 }}
      style={WIDTH}
      containerAriaLabel="Notifications"
    />
  );
}
