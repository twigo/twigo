import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface Property {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** The label in full, when it may be cut. */
  readonly title?: string;
}

/**
 * Labels and their values in two aligned columns, the label in support and
 * cut where it does not fit. The label column is as wide as its labels
 * unless a part sets `--label-column`, which every list in it then reads,
 * so their values share one axis.
 */
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
        "grid grid-cols-[var(--label-column,fit-content(14rem))_minmax(0,1fr)] items-baseline gap-x-3 gap-y-[5px]",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="truncate text-label text-support" title={item.title}>
            {item.label}
          </dt>
          <dd className="min-w-0 text-body break-words text-content tabular-nums">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
