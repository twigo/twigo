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
  ScopeChip,
  SearchField,
  Segmented,
  StatusDot,
  TriggerButton,
  useWidth,
  type SegmentedItem,
} from "@twigo/ui";
import {
  STRIP_KEPT,
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
import { servedAs, useResources } from "../discovery";
import { kindIcon, NAMESPACES } from "../kinds";
import type { ListServices } from "../services";
import { parseListUri, type ListInput } from "../uri";
import { followTheSpace, pinOf } from "./pin";
import { SHOWS_ROWS } from "./listStatus";
import { namespacesOf, showAllNamespaces } from "./scope";
import { chipFor, stageFor, type Chip } from "./stages";

const ORDER: readonly Health[] = ["error", "warn", "ok"];

/**
 * What the actions give up as their room narrows, one more at each stage:
 * the filter field's key hint, the Group button's label, the filter field
 * for an icon button, the health filter for the choice it is on. Past the
 * last stage the scope chip gives way: it cuts its name down to the head and
 * tail it keeps, then folds to its glyph and how many more follow, then to
 * its glyph alone.
 */
const STAGES = { keys: 1, group: 2, filter: 3, health: 4 } as const;

/** The row's `gap-2`. */
const GAP = 8;

const NOTHING = () => undefined;

const NO_CHIP: Chip = {};

/** The chip at its natural size in the forms it takes, in the order `chipFor` reads them. */
const COPIES = [
  { key: "whole" },
  { key: "floor", maxWidth: 0 },
  { key: "count", fold: "count" },
  { key: "glyph", fold: "glyph" },
] as const;

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

function Scope({
  names: [first = "", ...more],
  ...props
}: {
  names: readonly string[];
  maxWidth?: number | undefined;
  fold?: Chip["fold"];
  onOpen?: (() => void) | undefined;
  clearLabel: string;
  onClear: () => void;
}) {
  return (
    <ScopeChip
      icon={kindIcon(NAMESPACES)}
      name={first}
      more={more.length}
      label={
        more.length === 0
          ? `Namespace: ${first}`
          : `Namespaces: ${[first, ...more].join(", ")}`
      }
      {...props}
    />
  );
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
  const workbench = useWorkbench();
  const { keybindings, spaces, quickAccess } = workbench;
  const { states, statuses, presets, pinned, discovery, grids } = services;
  useChanges(states.changes);
  useChanges(states.strip);
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
  const resources = useResources(discovery, input.space);
  const namespaces = namespacesOf(spaces, input);
  const several = namespaces.length > 1;
  const own = input.namespaces !== undefined;
  const scoped =
    namespaces.length > 0 &&
    resources.state === "ready" &&
    servedAs(resources.value, gvr)?.namespaced === true;

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
  // The text changes the counts: each keeps the room it took while the text
  // was empty. A list opened with a text has seen none, so its stage is held
  // while the field has the focus, below.
  useLayoutEffect(() => {
    if (text !== "" || items.length === 0) return;
    states.seeCountDigits(
      uri,
      Object.fromEntries(
        items.map(({ value, count }) => [value, String(count ?? 0).length]),
      ),
    );
  });

  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const chipBox = useRef<HTMLSpanElement>(null);
  const chipCopies = useRef<HTMLSpanElement>(null);
  // What each stage's row takes besides the scope chip, which gives way last.
  const rests = useRef<number[]>([]);
  const [stage, setStage] = useState(0);
  const [chip, setChip] = useState(NO_CHIP);
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
    scoped && namespaces,
  ]);
  const taken = useWidth(row);
  // What the last stage shows once the list shows its rows: the health
  // choice with its count's room, and the Group button.
  const last = JSON.stringify([
    current?.value,
    current && Math.max(current.digits ?? 0, String(current.count ?? 0).length),
    groupable.length > 0,
  ]);
  const lastMeasured = useRef<string>(undefined);
  const back = useRef<number>(undefined);
  // A stage's width is read as it shows, before it paints. While the field
  // or its Clear button has the focus no stage moves, since the text changes
  // the counts' width and a stage that moved would shift the field under the
  // caret, or replace it and take the focus with it. While the filter's
  // popover is open the filter stays an icon, wherever the focus is in it.
  // The last stage's width is the least a list beside docked details keeps
  // for its strip, so it is read as soon as the row shows what it will, on a
  // turn to that stage and back that never paints, once nothing in the row
  // has the focus that the turn would take.
  useLayoutEffect(() => {
    if (room === undefined || !row) return;
    const gap = scoped ? GAP : 0;
    const shown = chipBox.current?.offsetWidth ?? 0;
    rests.current[stage] = row.offsetWidth - shown - gap;
    if (stage === STAGES.health && shows) lastMeasured.current = last;
    const rest = rests.current[STAGES.health];
    const [whole = 0, floor = 0, count = 0, glyph = 0] = [
      ...(chipCopies.current?.children ?? []),
    ].map((copy) =>
      copy.firstElementChild instanceof HTMLElement
        ? copy.firstElementChild.offsetWidth
        : 0,
    );
    if (rest !== undefined) {
      states.setStripMin(uri, STRIP_KEPT + rest + gap + glyph);
    }
    const left = room - inspector - (rest ?? 0) - gap;
    setChip((was) =>
      scoped && stage === STAGES.health && rest !== undefined
        ? chipFor(
            left,
            {
              full: whole,
              floor,
              count: several ? count : undefined,
            },
            was,
          )
        : NO_CHIP,
    );
    const focused = fieldBox.current?.contains(document.activeElement) === true;
    if (back.current !== undefined) {
      setStage(back.current);
      back.current = undefined;
      return;
    }
    const busy = focused || row.contains(document.activeElement) || wanted;
    if (shows && lastMeasured.current !== last && !busy) {
      back.current = stage;
      setStage(STAGES.health);
      return;
    }
    const full = gap + whole;
    const next = stageFor(
      rests.current.map((taken) => taken + full),
      stage,
      room - inspector,
      STAGES.health,
    );
    const settled = focused
      ? stage
      : filtering
        ? Math.max(next, STAGES.filter)
        : next;
    if (settled !== stage) setStage(settled);
  }, [
    row,
    room,
    inspector,
    stage,
    taken,
    fit,
    focusMoves,
    filtering,
    shows,
    last,
    wanted,
    scoped,
    several,
    states,
    uri,
  ]);
  if (wanted && iconFilter && !filtering) setFiltering(true);
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
      className="relative flex shrink-0 items-center gap-2"
    >
      {scoped && (
        <>
          <span ref={chipBox} className="flex shrink-0">
            <Scope
              names={namespaces}
              maxWidth={chip.max}
              fold={chip.fold}
              onOpen={
                own
                  ? undefined
                  : () => {
                      quickAccess.show("ns ");
                    }
              }
              clearLabel={
                own ? "Use the space's namespaces" : "Show all namespaces"
              }
              onClear={() => {
                if (own) {
                  followTheSpace(services, workbench, uri);
                  return;
                }
                grids.focus(uri);
                showAllNamespaces(spaces, input.space);
              }}
            />
          </span>
          <span
            ref={chipCopies}
            aria-hidden
            inert
            className="invisible absolute top-0 left-0 h-0 overflow-hidden"
          >
            {COPIES.map(({ key, ...form }) => (
              <span key={key} className="flex">
                <Scope
                  names={namespaces}
                  clearLabel=""
                  onClear={NOTHING}
                  {...form}
                />
              </span>
            ))}
          </span>
        </>
      )}
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
