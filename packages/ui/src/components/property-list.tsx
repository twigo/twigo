import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface Property {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** What the tooltip of the label says, when the label does not say it all. */
  readonly title?: string;
  /** The value is figures, which line up in tabular numerals. */
  readonly numeric?: boolean;
}

/**
 * Labels and their values in two aligned columns, the label in support. A
 * label wraps in the label column, which a part sets with `--label-column`
 * so that every list in it shares one axis for its values.
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
          <dt
            className="text-label wrap-anywhere text-support"
            title={item.title}
          >
            {item.label}
          </dt>
          <dd
            className={cn(
              "min-w-0 text-body break-words text-content",
              item.numeric && "tabular-nums",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
