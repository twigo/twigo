import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Copy, SquareArrowOutUpRight, X } from "lucide-react";
import type { ObjectQuery, ObjectRef, Row } from "@twigo/protocol";
import { ActionRow, cn, IconButton, PropertyList } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { useChanges, useWorkbench } from "@twigo/workbench";
import { columnRule } from "./columns";
import { useResources } from "./discovery";
import { measureText } from "./list/metrics";
import { noContainerRuns } from "./object/noContainerRuns";
import { ObjectHeader } from "./object/ObjectHeader";
import { LABEL_COLUMN, ObjectContent } from "./object/ObjectContent";
import { ObjectViews } from "./object/ObjectViews";
import { Vitals } from "./object/Vitals";
import { useHeader } from "./object/useHeader";
import { useReveal } from "./object/reveal";
import { hasUsage } from "./object/figures";
import { OBJECT_FILTERED, OBJECT_URI, useFiltered } from "./object/pageStates";
import { refResource, refUri, useObject } from "./object/useObject";
import { objectOf, type Selected } from "./selection";
import type { ListServices } from "./services";
import { isTabular } from "./tabular";
import { objectUri } from "./uri";
import { useNow } from "./useNow";
import { useVisible } from "./useVisible";
import { ViewStatus } from "./ViewStatus";

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 470;

/** How long the selection rests on a row before its object opens (ARCHITECTURE 4.3). */
export const DWELL_MS = 150;

/**
 * A row's details (ARCHITECTURE 4.3): beside the list as an inspector,
 * or over it where the editor is too narrow, as Lens's drawer. Once the
 * selection rests on the row its object opens and follows its changes;
 * until then the row's cells stand in. A header says what it is, its
 * state and owner, then the commands of `resource/details`, then the
 * object's views as tabs. Its left edge resizes it.
 */
