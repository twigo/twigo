import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

const FIELD =
  "rounded-md bg-well px-2 text-xs text-content outline-none placeholder:text-support hover:bg-well-hover focus:shadow-[inset_0_0_0_1px_var(--ring)]";

/** A one-line field on its well; the caller names it with `aria-label` or a `label`. */
export function TextField({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      {...props}
      className={cn(FIELD, "h-7", className)}
    />
  );
}

/** A several-line field on its well, for text that is read and edited as it is: its lines do not wrap unless the caller says so. */
export function TextArea({
  mono = false,
  className,
  ...props
}: ComponentProps<"textarea"> & { mono?: boolean }) {
  return (
    <textarea
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      {...props}
      className={cn(
        FIELD,
        "resize-none py-1.5 leading-5",
        mono && "font-mono text-2xs",
        className,
      )}
    />
  );
}
