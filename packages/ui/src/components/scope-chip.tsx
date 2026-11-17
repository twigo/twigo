import { X, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { CutInTheMiddle } from "./cut-in-the-middle";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const NAME_FLOOR = 16;

const PART =
  "flex h-5 items-center rounded-sm outline-none focus-visible:shadow-[var(--focus-ring)]";

/**
 * What a view is narrowed to, as a chip: the glyph of what it narrows by, the
 * first name cut in the middle, and how many more follow it. With `onOpen` a
 * click on it acts, and with `clear` a close mark takes the narrowing off.
 * A chip with neither is a label and one tab stop, its tooltip shown on focus
 * as on hover. `maxWidth` is the room its owner leaves it; it cuts the name
 * down to what holds its head and tail and the marks, and no further. Past
 * that its owner folds it: `count` keeps the glyph and how many more follow,
 * `glyph` the glyph alone, and either leaves the name and the close mark out.
 */
export function ScopeChip({
  icon: Icon,
  name,
  more = 0,
  label,
  tooltip = label,
  onOpen,
  clear,
  maxWidth,
  fold,
}: {
  icon: LucideIcon;
  name: string;
  more?: number;
  /** The chip's accessible name. */
  label: string;
  /** What hover and focus show: all the names. */
  tooltip?: string;
  onOpen?: () => void;
  clear?: { label: string; run: () => void };
  maxWidth?: number;
  fold?: "count" | "glyph";
}) {
  const face = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-support" />
      {fold === undefined && (
        <CutInTheMiddle text={name} floor={NAME_FLOOR} separator="-" />
      )}
      {more > 0 && fold !== "glyph" && (
        <span className="shrink-0 font-normal text-support tabular-nums">
          +{more}
        </span>
      )}
    </>
  );
  const body = cn(
    PART,
    "min-w-0 gap-1.5 font-semibold text-content",
    fold === "glyph" ? "w-5 justify-center" : "px-1.5",
  );
  return (
    <span
      style={{ maxWidth }}
      className="inline-flex h-6 min-w-min shrink-0 items-center gap-0.5 rounded-md bg-row-active p-0.5 text-xs"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          {onOpen ? (
            <button
              type="button"
              aria-label={label}
              onClick={onOpen}
              className={cn(body, "hover:bg-row-hover")}
            >
              {face}
            </button>
          ) : (
            <span role="group" tabIndex={0} aria-label={label} className={body}>
              {face}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent className="wrap-anywhere">{tooltip}</TooltipContent>
      </Tooltip>
      {fold === undefined && clear && (
        <button
          type="button"
          aria-label={clear.label}
          onClick={clear.run}
          className={cn(
            PART,
            "size-5 shrink-0 justify-center text-support hover:bg-row-hover hover:text-content",
          )}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </span>
  );
}
