import { useEffect, useRef } from "react";
import { ListTree, Pin, PinOff } from "lucide-react";
import {
  ActionDropdown,
  IconButton,
  SearchField,
  Segmented,
  type SegmentedItem,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";
import {
  byHealth,
  columnRule,
  HEALTH,
  healthValues,
  statusColumn,
  type Health,
} from "../columns";
import type { ListServices } from "../services";
import { parseListUri } from "../uri";
import { pinOf } from "./pin";
import { SHOWS_ROWS } from "./listStatus";

const ORDER: readonly Health[] = ["error", "warn", "ok"];

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
  const { keybindings, spaces } = useWorkbench();
  const { states, statuses, presets, pinned } = services;
  useChanges(states.changes);
  useChanges(statuses.changes);
  useChanges(presets.changes);
  useChanges(pinned.changes);
  useChanges(keybindings.changes);
  useChanges(spaces.changes);
  const input = parseListUri(uri);
  const list = statuses.get(uri);
  const field = useRef<HTMLInputElement>(null);
  const wanted = states.wantsFocus(uri);
  useEffect(() => {
    if (!wanted) return;
    field.current?.focus();
    states.focused(uri);
  }, [wanted, states, uri]);
  if (!input) return null;
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

  const items: SegmentedItem<Health | "all">[] = counts
    ? [
        {
          value: "all",
          label: "All",
          // Counts come before the health filter, so they sum to every row.
          count: counts.ok.count + counts.warn.count + counts.error.count,
        },
        ...ORDER.map((health) => ({
          value: health,
          label: HEALTH[health].title,
          count: counts[health].count,
          ...(health !== "ok" && { tone: health }),
        })),
      ]
    : [];

  return (
    <div className="flex items-center gap-2">
      {shows && counts && (
        <Segmented
          label="Rows by health"
          items={items}
          value={picked ?? "all"}
          onChange={(value) => {
            states.setHealth(
              uri,
              value === "all"
                ? null
                : { health: value, values: healthValues(counts[value]) },
            );
          }}
        />
      )}
      <SearchField
        label="Filter rows"
        placeholder="Filter, !not, /regex/"
        value={states.text(uri) ?? input.text ?? ""}
        onChange={(text) => {
          states.setText(uri, text);
        }}
        {...(find && { keys: keybindings.label(find.presses) })}
        inputRef={field}
        className="w-58"
      />
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
          <button
            type="button"
            className="inline-flex h-6.5 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-row-hover hover:text-foreground focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-hover"
          >
            <ListTree aria-hidden className="size-3.5" />
            {groupable.some((candidate) => candidate.name === preset.group)
              ? preset.group
              : "Group"}
          </button>
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
