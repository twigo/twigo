import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function TextArea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      {...props}
      className={cn(
        "resize-none rounded-lg bg-well px-2 py-2 font-mono text-prose text-content outline-none placeholder:text-support hover:bg-well-hover focus:shadow-[inset_0_0_0_1px_var(--ring)]",
        className,
      )}
    />
  );
}
