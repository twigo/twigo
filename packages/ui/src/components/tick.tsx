import { Check } from "lucide-react";

/** A box ticked or not beside a picked option's words, as a list's mark shows it. */
export function Tick({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={
        on
          ? "flex size-3.5 items-center justify-center rounded bg-brand text-brand-foreground"
          : "size-3.5 rounded shadow-[inset_0_0_0_1px_var(--input)]"
      }
    >
      {on && <Check className="size-3" />}
    </span>
  );
}
