import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { CopyButton } from "./copy-button";

export interface Property {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** The tooltip of the label: its full text in a `cut` list, else what it does not say. */
  readonly title?: string;
  /** The value is figures, which line up in tabular numerals. */
  readonly numeric?: boolean;
  readonly stacked?: boolean;
  /** The value wraps over lines, as text does, where a name is cut: its copy icon takes the end of the first line and covers nothing. */
  readonly wraps?: boolean;
  /** What the row's copy icon puts on the clipboard; a row has the icon only with it. */
  readonly copy?: string | undefined;
  /** The name of the row's copy icon, `Copy Image`: the text of `label` when that is text. */
  readonly copyLabel?: string;
}

/**
 * Labels and their values in two aligned columns, the label in support. A
 * label wraps in the label column, which a part sets with `--label-column`
 * so that every list in it shares one axis for its values. A `cut` list is
 * for labels that read as one token, such as keys and paths: it has its own
 * column, as wide as its longest label up to 14rem, and cuts what does not
 * fit. A stacked row's label takes a line to itself, so that its value
 * reads across the whole list. A row's copy icon shows while the row is
 * hovered or has the focus: it lies over the end of a cut value, which it
 * takes no width from, and floats at the end of a wrapping value's first
 * line, which it covers none of.
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
      {items.map((item) => {
        const floated = item.wraps === true && !item.stacked;
        const copy = item.copy !== undefined && (
          <CopyButton
            text={item.copy}
            label={`Copy value of ${item.copyLabel ?? (typeof item.label === "string" ? item.label : "this row")}`}
            floated={floated}
            className={item.stacked ? "top-1" : undefined}
          />
        );
        return (
          <div key={item.key} className="group/copy contents">
            <dt
              className={cn(
                "text-label text-support",
                item.stacked
                  ? "relative col-span-2 pt-1 wrap-anywhere"
                  : cut
                    ? "truncate"
                    : "wrap-anywhere",
              )}
              title={item.title}
            >
              {item.label}
              {item.stacked && copy}
            </dt>
            <dd
              className={cn(
                "min-w-0 text-body break-words text-content",
                item.stacked && "col-span-2 pb-1",
                item.numeric && "tabular-nums",
                !item.stacked && !floated && copy && "relative",
              )}
            >
              {floated && copy}
              {item.value}
              {!item.stacked && !floated && copy}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
