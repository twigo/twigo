import type { Cell, Row } from "@twigo/protocol";
import { cn, StatusDot, type Tone } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { ageRole } from "../age";
import { IN_FLIGHT, type ColumnRule } from "../columns";
import { ObjectName } from "../ObjectName";
import { Quantity } from "../Quantity";
import { useNow } from "../useNow";
import { measureText } from "./metrics";

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
  const age = useNow() - Date.parse(created);
  return <span className={ageRole(age)}>{humanDuration(age)}</span>;
}

/**
 * A cell by its column's rule (ARCHITECTURE 4.4): data stays near-monochrome.
 * `tone` is the row's, from its health column: a row has one alarm, so a
 * ratio beside a toned status is plain.
 */
export function CellView({
  row,
  column,
  tone: rowTone,
}: {
  row: Row;
  column: ShownColumn;
  tone: Tone | undefined;
}) {
  const { rule } = column;
  if (rule.cell === "cpu" || rule.cell === "memory") {
    const measured = measureText(rule.cell, row.cells[column.index] ?? null);
    return measured === undefined ? (
      <span className="text-quiet">–</span>
    ) : (
      <Quantity text={measured} />
    );
  }
  if (rule.cell === "age") {
    return row.created ? (
      <Age created={row.created} />
    ) : (
      <span className="text-quiet" />
    );
  }
  const text = cellText(row.cells[column.index] ?? null);
  if (text === "<none>" || text === "")
    return <span className="text-quiet">{text}</span>;
  switch (rule.cell) {
    case "name":
      return <ObjectName name={text} generated={row.generated} />;
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
      return rule.tone?.(text) && (rule.health || rowTone === undefined) ? (
        <span className="text-warn-foreground">{text}</span>
      ) : (
        text
      );
    case "restarts":
      return <Restarts text={text} />;
    case "text":
      return rule.quiet ? <span className="text-support">{text}</span> : text;
  }
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
          count === "0" && "text-quiet",
        )}
      >
        {count}
      </span>
      {ago && <span className="ml-2 text-support">{ago} ago</span>}
    </>
  );
}
