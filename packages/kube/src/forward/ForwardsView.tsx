import { useCallback } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { Forward } from "@twigo/protocol";
import {
  DataGrid,
  EmptyState,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
} from "@twigo/workbench";
import { pfUri } from "../uri";
import { ForwardLine } from "./ForwardLine";
import { forwardKeys, withForward } from "./keys";
import type { Forwards } from "./service";
import { stateOf } from "./words";

const COLUMNS: readonly GridColumn[] = [
  { id: "forward", title: "Port forward", width: 120, grow: true },
];

/**
 * The space's port-forwards (ARCHITECTURE 4.1, 4.6) in a grid driven by the
 * list service: Enter opens a forward's tab, and its menu and keys act on
 * the selected row.
 */
export function ForwardsView({ forwards }: { forwards: Forwards }) {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  if (!space) return null;
  return <SpaceForwards key={space.id} forwards={forwards} space={space.id} />;
}

function SpaceForwards({
  forwards,
  space,
}: {
  forwards: Forwards;
  space: string;
}) {
  const workbench = useWorkbench();
  const { editors, keys, menus } = workbench;
  useChanges(forwards.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  const rows = forwards.ofSpace(space);
  const selectedId = forwards.selected(space);
  const selected =
    selectedId === undefined ? undefined : forwards.get(selectedId);
  const keysOfRow = JSON.stringify(selected ? forwardKeys(selected) : {});
  const register = useListRegistration({
    forwardsFocus: true,
    ...(JSON.parse(keysOfRow) as Record<string, boolean>),
  });

  const item = (index: number): GridItem<Forward, never> | undefined => {
    const forward = rows[index];
    if (!forward) return undefined;
    const { tone } = stateOf(forward);
    return {
      type: "row",
      id: String(forward.id),
      data: forward,
      ...((tone === "error" || tone === "warn") && { tone }),
    };
  };
  const onRange = useCallback(() => undefined, []);
  const lookup = selected && withForward(keys.lookup(null), selected);

  return (
    <DataGrid<Forward, never>
      label="Port forwards"
      header={false}
      columns={COLUMNS}
      length={rows.length}
      query={space}
      item={item}
      indexOf={(id) => rows.findIndex((forward) => String(forward.id) === id)}
      onRange={onRange}
      cell={(forward) => <ForwardLine forward={forward} />}
      selected={selectedId === undefined ? undefined : String(selectedId)}
      onSelect={(_, forward) => {
        forwards.select(space, forward.id);
      }}
      onActivate={(_, forward) => {
        editors.open(pfUri({ space, id: forward.id }), {
          preview: true,
          preserveFocus: true,
        });
      }}
      menu={workbench.actions(
        "view/item",
        lookup ?? keys.lookup(null),
        selected && { id: selected.id },
      )}
      loading={!forwards.loaded}
      empty={
        <EmptyState
          icon={ArrowLeftRight}
          title="No port forwards"
          className="py-16"
        >
          <p>
            Select a pod, a Service or a workload and press f to forward a port
            of it to this machine.
          </p>
        </EmptyState>
      }
      register={register}
    />
  );
}
