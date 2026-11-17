import type { ComponentProps, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

const TRIGGER =
  "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md bg-well px-2 text-xs";

/** A toolbar's button on a field's fill that opens a menu or a picker, lit while hovered or open. */
export function TriggerButton({
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        TRIGGER,
        "outline-none hover:bg-well-hover focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-well-hover",
        className,
      )}
      {...props}
    />
  );
}

/** What a trigger's choice narrowed to, in the trigger's place, with a ✕ that clears it. */
export function TriggerChip({
  children,
  clearLabel,
  onClear,
}: {
  children: ReactNode;
  clearLabel: string;
  onClear: () => void;
}) {
  return (
    <span className={TRIGGER}>
      {children}
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className="-mr-1 flex size-4 items-center justify-center rounded-xs text-support hover:bg-row-hover hover:text-content"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}
