import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { Button } from "./button";
import { Kbd } from "./kbd";

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
      <span className="grid min-w-0 flex-1 justify-items-start gap-1 leading-5">
        <span className="break-words text-foreground">{message}</span>
        {action && (
          <button
            type="button"
            onClick={() => {
              action.run();
              toast.dismiss(id);
            }}
            className="-ml-1.5 rounded px-1.5 py-0.5 font-medium text-brand transition-colors hover:bg-brand/10 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
          >
            {action.label}
          </button>
        )}
      </span>
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

export interface CountdownToastProps {
  icon: LucideIcon;
  message: ReactNode;
  /** Says what happens when, from the seconds left: `dev · sends in 4 s`. */
  detail: (seconds: number) => ReactNode;
  /** When it ends, in milliseconds since the epoch. */
  until: number;
  /** How long it counts in all, which its bar shows. */
  seconds: number;
  /** Its one button: Cancel of a send, Undo of what ran. */
  action: { label: string; keys?: string; run: () => void };
}

/**
 * Something that lasts its seconds, as Headlamp holds a delete
 * (ARCHITECTURE 6.4): a send that happens once they run out unless
 * cancelled, or an undo that lasts as long. A bar runs down under it, and
 * its owner, not the toast, keeps the time.
 */
export function CountdownToast({
  icon: Icon,
  message,
  detail,
  until,
  seconds,
  action,
}: CountdownToastProps) {
  const [shown, setShown] = useState(() => secondsLeft(until));
  useEffect(() => {
    const tick = setInterval(() => {
      setShown(secondsLeft(until));
    }, 250);
    return () => {
      clearInterval(tick);
    };
  }, [until]);
  // Set once: a new duration mid-way would make the bar jump.
  const [bar] = useState(() => {
    const remaining = Math.max(0, until - Date.now());
    return {
      "--countdown-from": remaining / (seconds * 1000),
      animationDuration: `${remaining}ms`,
    } as CSSProperties;
  });
  return (
    <div
      role="status"
      className="relative flex w-[var(--width)] items-center gap-2 overflow-hidden rounded-md border border-border bg-popover/90 py-2 pr-2 pl-3 font-sans text-xs shadow-lg backdrop-blur-xl"
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="grid min-w-0 flex-1 gap-0.5 leading-5">
        <span className="break-words text-foreground">{message}</span>
        <span className="text-[11px] leading-4 text-muted-foreground">
          {detail(shown)}
        </span>
      </span>
      <button
        type="button"
        onClick={action.run}
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
      >
        {action.label}
        {action.keys && <Kbd>{action.keys}</Kbd>}
      </button>
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-countdown bg-brand"
        style={bar}
      />
    </div>
  );
}

export interface ChoiceToastProps {
  icon: LucideIcon;
  message: ReactNode;
  detail?: ReactNode;
  /** The choices as buttons, the first of them the one to take. */
  choices: readonly { label: string; run: () => void }[];
  /** While an answer is on its way, which the buttons wait for. */
  busy?: boolean;
}

/**
 * Something that waits for an answer: what came and the buttons to answer
 * it with. It has no close of its own, since closing it would answer
 * nothing.
 */
export function ChoiceToast({
  icon: Icon,
  message,
  detail,
  choices,
  busy = false,
}: ChoiceToastProps) {
  return (
    <div
      role="status"
      className="relative flex w-[var(--width)] items-start gap-2 overflow-hidden rounded-md border border-border bg-popover/90 py-2 pr-2 pl-3 font-sans text-xs shadow-lg backdrop-blur-xl"
    >
      <span className="flex h-5 shrink-0 items-center">
        <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      </span>
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-1.5 leading-5">
        <span className="break-words text-foreground">{message}</span>
        {detail}
        <span className="flex flex-wrap gap-1.5">
          {choices.map(({ label, run }, index) => (
            <Button
              key={label}
              size="sm"
              variant={index === 0 ? "brand" : "outline"}
              disabled={busy}
              onClick={run}
              className="h-auto min-h-6.5 max-w-full py-1 text-left whitespace-normal wrap-anywhere"
            >
              {label}
            </Button>
          ))}
        </span>
      </span>
    </div>
  );
}

function secondsLeft(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

const WIDTH = { "--width": "288px" } as CSSProperties;
const GAP = 6;
/** The status bar's 24 px and 8 px of air: the lowest the front toast sits. */
const FLOOR = 32;
/**
 * While the stack is closed sonner caps a toast behind the front one to the
 * front's height, and hides the children of its own styled toasts only
 * (`data-styled`, which a custom toast is not), so a taller card would hang
 * out of the cap over what is under the stack, and a pointer there would
 * open and close the stack. Clipped and hidden, as the styled ones are.
 */
const BEHIND =
  "data-[front=false]:data-[expanded=false]:overflow-hidden data-[front=false]:data-[expanded=false]:*:opacity-0";

/**
 * The height of the toasts that show, spread as sonner spreads them while
 * the pointer is over them: each at its own height, a gap between. Sonner
 * keeps a toast's own height in `--initial-height`; a toast behind the
 * front one is shorter while the stack is closed.
 */
function spreadHeight(section: HTMLElement): number {
  const heights = [
    ...section.querySelectorAll<HTMLElement>(
      '[data-sonner-toast][data-visible="true"][data-removed="false"]',
    ),
  ].map(
    (toast) =>
      Number.parseFloat(toast.style.getPropertyValue("--initial-height")) || 0,
  );
  return (
    heights.reduce((sum, height) => sum + height, 0) +
    GAP * Math.max(0, heights.length - 1)
  );
}

function useSpreadHeight() {
  const section = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = section.current;
    if (!element) return;
    const measure = () => {
      setHeight(spreadHeight(element));
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "data-visible", "data-removed"],
    });
    return () => {
      observer.disconnect();
    };
  }, []);
  return { section, height };
}

/**
 * `clearance` is the height of what the window shows above its status bar
 * that the toasts must not cover, and `ceiling` the height of what it shows
 * under its top that they must not reach. The toasts sit above the
 * clearance while they fit there, spread by a hover, else as low as it takes
 * to keep them whole under the ceiling, but never below the status bar's
 * edge: a stack taller than the window lets its top go past the title bar,
 * and the front toast stays in the window. A window of 600 px or less, where
 * sonner takes other offsets, gets the same ones.
 */
export function Toaster({
  clearance = 0,
  ceiling = 0,
}: {
  clearance?: number;
  ceiling?: number;
}) {
  const { section, height } = useSpreadHeight();
  const bottom = `max(${String(FLOOR)}px, min(${String(FLOOR + clearance)}px, calc(100dvh - ${String(ceiling + 8 + height)}px)))`;
  const offset = { bottom, right: 12 };
  return (
    <SonnerToaster
      ref={section}
      position="bottom-right"
      visibleToasts={3}
      gap={GAP}
      offset={offset}
      mobileOffset={offset}
      style={WIDTH}
      toastOptions={{ className: BEHIND }}
      containerAriaLabel="Notifications"
    />
  );
}
