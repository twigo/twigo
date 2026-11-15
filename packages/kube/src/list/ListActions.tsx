import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ListFilter, ListTree, Pin, PinOff } from "lucide-react";
import {
  ActionDropdown,
  cn,
  Count,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchField,
  Segmented,
  StatusDot,
  TriggerButton,
  useWidth,
  type SegmentedItem,
} from "@twigo/ui";
import {
  TABS_KEPT,
  useActionRoom,
  useChanges,
  useWorkbench,
} from "@twigo/workbench";
import {
  byHealth,
  columnRule,
  HEALTH,
  healthValues,
  statusColumn,
  type Health,
} from "../columns";
import type { ListServices } from "../services";
import { parseListUri, type ListInput } from "../uri";
import { pinOf } from "./pin";
import { SHOWS_ROWS } from "./listStatus";
import { stageFor } from "./stages";

const ORDER: readonly Health[] = ["error", "warn", "ok"];

/**
 * What the actions give up as their room narrows, one more at each stage:
 * the filter field's key hint, the Group button's label, the filter field
 * for an icon button, the health filter for the choice it is on.
 */
const STAGES = { keys: 1, group: 2, filter: 3, health: 4 } as const;

const ICON_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-support outline-none hover:bg-row-hover hover:text-content focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-hover";

/**
 * What a list editor shows at the right of its group's tab strip
 * (ARCHITECTURE 4.4): its health as one control, its text filter, its
 * grouping, and the pin that keeps it in the explorer.
 */
export function ListActions({
  uri,
  services,
}: {
  uri: string;
  services: ListServices;
}) {
  const input = parseListUri(uri);
  if (!input) return null;
  return <Actions uri={uri} input={input} services={services} />;
}

