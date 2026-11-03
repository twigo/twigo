import { cn } from "../lib/cn";
import { Count } from "./count";

export interface Tab<V extends string> {
  readonly value: V;
  readonly label: string;
  /** A count after the label, warning-tinted with `warn`: an object's warning events. */
  readonly count?: number;
  readonly warn?: boolean;
}

const MOVES: Readonly<
  Record<string, (index: number, count: number) => number>
> = {
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

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
        "flex h-8 shrink-0 items-stretch gap-4 px-3 text-[13px] shadow-[inset_0_-1px_0_var(--border)]",
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
            const move = MOVES[event.key];
            if (!move) return;
            event.preventDefault();
            const to = move(index, tabs.length);
            const next = tabs[to];
            if (!next) return;
            onChange(next.value);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLElement>('[role="tab"]')
              [to]?.focus();
          }}
          className="flex items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:shadow-[inset_var(--focus-ring)] aria-selected:text-foreground aria-selected:shadow-[inset_0_-2px_0_var(--foreground)]"
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span
              className={cn(
                "inline-grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px]",
                tab.warn
                  ? "bg-warn/22 text-foreground"
                  : "bg-row-active text-muted-foreground",
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
