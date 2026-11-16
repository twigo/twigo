import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn";
import { rovingMove } from "../lib/roving";
import { useWidth } from "../lib/useWidth";
import { Count } from "./count";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export interface Tab<V extends string> {
  readonly value: V;
  readonly label: string;
  /** A count after the label, with a warning mark and the warning tone when `warn`: an object's warning events. */
  readonly count?: number;
  readonly warn?: boolean;
}

const PLATE =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-body whitespace-nowrap outline-none focus-visible:shadow-[var(--focus-ring)]";

/** Below this much spare width a row keeps the fold it narrowed to, so that a width on a boundary does not flicker. */
const MARGIN = 16;

function foldedAt(
  count: number,
  active: number,
  total: number,
): ReadonlySet<number> {
  const folded = new Set<number>();
  for (let index = total - 1; index >= 0 && folded.size < count; index--)
    if (index !== active) folded.add(index);
  return folded;
}

/**
 * How many tabs fold into More at `width` from `current`, where `needs`
 * holds the width the row takes at each fold: the fewest that fits, and
 * fewer than `current` only with `MARGIN` to spare. A fold takes more than
 * the one before it when More is wider than the one tab it holds. Until the
 * row and every fold are measured it keeps `current`.
 */
function fitFold(
  width: number,
  needs: readonly number[],
  current: number,
): number {
  if (width <= 0 || needs.some((need) => need <= 0)) return current;
  const fits = needs.findIndex(
    (need, count) => need + (count < current ? MARGIN : 0) <= width,
  );
  return fits < 0 ? needs.length - 1 : fits;
}

function Face<V extends string>({ tab }: { tab: Tab<V> }) {
  return (
    <>
      {tab.label}
      {tab.count !== undefined && tab.count > 0 && (
        <span className="inline-flex items-center gap-1 text-label">
          {tab.warn && (
            <TriangleAlert
              role="img"
              aria-label="Warnings"
              className="size-3 text-warn-foreground"
            />
          )}
          <Count value={tab.count} tone={tab.warn ? "warn" : "quiet"} />
        </span>
      )}
    </>
  );
}

const MORE_PLATE = cn(
  PLATE,
  "text-support hover:bg-row-hover data-[state=open]:bg-row-hover",
);

function MoreFace({ warns }: { warns: boolean }) {
  return (
    <>
      More
      {warns && (
        <TriangleAlert aria-hidden className="size-3 text-warn-foreground" />
      )}
      <ChevronDown aria-hidden className="size-3.5" />
    </>
  );
}

/** A copy of the row at one fold, out of sight, whose width says what that fold takes. */
function Measured({
  stage,
  onMeasure,
  children,
}: {
  stage: number;
  onMeasure: (stage: number, width: number) => void;
  children: ReactNode;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const width = useWidth(element);
  useEffect(() => {
    onMeasure(stage, width);
  }, [onMeasure, stage, width]);
  return (
    <div
      ref={setElement}
      data-stage={stage}
      className="flex w-max items-center gap-0.5"
    >
      {children}
    </div>
  );
}

/**
 * The views of a panel as plates in a 32 px row: the shown one filled, the
 * others bare until hovered. Tab reaches the shown one, and the keys move
 * between the tabs as the WAI-ARIA tabs pattern has it, showing the tab they
 * reach. As the row narrows the last tabs fold into More, which opens them
 * as a menu; the shown tab never folds.
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
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const width = useWidth(row);
  const [needs, setNeeds] = useState<Readonly<Record<number, number>>>({});
  const onMeasure = useCallback((stage: number, need: number) => {
    setNeeds((was) => (was[stage] === need ? was : { ...was, [stage]: need }));
  }, []);
  const active = tabs.findIndex((tab) => tab.value === value);
  const stages = tabs.map((_, stage) => stage);
  const [count, setCount] = useState(0);
  const fitted = fitFold(
    width,
    stages.map((stage) => needs[stage] ?? 0),
    count,
  );
  if (fitted !== count) setCount(fitted);
  const folded = foldedAt(fitted, active, tabs.length);
  const shown = tabs.filter((_, index) => !folded.has(index));
  const hidden = tabs.filter((_, index) => folded.has(index));
  const picked = useRef(false);
  const moreViews = `More ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  const warns = (at: ReadonlySet<number>) =>
    tabs.some(
      (tab, index) =>
        at.has(index) && tab.warn === true && (tab.count ?? 0) > 0,
    );

  return (
    <div
      ref={setRow}
      className={cn(
        "relative flex h-8 shrink-0 items-center gap-0.5 px-1.5",
        className,
      )}
    >
      <div role="tablist" aria-label={label} className="flex gap-0.5">
        {shown.map((tab, index) => (
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
              const to = rovingMove(event.key, index, shown.length);
              if (to === undefined) return;
              event.preventDefault();
              const next = shown[to];
              if (!next) return;
              onChange(next.value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLElement>('[role="tab"]')
                [to]?.focus();
            }}
            className={cn(
              PLATE,
              "text-support hover:bg-row-hover aria-selected:bg-row-active aria-selected:text-content",
            )}
          >
            <Face tab={tab} />
          </button>
        ))}
      </div>
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                warns(folded) ? `${moreViews}, with warnings` : moreViews
              }
              className={MORE_PLATE}
            >
              <MoreFace warns={warns(folded)} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            onCloseAutoFocus={(event) => {
              if (!picked.current) return;
              picked.current = false;
              event.preventDefault();
              row
                ?.querySelector<HTMLElement>(
                  '[role="tab"][aria-selected="true"]',
                )
                ?.focus();
            }}
          >
            {hidden.map((tab) => (
              <DropdownMenuItem
                key={tab.value}
                onSelect={() => {
                  picked.current = true;
                  onChange(tab.value);
                }}
              >
                <Face tab={tab} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div
        aria-hidden
        className="invisible absolute top-0 left-0 h-0 overflow-hidden"
      >
        {stages.map((stage) => {
          const away = foldedAt(stage, active, tabs.length);
          return (
            <Measured key={stage} stage={stage} onMeasure={onMeasure}>
              {tabs.map(
                (tab, index) =>
                  !away.has(index) && (
                    <span key={tab.value} className={PLATE}>
                      <Face tab={tab} />
                    </span>
                  ),
              )}
              {away.size > 0 && (
                <span className={MORE_PLATE}>
                  <MoreFace warns={warns(away)} />
                </span>
              )}
            </Measured>
          );
        })}
      </div>
    </div>
  );
}
