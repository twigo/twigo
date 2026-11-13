import type { Cell, Row } from "@twigo/protocol";
import { cn, StatusDot } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { IN_FLIGHT, type ColumnRule } from "../columns";
import { useNow } from "../useNow";
import { measureFormat, noSample } from "../variants";

/** A column as the grid draws it: where its cells are and how they read. */
export interface ShownColumn {
  readonly name: string;
  /** Where the column's cells are in a row. */
  readonly index: number;
  readonly rule: ColumnRule;
}

/** A cell's text as the server gave it. */
function cellText(cell: Cell): string {
  return cell === null ? "" : String(cell);
}

/** An Age from the row's creation: only it ticks, so its row does not render every second. */
function Age({ created }: { created: string }) {
  const now = useNow();
  return (
    <span className="text-muted-foreground">
      {humanDuration(now - Date.parse(created))}
    </span>
  );
}

/** A cell by its column's rule (ARCHITECTURE 4.4): data stays near-monochrome. */
export function CellView({ row, column }: { row: Row; column: ShownColumn }) {
  const { rule } = column;
  if (rule.cell === "cpu" || rule.cell === "memory") {
    const value = row.cells[column.index];
    return typeof value === "number" ? (
      measureFormat(rule.cell)(value)
    ) : (
      <span className="text-muted-foreground-2">{noSample()}</span>
    );
  }
  if (rule.cell === "age") {
    return row.created ? (
      <Age created={row.created} />
    ) : (
      <span className="text-muted-foreground-2" />
    );
  }
  const text = cellText(row.cells[column.index] ?? null);
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
      <span className="shrink-0 text-muted-foreground-2">
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
    <>
      <span
        className={cn(
          "inline-block w-[3ch] text-right",
          count === "0" && "text-muted-foreground-2",
        )}
      >
        {count}
      </span>
      {ago && <span className="ml-2 text-muted-foreground">{ago} ago</span>}
    </>
  );
}
