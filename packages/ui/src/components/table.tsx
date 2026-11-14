import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * A few rows under named columns, read rather than worked through: a
 * pod's volumes, a Service's ports. Lists of objects are `DataGrid`s.
 * Cells keep to one line and the table scrolls sideways, but the last
 * column wraps, as it holds the longest text. `numeric` says, by column
 * index, which columns hold figures, which line up in tabular numerals.
 */
export function Table({
  label,
  columns,
  rows,
  numeric = [],
  className,
}: {
  label: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  numeric?: readonly boolean[];
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table aria-label={label} className="w-full border-collapse text-left">
        <thead>
          <tr className="text-xs text-support">
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="h-6 pr-3 font-semibold whitespace-nowrap last:pr-0"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              className="border-t border-border-subtle align-baseline"
            >
              {row.map((cell, at) => (
                <td
                  key={at}
                  className={cn(
                    "py-1 pr-3 whitespace-nowrap last:min-w-28 last:pr-0 last:break-words last:whitespace-normal",
                    numeric[at] && "tabular-nums",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
