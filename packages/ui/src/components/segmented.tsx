import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";
import { Count } from "./count";
import { StatusDot } from "./status-dot";

export interface SegmentedItem<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly count?: number;
  /** The digits its count keeps room for: `Count`'s `digits`. */
  readonly digits?: number;
  /** A dot before the label, and the count's colour for an abnormal tone. */
  readonly tone?: Tone;
}

/**
 * One choice among a few, as plates on one track: the health filter of a
 * list, the level of a log. The picked plate reads as pressed.
 */
export function Segmented<V extends string>({
  label,
  items,
  value,
  onChange,
  className,
}: {
  label: string;
  items: readonly SegmentedItem<V>[];
  value: V | undefined;
  onChange: (value: V) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex h-6 items-stretch rounded-md bg-well p-0.5 text-xs",
        className,
      )}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => {
            onChange(item.value);
          }}
          className="inline-flex items-center gap-1.5 rounded-sm px-2 whitespace-nowrap text-support outline-none not-aria-pressed:hover:text-content focus-visible:shadow-[inset_var(--focus-ring)] aria-pressed:bg-plate aria-pressed:text-strong"
        >
          {item.tone && item.tone !== "ok" && <StatusDot tone={item.tone} />}
          {item.label}
          {item.count !== undefined && (
            <Count
              value={item.count}
              tone={item.tone === "error" && item.count > 0 ? "error" : "idle"}
              digits={item.digits}
            />
          )}
        </button>
      ))}
    </div>
  );
}