export function Details({
  uri,
  selected,
  space,
  services,
  docked,
  onOpen,
  onClose,
}: {
  /** The list editor the row is in. */
  uri: string;
  selected: Selected;
  space: string;
  services: ListServices;
  /** Beside the list rather than over it. */
  docked: boolean;
  /** Opens an object's editor beside the list. */
  onOpen: (uri: string) => void;
  onClose: () => void;
}) {
  const workbench = useWorkbench();
  const { backend, keys, menus, sizes } = workbench;
  const { discovery, selection, states } = services;
  useChanges(states.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  useChanges(sizes.changes);
  const resources = useResources(discovery, space);
  const [dragged, setDragged] = useState<number>();
  const width =
    dragged ?? Math.max(MIN_WIDTH, sizes.get("inspector") ?? DEFAULT_WIDTH);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const { gvr, kind, namespaced, row } = selected;
  const { namespace, name } = objectOf(selected);
  const { group, version, resource } = gvr;
  const query: ObjectQuery = useMemo(
    () => ({
      space,
      gvr: { group, version, resource },
      namespaced,
      namespace: namespace ?? null,
      name,
    }),
    [space, group, version, resource, namespaced, namespace, name],
  );
  const [rested, setRested] = useState<ObjectQuery | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => {
      setRested(query);
    }, DWELL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);
  const tab = states.detailsTab(uri);
  const visible = useVisible();
  const asked = tab === "overview" && visible && hasUsage(gvr);
  const { snapshot, values, id } = useObject(
    backend,
    rested === query ? query : undefined,
    {
      overview: true,
      manifest: tab === "yaml",
      events: tab === "events",
      related: tab === "related",
      usage: asked,
    },
  );
  const reveal = useReveal(id);
  const open = (target: ObjectRef) => {
    if (resources.state !== "ready") return;
    const next = refUri(space, resources.value, target);
    if (next) onOpen(next);
  };
  const header = snapshot.overview?.header;
  const owner = header?.owner ?? undefined;
  const ownerGvr =
    owner && resources.state === "ready"
      ? refResource(resources.value, owner)?.gvr
      : undefined;
  const cellOf = (column: string) => {
    const cell =
      row.cells[selected.columns.findIndex((c) => c.name === column)];
    return typeof cell === "string" ? cell : undefined;
  };
  const { verdict, strip, line } = useHeader({
    gvr,
    header,
    usage: snapshot.usage,
    row: cellOf,
  });
  const idle = noContainerRuns(snapshot.overview);
  const page = tab === "overview";
  const filtered = useFiltered(services.pages, uri) && page;
  useEffect(() => {
    if (!element) return;
    const scope = keys.scope(element);
    scope.set("resource.noContainerRuns", idle);
    scope.set("pageFocus", page);
    scope.set(OBJECT_URI, page ? uri : undefined);
    scope.set(OBJECT_FILTERED, filtered);
    return () => {
      scope.dispose();
    };
  }, [keys, element, idle, page, filtered, uri]);
  const now = useNow();
  const lookup = keys.lookup(element);
  const measured = useSyncExternalStore(selection.watch, () =>
    selection.get(uri),
  );
  const cells = measured?.row.id === row.id ? measured.row : row;

  return (
    <aside
      ref={setElement}
      aria-label={`${kind} details`}
      style={{ width, ...(docked && { minWidth: MIN_WIDTH }) }}
      className={cn(
        "flex h-full max-w-[85%] flex-col border-l border-border bg-editor",
        docked
          ? "relative"
          : "absolute inset-y-0 right-0 z-10 animate-in shadow-lg animation-duration-150 slide-in-from-right-8",
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details"
        onPointerDown={(event) => {
          event.preventDefault();
          const start = event.clientX;
          const from = element?.getBoundingClientRect().width ?? width;
          const target = event.currentTarget;
          let moved = false;
          target.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) => {
            moved = true;
            setDragged(
              Math.round(Math.max(MIN_WIDTH, from + start - next.clientX)),
            );
          };
          target.addEventListener("pointermove", move);
          target.addEventListener(
            "pointerup",
            () => {
              target.removeEventListener("pointermove", move);
              if (moved && element)
                sizes.set(
                  "inspector",
                  Math.round(element.getBoundingClientRect().width),
                );
              setDragged(undefined);
            },
            { once: true },
          );
        }}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
      />
      <ObjectHeader
        gvr={gvr}
        kind={kind}
        name={name}
        generated={row.generated}
        controls={
          <>
            <IconButton
              icon={Copy}
              label="Copy Name"
              onClick={() => {
                void workbench.commands.execute(
                  "k8s.resource.copyName",
                  lookup,
                );
              }}
            />
            <IconButton
              icon={SquareArrowOutUpRight}
              label="Open in an editor"
              onClick={() => {
                onOpen(
                  objectUri({
                    space,
                    gvr,
                    ...(namespace !== undefined && { namespace }),
                    name,
                  }),
                );
              }}
            />
            <IconButton
              icon={X}
              label="Close details"
              keys="esc"
              onClick={onClose}
            />
          </>
        }
        namespace={namespace}
        owner={owner && { target: owner, gvr: ownerGvr }}
        node={header?.node ?? undefined}
        created={header?.created ?? row.created ?? undefined}
        verdict={verdict}
        sentence={header?.sentence ?? []}
        verdictLine={line}
        onOpen={open}
        actions={
          <ActionRow
            label={`${kind} actions`}
            actions={workbench.actions("resource/details", lookup)}
          />
        }
      />
      <ObjectViews
        tab={tab}
        snapshot={snapshot}
        onChange={(next) => {
          states.setDetailsTab(uri, next);
        }}
        pages={services.pages}
        uri={uri}
        kind={kind}
      />
      {page && <Vitals cells={strip} verdict={verdict} layout="strip" />}
      <div className="min-h-0 flex-1 overflow-auto">
        {snapshot.overview || tab !== "overview" ? (
          <ObjectContent
            tab={tab}
            space={space}
            states={services.overviews}
            kind={`${group}/${resource}`}
            pages={services.pages}
            uri={uri}
            object={`${namespace ?? ""}/${name}`}
            snapshot={snapshot}
            values={values}
            reveal={reveal}
            onOpen={open}
            onEvents={() => {
              states.setDetailsTab(uri, "events");
            }}
            {...(namespace !== undefined && {
              onLogs: (choice) => {
                void workbench.commands.execute("k8s.logs.open", lookup, {
                  space,
                  gvr,
                  namespace,
                  name,
                  ...choice,
                });
              },
            })}
          />
        ) : (
          <>
            <ViewStatus status={snapshot.status} what="the object" inline />
            <Cells selected={selected} row={cells} now={now} />
          </>
        )}
      </div>
    </aside>
  );
}

/** The row's cells, wide columns included, until the object comes; `row` is the selection's with the measures a poll brought. */
function Cells({
  selected,
  row,
  now,
}: {
  selected: Selected;
  row: Row;
  now: number;
}) {
  const { gvr, columns } = selected;
  return (
    <PropertyList
      className={cn("p-3 text-body", LABEL_COLUMN)}
      items={columns.map((column, index) => {
        const { cell, figures } = columnRule(gvr, column);
        const value =
          cell === "age"
            ? row.created
              ? humanDuration(now - Date.parse(row.created))
              : ""
            : cell === "cpu" || cell === "memory"
              ? (measureText(cell, row.cells[index] ?? null) ?? "–")
              : String(row.cells[index] ?? "");
        return {
          key: column.name,
          label: column.name,
          numeric: figures || isTabular(value),
          value,
        };
      })}
    />
  );
}
