import { cn } from "@twigo/ui";
import { splitName } from "./names";

const IN_ROW =
  "in-[[role=row][data-cursor]]:text-strong in-[[role=row][aria-selected=true]]:text-strong";

/**
 * A name as a list draws it and the details title it: the part before the
 * generated one in content, the hash quiet, the last segment in support.
 * A name that does not fit gives up the hash first, to an ellipsis, then
 * the end of its first part, and never the last segment. In the row under
 * the cursor and in a selected one the name is strong. `least` draws it as
 * narrow as the hash gives way, which a part that measures it for a stage
 * sets in a box of its natural width.
 */
export function ObjectName({
  name,
  generated,
  className,
  title,
  least = false,
}: {
  name: string;
  generated: number | null;
  className?: string;
  title?: string | undefined;
  least?: boolean;
}) {
  const { first, hash, last } = splitName(name, generated);
  if (last === "") {
    return (
      <span
        title={title}
        className={cn("ident min-w-0 truncate text-content", IN_ROW, className)}
      >
        {name}
      </span>
    );
  }
  return (
    <span
      title={title}
      className={cn(
        "ident inline-flex max-w-full min-w-0 align-bottom text-content",
        IN_ROW,
        className,
      )}
    >
      <span className="min-w-0 truncate">{first}</span>
      {hash !== "" && (
        <span
          className={cn(
            "max-w-max min-w-[1.5em] flex-1 truncate text-quiet",
            least && "w-[1.5em] flex-none",
          )}
        >
          {hash}
        </span>
      )}
      <span className={cn("shrink-0 text-support", IN_ROW)}>{last}</span>
    </span>
  );
}