function Actions({
  uri,
  input,
  services,
}: {
  uri: string;
  input: ListInput;
  services: ListServices;
}) {
  const { keybindings, spaces } = useWorkbench();
  const { states, statuses, presets, pinned } = services;
  useChanges(states.changes);
  useChanges(statuses.changes);
  useChanges(presets.changes);
  useChanges(pinned.changes);
  useChanges(keybindings.changes);
  useChanges(spaces.changes);
  const list = statuses.get(uri);
  const field = useRef<HTMLInputElement>(null);
  const fieldBox = useRef<HTMLDivElement>(null);
  const wanted = states.wantsFocus(uri);
  const room = useActionRoom();
  const inspector = states.inspector(uri);
  const { gvr } = input;
  const column = statusColumn(gvr);
  const shows = list !== undefined && SHOWS_ROWS.has(list.status.state);
  const counts = column && list && byHealth(gvr, column, list.counts);
  const health = states.health(uri);
  const picked = health === null ? undefined : (health?.health ?? input.health);
  const preset = presets.get(gvr);
  const groupable = (list?.columns ?? []).filter(
    (candidate) => columnRule(gvr, candidate).groups,
  );
  const find = keybindings.primary("list.find");
  const pin = pinOf(services, spaces, uri);
  const isPinned = pin !== undefined && pinned.has(input.space, pin.uri);

  const digits = states.countDigits(uri);
  const items: SegmentedItem<Health | "all">[] = counts
    ? [
        {
          value: "all",
          label: "All",
          // Counts come before the health filter, so they sum to every row.
          count: counts.ok.count + counts.warn.count + counts.error.count,
          digits: digits.all,
        },
        ...ORDER.map((health) => ({
          value: health,
          label: HEALTH[health].title,
          count: counts[health].count,
          digits: digits[health],
          ...(health !== "ok" && { tone: health }),
        })),
      ]
    : [];
  const choose = (value: Health | "all") => {
    if (!counts) return;
    states.setHealth(
      uri,
      value === "all"
        ? null
        : { health: value, values: healthValues(counts[value]) },
    );
  };
  const text = states.text(uri) ?? input.text ?? "";
  const current = items.find((item) => item.value === (picked ?? "all"));
  // The text changes the counts: each keeps the room it took without one, so
  // the text moves neither the actions' width nor their stage.
  useLayoutEffect(() => {
    if (text !== "" || items.length === 0) return;
    states.seeCountDigits(
      uri,
      Object.fromEntries(
        items.map(({ value, count }) => [
          value,
          (count ?? 0).toLocaleString("en").length,
        ]),
      ),
    );
  });

  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const needs = useRef<number[]>([]);
  const [stage, setStage] = useState(0);
  const [filtering, setFiltering] = useState(false);
  const [focusMoves, setFocusMoves] = useState(0);
  const iconFilter = stage >= STAGES.filter;
  // What besides the stage and the room changes the row's width: a count
  // gaining a digit, the choice the health filter names, the grouping the
  // Group button names.
  const fit = JSON.stringify([
    items.map(({ count }) => String(count ?? 0).length),
    digits,
    current?.value,
    preset.group,
    groupable.length > 0,
  ]);
  const taken = useWidth(row);
  // A stage's width is read as it shows, before it paints. While the field
  // or its Clear button has the focus the filter stays as it is, an icon or
  // the field, since the other would replace it and take the focus with it.
  useLayoutEffect(() => {
    if (room === undefined || !row) return;
    needs.current[stage] = row.offsetWidth;
    const widest = needs.current[STAGES.health];
    if (widest !== undefined) states.setStripMin(uri, TABS_KEPT + widest);
    const focused = fieldBox.current?.contains(document.activeElement) === true;
    const next = stageFor(
      needs.current,
      stage,
      room - inspector,
      STAGES.health,
    );
    const settled = !focused
      ? next
      : stage >= STAGES.filter
        ? Math.max(next, STAGES.filter)
        : Math.min(next, STAGES.filter - 1);
    if (settled !== stage) setStage(settled);
  }, [row, room, inspector, stage, taken, fit, focusMoves, states, uri]);
  if (wanted && iconFilter && !filtering) setFiltering(true);
  if (!iconFilter && filtering) setFiltering(false);
  useEffect(() => {
    if (!wanted) return;
    if (!iconFilter) field.current?.focus();
    states.focused(uri);
  }, [wanted, iconFilter, states, uri]);

  const filter = (inPopover: boolean) => (
    <div ref={fieldBox} className="contents">
      <SearchField
        label="Filter rows"
        placeholder="Filter, !not, /regex/"
        value={text}
        onChange={(next) => {
          states.setText(uri, next);
        }}
        {...(inPopover && {
          onEnter: () => {
            setFiltering(false);
          },
        })}
        {...(find &&
          stage < STAGES.keys && { keys: keybindings.label(find.presses) })}
        inputRef={field}
        className={inPopover ? "w-full" : "w-58"}
      />
    </div>
  );

  return (
    <div
      ref={setRow}
      style={{ marginRight: inspector }}
      onFocus={() => {
        setFocusMoves((moves) => moves + 1);
      }}
      onBlur={() => {
        setFocusMoves((moves) => moves + 1);
      }}
      className="flex shrink-0 items-center gap-2"
    >
      {shows &&
        counts &&
        current &&
        (stage < STAGES.health ? (
          <Segmented
            label="Rows by health"
            items={items}
            value={picked ?? "all"}
            onChange={choose}
          />
        ) : (
          <ActionDropdown
            label="Rows by health"
            actions={[
              items.map((item) => ({
                id: item.value,
                label: `${item.label} ${(item.count ?? 0).toLocaleString("en")}`,
                checked: item.value === current.value,
                run: () => {
                  choose(item.value);
                },
              })),
            ]}
          >
            <TriggerButton>
              {current.tone && current.tone !== "ok" && (
                <StatusDot tone={current.tone} />
              )}
              {current.label}
              <Count
                value={current.count ?? 0}
                digits={current.digits}
                tone={
                  current.tone === "error" && (current.count ?? 0) > 0
                    ? "error"
                    : "idle"
                }
              />
              <ChevronDown aria-hidden className="size-3 text-support" />
            </TriggerButton>
          </ActionDropdown>
        ))}
      {iconFilter ? (
        <Popover open={filtering} onOpenChange={setFiltering}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Filter rows"
              className={cn(
                ICON_BUTTON,
                text !== "" && "bg-row-active text-content",
              )}
            >
              <ListFilter aria-hidden className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-64 p-1.5"
            onEscapeKeyDown={(event) => {
              if (text !== "") event.preventDefault();
            }}
          >
            {filter(true)}
          </PopoverContent>
        </Popover>
      ) : (
        filter(false)
      )}
      {groupable.length > 0 && (
        <ActionDropdown
          label="Group rows"
          title="Group by"
          actions={[
            [
              {
                id: "none",
                label: "None",
                checked: preset.group === undefined,
                run: () => {
                  presets.groupBy(gvr, undefined);
                },
              },
              ...groupable.map((candidate) => ({
                id: candidate.name,
                label: candidate.name,
                checked: preset.group === candidate.name,
                run: () => {
                  presets.groupBy(gvr, candidate.name);
                },
              })),
            ],
          ]}
        >
          {stage < STAGES.group ? (
            <button
              type="button"
              className="inline-flex h-6.5 items-center gap-1.5 rounded-md px-2 text-xs text-support outline-none hover:bg-row-hover hover:text-content focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-hover"
            >
              <ListTree aria-hidden className="size-3.5" />
              {groupable.some((candidate) => candidate.name === preset.group)
                ? preset.group
                : "Group"}
            </button>
          ) : (
            <button
              type="button"
              className={cn(
                ICON_BUTTON,
                preset.group !== undefined && "bg-row-active text-content",
              )}
            >
              <ListTree aria-hidden className="size-3.5" />
            </button>
          )}
        </ActionDropdown>
      )}
      <IconButton
        icon={isPinned ? PinOff : Pin}
        label={isPinned ? "Unpin from the explorer" : "Pin to the explorer"}
        pressed={isPinned}
        onClick={() => {
          if (!pin) return;
          if (isPinned) pinned.unpin(input.space, pin.uri);
          else pinned.pin(input.space, pin);
        }}
      />
    </div>
  );
}
