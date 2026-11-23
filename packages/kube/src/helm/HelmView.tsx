import { useCallback, useMemo } from "react";
import { ShipWheel } from "lucide-react";
import {
  HELM_RELEASES,
  REFUSED,
  SHOWS_ROWS,
  type ListQuery,
  type Parts,
  type Row,
} from "@twigo/protocol";
import {
  DataGrid,
  EmptyState,
  StatusDot,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
} from "@twigo/workbench";
import { rowTone } from "../columns";
import { useListView } from "../list/useListView";
import { namespaceWords, whereWords } from "../list/scope";
import { helmUri } from "../uri";
import { ViewStatus } from "../ViewStatus";
import { IN_FLIGHT_RELEASE, isQuiet } from "./status";

const COLUMNS: readonly GridColumn[] = [
  { id: "release", title: "Release", width: 200, grow: true },
];

/**
 * The space's Helm releases in the side bar, one column of rows as the
 * port-forwards' view draws its own (ARCHITECTURE 4.1): a dot of the status, the
 * name, the chart and its version in the support role, and the namespace in the
 * quiet role while the scope is every namespace. It reads the list's own
 * batches. A click shows the release's editor as a preview that keeps the focus
 * where it was, and a double click keeps it.
 */
export function HelmView({ space }: { space: string }) {
  const { backend, spaces, editors } = useWorkbench();
  useChanges(spaces.changes);
  const namespaces = spaces.state(space).namespaces;
  const query: ListQuery = useMemo(
    () => ({
      space,
      gvr: HELM_RELEASES,
      namespaced: true,
      namespaces: [...namespaces],
      labelSelector: null,
      fieldSelector: null,
      owners: null,
      text: null,
      columns: null,
      sort: null,
      countBy: null,
      groupBy: null,
      values: null,
    }),
    [space, namespaces],
  );
  const { snapshot, setWindow } = useListView(backend, query);
  const register = useListRegistration({ "resource.group": "helm.sh" });
  const registerGrid = useCallback(
    (element: HTMLElement, controller: Parameters<typeof register>[1]) =>
      register(element, controller),
    [register],
  );
  const at = (name: string) =>
    snapshot.columns.findIndex((column) => column.name === name);
  const text = (row: Row, name: string) => {
    const cell = row.cells[at(name)];
    return typeof cell === "string" ? cell : "";
  };
  const open = (row: Row, keep: boolean) => {
    const name = text(row, "Name");
    editors.open(helmUri({ space, namespace: idNamespace(row), name }), {
      preview: !keep,
      preserveFocus: !keep,
    });
  };
  const ids = snapshot.ids;
  const item = (index: number): GridItem<Row, never> | undefined => {
    const id = ids[index - snapshot.start];
    const row = id === undefined ? undefined : snapshot.rows.get(id);
    return row ? { type: "row", id: row.id, data: row } : undefined;
  };
  if (REFUSED.has(snapshot.status.state)) {
    return (
      <ViewStatus
        status={snapshot.status}
        what="Helm releases"
        inline
        releases={{
          where:
            namespaces.length === 0
              ? "every namespace at once"
              : namespaces.join(", "),
        }}
      />
    );
  }
  const many = namespaces.length !== 1;
  const left = leftOut(snapshot.parts);
  const notes = left.length > 0 && (
    <div className="flex flex-none flex-col gap-1 border-t border-border-subtle px-3 py-2 text-xs text-support">
      {left.map((words) => (
        <p key={words}>{words}</p>
      ))}
    </div>
  );
  if (SHOWS_ROWS.has(snapshot.status.state) && snapshot.total === 0) {
    return (
      <>
        <EmptyState
          icon={ShipWheel}
          density="inline"
          title={`No Helm releases in ${whereWords(spaces, space, namespaces)}`}
          className="px-3"
        />
        {notes}
      </>
    );
  }
  const grid = (
    <DataGrid<Row, never>
      label="Helm releases"
      header={false}
      columns={COLUMNS}
      length={snapshot.total}
      query={JSON.stringify(query)}
      item={item}
      indexOf={(id) => {
        const at = ids.indexOf(id);
        return at < 0 ? -1 : snapshot.start + at;
      }}
      onRange={(start, end) => {
        setWindow(Math.max(0, start - 20), end + 20);
      }}
      selected={undefined}
      onSelect={() => undefined}
      onActivate={(_, row) => {
        open(row, false);
      }}
      onOpen={(_, row) => {
        open(row, true);
      }}
      loading={!SHOWS_ROWS.has(snapshot.status.state)}
      cell={(row) => {
        const tone = rowTone(HELM_RELEASES, "Status", snapshot.columns, row);
        const status = text(row, "Status");
        const chart = text(row, "Chart");
        return (
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot
              tone={tone ?? (isQuiet(status) ? "idle" : "ok")}
              pulse={IN_FLIGHT_RELEASE.test(status)}
            />
            <span className="shrink-0 text-content">{text(row, "Name")}</span>
            {chart !== "" && (
              <span className="truncate text-support">{chart}</span>
            )}
            {many && (
              <span className="ml-auto truncate pl-2 text-quiet">
                {text(row, "Namespace")}
              </span>
            )}
          </span>
        );
      }}
      register={registerGrid}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{grid}</div>
      {notes}
    </div>
  );
}

/** What the view leaves out, as the list says it: a refused namespace names the Secrets Helm keeps its releases in, and the namespaces beyond those the credentials may list are counted. */
function leftOut({ count, omitted, unready }: Parts): string[] {
  const refused = unready.flatMap(({ part, state }) =>
    part.kind === "namespace" && REFUSED.has(state.state) ? [part.name] : [],
  );
  return [
    ...(refused.length > 0
      ? [
          `These credentials may not list Secrets in ${refused.join(", ")}, which Helm keeps its releases in.`,
        ]
      : []),
    ...(omitted > 0
      ? [
          `Showing the ${namespaceWords(count)} you may list: these credentials may not list Secrets in the other ${String(omitted)}.`,
        ]
      : []),
  ];
}

/** A row's id is `context/namespace/name`, whose namespace a list of one namespace has no column for. */
function idNamespace(row: Row): string {
  const parts = row.id.split("/");
  return parts[parts.length - 2] ?? "";
}
