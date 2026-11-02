import { useEffect, useMemo, useState } from "react";
import { SquareArrowOutUpRight, X } from "lucide-react";
import type { ObjectQuery, ObjectRef, ViewState } from "@twigo/protocol";
import { Button, EmptyState } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { useWorkbench } from "@twigo/workbench";
import { useResources, type Discovery } from "./discovery";
import { KindIcon } from "./KindIcon";
import { Overview } from "./object/Overview";
import { refUri, useObject } from "./object/useObject";
import { objectOf, type Selected } from "./selection";
import { objectUri } from "./uri";
import { useNow } from "./useNow";

const MIN_WIDTH = 320;

/** How long the selection rests on a row before its object opens (ARCHITECTURE 4.3). */
export const DWELL_MS = 150;

const OVERVIEW = {
  overview: true,
  manifest: false,
  events: false,
  related: false,
};

/**
 * A row's details sliding in over its list from the right, as Lens's
 * drawer (ARCHITECTURE 4.3). Once the selection rests on the row, its
 * object opens and follows its changes, shown as the editor's Overview;
 * until then the row's cells stand in. Its left edge resizes it.
 */
export function Details({
  selected,
  space,
  discovery,
  onOpen,
  onClose,
}: {
  selected: Selected;
  space: string;
  discovery: Discovery;
  /** Opens an object's editor beside the list. */
  onOpen: (uri: string) => void;
  onClose: () => void;
}) {
  const { backend } = useWorkbench();
  const resources = useResources(discovery, space);
  const [width, setWidth] = useState(440);
  const { gvr, kind, namespaced } = selected;
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
  const { snapshot, values } = useObject(
    backend,
    rested === query ? query : undefined,
    OVERVIEW,
  );
  const open = (target: ObjectRef) => {
    if (resources.state !== "ready") return;
    const uri = refUri(space, resources.value, target);
    if (uri) onOpen(uri);
  };
  return (
    <aside
      aria-label={`${kind} details`}
      style={{ width }}
      className="absolute inset-y-0 right-0 z-10 flex max-w-[85%] animate-in flex-col border-l border-border bg-editor shadow-lg animation-duration-150 slide-in-from-right-8"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details"
        onPointerDown={(event) => {
          event.preventDefault();
          const start = event.clientX;
          const from = width;
          const target = event.currentTarget;
          target.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) => {
            setWidth(Math.max(MIN_WIDTH, from + start - next.clientX));
          };
          target.addEventListener("pointermove", move);
          target.addEventListener(
            "pointerup",
            () => {
              target.removeEventListener("pointermove", move);
            },
            { once: true },
          );
        }}
        className="absolute inset-y-0 -left-1 w-2 cursor-col-resize"
      />
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border-subtle pr-1 pl-3 text-[13px]">
        <KindIcon gvr={gvr} className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{kind}</span>
        <span className="truncate font-medium">{name}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open in an editor"
          className="ml-auto"
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
        >
          <SquareArrowOutUpRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close details"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {snapshot.status.state === "ready" && !snapshot.exists ? (
          <EmptyState title="The object does not exist" className="py-8" />
        ) : snapshot.overview ? (
          <Overview
            overview={snapshot.overview}
            onOpen={open}
            values={values}
          />
        ) : (
          <>
            <Failure status={snapshot.status} />
            <Cells selected={selected} />
          </>
        )}
      </div>
    </aside>
  );
}

/** Why the object cannot come, if it cannot; the row's cells stay below. */
function Failure({ status }: { status: ViewState }) {
  const why =
    status.state === "error"
      ? status.error.message
      : status.state === "forbidden"
        ? `You may not ${status.verb} ${status.resource}.`
        : status.state === "unauthorized"
          ? "The cluster does not accept the credentials."
          : undefined;
  if (why === undefined) return null;
  return (
    <EmptyState variant="error" density="inline" className="px-3">
      {why}
    </EmptyState>
  );
}

/** The row's cells, wide columns included, until the object comes. */
function Cells({ selected }: { selected: Selected }) {
  const now = useNow(1000);
  const { columns, row } = selected;
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] content-start gap-x-3 gap-y-1 p-3 text-[13px]">
      {columns.map((column, index) => (
        <div key={column.name} className="contents">
          <dt className="text-muted-foreground">{column.name}</dt>
          <dd className="truncate tabular-nums">
            {column.kind === "age"
              ? row.created
                ? humanDuration(now - Date.parse(row.created))
                : ""
              : String(row.cells[index] ?? "")}
          </dd>
        </div>
      ))}
    </dl>
  );
}
