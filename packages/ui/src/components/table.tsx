import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * A few rows under named columns, read rather than worked through: a
 * pod's volumes, a Service's ports. Lists of objects are `DataGrid`s.
 * Cells keep to one line and the table scrolls sideways, but the last
 * column wraps, as it holds the longest text.
 */
export function Table({
  label,
  columns,
  rows,
  className,
}: {
  label: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table aria-label={label} className="w-full border-collapse text-left">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
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
                  className="py-1 pr-3 whitespace-nowrap tabular-nums last:min-w-28 last:pr-0 last:break-words last:whitespace-normal"
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
