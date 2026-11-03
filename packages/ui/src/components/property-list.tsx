import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface Property {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** The label in full, when it may be cut. */
  readonly title?: string;
}

/** Labels and their values in two aligned columns, the label quiet. */
export function PropertyList({
  items,
  className,
}: {
  items: readonly Property[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[fit-content(14rem)_minmax(0,1fr)] gap-x-3 gap-y-[5px] leading-[1.35]",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="truncate text-muted-foreground" title={item.title}>
            {item.label}
          </dt>
          <dd className="min-w-0 break-words tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
