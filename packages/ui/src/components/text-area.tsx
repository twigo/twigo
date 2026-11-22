import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

const FIELD =
  "rounded-md bg-well px-2 text-xs text-content outline-none placeholder:text-support hover:bg-well-hover focus:shadow-[inset_0_0_0_1px_var(--ring)]";

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
        "resize-none rounded-lg py-2 leading-5",
        mono && "font-mono text-prose",
        className,
      )}
    />
  );
}
