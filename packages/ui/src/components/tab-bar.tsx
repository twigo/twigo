import { cn } from "../lib/cn";
import { rovingMove } from "../lib/roving";
import { Count } from "./count";

export interface Tab<V extends string> {
  readonly value: V;
  readonly label: string;
  /** A count after the label, warning-tinted with `warn`: an object's warning events. */
  readonly count?: number;
  readonly warn?: boolean;
}

/**
 * The views of a panel as underlined tabs, the shown one underlined. Tab
 * reaches the shown one, and the keys move between them as the WAI-ARIA
 * tabs pattern has it, showing the tab they reach.
 */
export function TabBar<V extends string>({
  label,
  tabs,
  value,
  onChange,
  className,
}: {
  label: string;
  tabs: readonly Tab<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex h-8 shrink-0 items-stretch gap-4 px-3 text-body shadow-[inset_0_-1px_0_var(--border)]",
        className,
      )}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          tabIndex={tab.value === value ? 0 : -1}
          onClick={() => {
            onChange(tab.value);
          }}
          onKeyDown={(event) => {
            const to = rovingMove(event.key, index, tabs.length);
            if (to === undefined) return;
            event.preventDefault();
            const next = tabs[to];
            if (!next) return;
            onChange(next.value);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLElement>('[role="tab"]')
              [to]?.focus();
          }}
          className="flex items-center gap-1.5 text-support outline-none hover:text-content focus-visible:shadow-[inset_var(--focus-ring)] aria-selected:text-content aria-selected:shadow-[inset_0_-2px_0_var(--content)]"
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span
              className={cn(
                "inline-grid h-4 min-w-4 place-items-center rounded-full px-1 text-2xs",
                tab.warn
                  ? "bg-warn/22 text-content"
                  : "bg-row-active text-support",
              )}
            >
              <Count value={tab.count} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
