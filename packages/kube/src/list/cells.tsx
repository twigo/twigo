import type { Cell, Row } from "@twigo/protocol";
import { cn, StatusDot } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { IN_FLIGHT, type ColumnRule } from "../columns";

/** A column as the grid draws it: where its cells are and how they read. */
export interface ShownColumn {
  readonly name: string;
  /** Where the column's cells are in a row. */
  readonly index: number;
  readonly rule: ColumnRule;
}

/** A cell's text as the server gave it, an Age from the row's creation. */
function cellText(
  cell: Cell,
  column: ShownColumn,
  row: Row,
  now: number,
): string {
  if (column.rule.cell === "age") {
    return row.created ? humanDuration(now - Date.parse(row.created)) : "";
  }
  return cell === null ? "" : String(cell);
}

/** A cell by its column's rule (ARCHITECTURE 4.4): data stays near-monochrome. */
export function CellView({
  row,
  column,
  now,
}: {
  row: Row;
  column: ShownColumn;
  now: number;
}) {
  const text = cellText(row.cells[column.index] ?? null, column, row, now);
  const { rule } = column;
  if (text === "<none>" || text === "")
    return <span className="text-muted-foreground-2">{text}</span>;
  switch (rule.cell) {
    case "name":
      return <Name name={text} generated={row.generated} />;
    case "status": {
      const tone = rule.tone?.(text);
      if (!tone) return text;
      return (
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            tone === "error" && "text-error",
            tone === "warn" && "text-warn-foreground",
          )}
        >
          <StatusDot tone={tone} pulse={IN_FLIGHT.test(text)} />
          {text}
        </span>
      );
    }
    case "ratio":
      return rule.tone?.(text) ? (
        <span className="text-warn-foreground">{text}</span>
      ) : (
        text
      );
    case "restarts":
      return <Restarts text={text} />;
    case "age":
      return <span className="text-muted-foreground">{text}</span>;
    case "text":
      return rule.quiet ? (
        <span className="text-muted-foreground">{text}</span>
      ) : (
        text
      );
  }
}

/**
 * A name with its generated part quieter, which is also the part kept when
 * the name does not fit, since it tells siblings apart: `auth-api-` and a
 * quieter `7f9c8d6b5-x2kq9`.
 */
function Name({ name, generated }: { name: string; generated: number | null }) {
  if (generated === null || generated <= 0 || generated >= name.length)
    return name;
  return (
    <span className="inline-flex max-w-full min-w-0 align-bottom">
      <span className="truncate">{name.slice(0, generated)}</span>
      <span className="shrink-0 text-muted-foreground">
        {name.slice(generated)}
      </span>
    </span>
  );
}

/** A restart count and how long ago the last was, the count in a column of its own. */
function Restarts({ text }: { text: string }) {
  const match = /^(\d+)(?: \((.+) ago\))?$/.exec(text);
  const [, count = text, ago] = match ?? [];
  return (
    <span className="inline-grid grid-cols-[3ch_1fr] gap-2 align-bottom">
      <span
        className={cn("text-right", count === "0" && "text-muted-foreground-2")}
      >
        {count}
      </span>
      {ago && <span className="text-muted-foreground">{ago} ago</span>}
    </span>
  );
}
