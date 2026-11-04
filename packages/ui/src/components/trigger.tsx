import type { ComponentProps, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

const TRIGGER =
  "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs shadow-[inset_0_0_0_1px_var(--border)] outline-none hover:bg-row-hover focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-active";

/** A toolbar's bordered button that opens a menu or a picker, lit while it is open. */
export function TriggerButton({
  className,
  ...props
}: ComponentProps<"button">) {
  return <button type="button" className={cn(TRIGGER, className)} {...props} />;
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
        className="-mr-1 flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-row-hover hover:text-foreground"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}
