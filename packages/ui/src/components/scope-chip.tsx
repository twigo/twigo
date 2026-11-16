import { X, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { CutInTheMiddle } from "./cut-in-the-middle";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const NAME_FLOOR = 16;

const PART =
  "flex h-5 items-center rounded-sm outline-none focus-visible:shadow-[var(--focus-ring)]";

/**
 * What a view is narrowed to, as a chip with a close mark that takes the
 * narrowing off: the glyph of what it narrows by, the first name cut in the
 * middle, and how many more follow it. A chip with no `onOpen` is a label
 * and its mark. `maxWidth` is the room its owner leaves it; it never gives
 * way below what holds a name's head and tail and the two marks.
 */
export function ScopeChip({
  icon: Icon,
  name,
  more = 0,
  label,
  onOpen,
  clearLabel,
  onClear,
  maxWidth,
}: {
  icon: LucideIcon;
  name: string;
  more?: number;
  /** All the names, which is the chip's accessible name and its tooltip. */
  label: string;
  onOpen?: () => void;
  clearLabel: string;
  onClear: () => void;
  maxWidth?: number;
}) {
  const face = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-support" />
      <CutInTheMiddle text={name} floor={NAME_FLOOR} separator="-" />
      {more > 0 && (
        <span className="shrink-0 font-normal text-support tabular-nums">
          +{more}
        </span>
      )}
    </>
  );
  const body = cn(PART, "min-w-0 gap-1.5 px-1.5 font-semibold text-content");
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
            <span role="group" aria-label={label} className={body}>
              {face}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent className="wrap-anywhere">{label}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className={cn(
          PART,
          "size-5 shrink-0 justify-center text-support hover:bg-row-hover hover:text-content",
        )}
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}
