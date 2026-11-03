import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Kbd } from "./kbd";

export interface KeyHint {
  readonly id: string;
  /** As the keybinding service labels them: `⌘P`. */
  readonly keys: string;
  readonly label: ReactNode;
}

/** Keys and what they do, each key before its words, as an empty editor area lists them. */
export function KeyHints({
  hints,
  className,
}: {
  hints: readonly KeyHint[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {hints.map((hint) => (
        <div key={hint.id} className="contents">
          <dt>
            <Kbd>{hint.keys}</Kbd>
          </dt>
          <dd>{hint.label}</dd>
        </div>
      ))}
    </dl>
  );
}
