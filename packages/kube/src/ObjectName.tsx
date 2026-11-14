import { cn } from "@twigo/ui";
import { splitName } from "./names";

const IN_ROW =
  "group-data-[cursor]/row:text-strong group-aria-selected/row:text-strong";

/**
 * A name as a list draws it and the details title it: the part before the
 * generated one in content, the hash quiet, the last segment in support.
 * A name that does not fit gives up the hash first, to an ellipsis, then
 * the end of its first part, and never the last segment. In the row under
 * the cursor and in a selected one the name is strong.
 */
export function ObjectName({
  name,
  generated,
  className,
}: {
  name: string;
  generated: number | null;
  className?: string;
}) {
  const { first, hash, last } = splitName(name, generated);
  if (last === "") {
    return (
      <span
        className={cn("ident min-w-0 truncate text-content", IN_ROW, className)}
      >
        {name}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "ident inline-flex max-w-full min-w-0 align-bottom text-content",
        IN_ROW,
        className,
      )}
    >
      <span className="min-w-0 truncate">{first}</span>
      {hash !== "" && (
        <span className="max-w-max min-w-[1.5em] flex-1 truncate text-quiet">
          {hash}
        </span>
      )}
      <span className={cn("shrink-0 text-support", IN_ROW)}>{last}</span>
    </span>
  );
}
