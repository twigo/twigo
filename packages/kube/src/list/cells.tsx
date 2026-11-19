import type { Cell, Row } from "@twigo/protocol";
import { cn, StatusDot, type Tone } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { ageRole, printedAge, printedAt, restartedRecently } from "../age";
import { IN_FLIGHT, type ColumnRule } from "../columns";
import { ObjectName } from "../ObjectName";
import { Quantity } from "../Quantity";
import { isTabular } from "../tabular";
import { useNowAs } from "../useNow";
import { measureText } from "./metrics";

/** A column as the grid draws it: where its cells are and how they read. */
export interface ShownColumn {
  readonly name: string;
  /** Where the column's cells are in a row. */
  readonly index: number;
  readonly rule: ColumnRule;
  /** A column that left for this one, whose value reads before this one's. */
  readonly merged?: ShownColumn;
}

/** A cell's text as the server gave it. */
function cellText(cell: Cell): string {
  return cell === null ? "" : String(cell);
}

/** An Age from the row's creation, which ticks in a component of its own and draws again only when its text or its role changes, so neither its row nor the grid renders every second. */
function Age({ created }: { created: string }) {
  const at = Date.parse(created);
  const text = useNowAs((now) => humanDuration(now - at));
  const role = useNowAs((now) => ageRole(now - at));
  return <span className={role}>{text}</span>;
}

/**
 * A duration the server printed, such as a CronJob's Last Schedule, drawn
 * from the moment it stands for, so it grows as an Age does.
 */
function Since({ text, received }: { text: string; received: string }) {
  const at = printedAt(received, text);
  const shown = useNowAs((now) => {
    const age = printedAge(at, now);
    return age === undefined ? text : humanDuration(age);
  });
  return <>{shown}</>;
}

/**
 * A cell by its column's rule (ARCHITECTURE 4.4): data stays near-monochrome.
 * `tone` is the row's, from its health column: a row has one alarm, so a
 * ratio beside a toned status is plain, and `alarmed` says that the row has
 * its alarm already (`raisesAlarm`). `finished` says that the row's object
 * ran to completion, so its ratio is not short.
 */
export function CellView({
  row,
  column,
  tone: rowTone,
  alarmed,
  finished,
}: {
  row: Row;
  column: ShownColumn;
  tone: Tone | undefined;
  alarmed: boolean;
  finished: boolean;
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
      const merged = column.merged && (
        <>
          <span className={cn(column.merged.rule.figures && "tabular-nums")}>
            <CellView
              row={row}
              column={column.merged}
              tone={rowTone}
              alarmed={alarmed}
              finished={finished}
            />
          </span>{" "}
        </>
      );
      if (!tone)
        return (
          <>
            {merged}
            {rule.recedes ? <span className="text-support">{text}</span> : text}
          </>
        );
      return (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 align-top font-semibold",
            tone === "error" && "text-error",
            tone === "warn" && "text-warn-foreground",
          )}
        >
          <StatusDot tone={tone} pulse={IN_FLIGHT.test(text)} />
          {merged ? (
            <span>
              {merged}
              {text}
            </span>
          ) : (
            text
          )}
        </span>
      );
    }
    case "ratio":
      if (
        !finished &&
        rule.tone?.(text) &&
        (rule.health || rowTone === undefined)
      )
        return (
          <span
            className={cn(
              "text-warn-foreground",
              rule.health && "font-semibold",
            )}
          >
            {text}
          </span>
        );
      return rule.recedes && rowTone === undefined ? (
        <span className="text-support">{text}</span>
      ) : (
        text
      );
    case "restarts":
      return (
        <Restarts
          text={text}
          received={row.received}
          ticks={rule.ticks}
          alarmed={alarmed || finished}
        />
      );
    case "since":
      return <Since text={text} received={row.received} />;
    case "text": {
      const tabular = !rule.figures && isTabular(text);
      return rule.secondary || rule.identifier || tabular ? (
        <span
          className={cn(
            rule.secondary && "text-support",
            rule.identifier && "ident",
            tabular && "tabular-nums",
          )}
        >
          {text}
        </span>
      ) : (
        text
      );
    }
  }
}

/**
 * A restart count and how long ago the last was, the count in a column of
 * its own, the age growing from the moment the server printed it where the
 * column `ticks`, else as printed. A restart within the hour is news, in the
 * warning tone unless the row already raises an alarm, a row having one, or
 * its object ran to completion, when nothing in it is news any more.
 */
function Restarts({
  text,
  received,
  ticks,
  alarmed,
}: {
  text: string;
  received: string;
  ticks: boolean;
  alarmed: boolean;
}) {
  const match = /^(\d+)(?: \((.+) ago\))?$/.exec(text);
  const [, count = text, ago] = match ?? [];
  const at = ticks && ago !== undefined ? printedAt(received, ago) : undefined;
  const shown = useNowAs((now) => {
    const age = printedAge(at, now);
    return age === undefined ? ago : humanDuration(age);
  });
  const recent = useNowAs((now) => {
    const age = printedAge(at, now);
    return !alarmed && age !== undefined && restartedRecently(age);
  });
  return (
    <>
      <span
        className={cn(
          "inline-block w-[3ch] text-right",
          count === "0" && "text-quiet",
          recent && "text-warn-foreground",
        )}
      >
        {count}
      </span>
      {shown && (
        <span
          className={cn(
            "ml-2",
            recent ? "text-warn-foreground" : "text-support",
          )}
        >
          {shown} ago
        </span>
      )}
    </>
  );
}
