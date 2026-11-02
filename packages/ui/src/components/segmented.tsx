import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";
import { Count } from "./count";
import { StatusDot } from "./status-dot";

export interface SegmentedItem<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly count?: number;
  /** A dot before the label, and the count's colour for an abnormal tone. */
  readonly tone?: Tone;
}

/**
 * One choice among a few, as one bordered control: the health filter of a
 * list, the level of a log. The picked item reads as pressed.
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
  value: V;
  onChange: (value: V) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex h-6 items-stretch overflow-hidden rounded-md text-xs shadow-[inset_0_0_0_1px_var(--border)]",
        className,
      )}
    >
      {items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => {
            onChange(item.value);
          }}
          className={cn(
            "inline-flex items-center gap-1.5 px-2 whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:shadow-[inset_var(--focus-ring)] aria-pressed:bg-row-active aria-pressed:text-foreground",
            index > 0 && "border-l border-border",
          )}
        >
          {item.tone && item.tone !== "ok" && <StatusDot tone={item.tone} />}
          {item.label}
          {item.count !== undefined && (
            <Count
              value={item.count}
              tone={item.tone === "error" && item.count > 0 ? "error" : "idle"}
            />
          )}
        </button>
      ))}
    </div>
  );
}
