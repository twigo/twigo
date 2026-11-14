import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface Property {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** The tooltip of the label: its full text in a `cut` list, else what it does not say. */
  readonly title?: string;
  /** The value is figures, which line up in tabular numerals. */
  readonly numeric?: boolean;
}

/**
 * Labels and their values in two aligned columns, the label in support. A
 * label wraps in the label column, which a part sets with `--label-column`
 * so that every list in it shares one axis for its values. A `cut` list is
 * for labels that read as one token, such as keys and paths: it has its own
 * column, as wide as its longest label up to 14rem, and cuts what does not
 * fit.
 */
export function PropertyList({
  items,
  cut = false,
  className,
}: {
  items: readonly Property[];
  cut?: boolean;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid items-baseline gap-x-3 gap-y-[5px]",
        cut
          ? "grid-cols-[fit-content(14rem)_minmax(0,1fr)]"
          : "grid-cols-[var(--label-column,fit-content(14rem))_minmax(0,1fr)]",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt
            className={cn(
              "text-label text-support",
              cut ? "truncate" : "wrap-anywhere",
            )}
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
