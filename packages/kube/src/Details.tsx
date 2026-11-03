import { useEffect, useMemo, useState } from "react";
import { Copy, SquareArrowOutUpRight, X } from "lucide-react";
import type { ObjectQuery, ObjectRef, Overview } from "@twigo/protocol";
import {
  ActionBar,
  cn,
  IconButton,
  LinkButton,
  Pill,
  PropertyList,
  TabBar,
} from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { useChanges, useWorkbench } from "@twigo/workbench";
import { cellTone, statusColumn } from "./columns";
import { useResources } from "./discovery";
import { KindIcon } from "./KindIcon";
import { ObjectContent } from "./object/ObjectContent";
import { OBJECT_TABS } from "./object/tabs";
import { refUri, useObject } from "./object/useObject";
import { objectOf, type Selected } from "./selection";
import type { ListServices } from "./services";
import { objectUri } from "./uri";
import { useNow } from "./useNow";
import { ViewStatus } from "./ViewStatus";

const MIN_WIDTH = 320;

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
  const { backend, keys, menus } = workbench;
  const { discovery, states } = services;
  useChanges(states.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  const resources = useResources(discovery, space);
  const [width, setWidth] = useState(460);
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
  const { snapshot, values } = useObject(
    backend,
    rested === query ? query : undefined,
    {
      overview: tab === "overview",
      manifest: tab === "yaml",
      events: tab === "events",
      related: true,
    },
  );
  const open = (target: ObjectRef) => {
    if (resources.state !== "ready") return;
    const next = refUri(space, resources.value, target);
    if (next) onOpen(next);
  };
  const owner = snapshot.related?.owners.find(
    (candidate) => candidate.controller,
  );
  const statusAt = selected.columns.findIndex(
    (column) => column.name === statusColumn(gvr),
  );
  const status = statusAt < 0 ? undefined : row.cells[statusAt];
  const tone =
    typeof status === "string"
      ? (cellTone(gvr, selected.columns[statusAt]?.name ?? "", status) ?? "ok")
      : undefined;
  const warnings = warningCount(snapshot.overview, snapshot.events?.events);
  const now = useNow(1000);
  const lookup = keys.lookup(element);

  return (
    <aside
      ref={setElement}
      aria-label={`${kind} details`}
      style={{ width }}
      className={cn(
        "flex h-full max-w-[85%] flex-col border-l border-border bg-editor",
        docked
          ? "relative shrink-0"
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
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
      />
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-border-subtle pt-2 pr-1 pb-1.5 pl-3">
        <div className="flex items-center gap-1.5">
          <KindIcon
            gvr={gvr}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            <Name name={name} generated={row.generated} />
          </h2>
          <IconButton
            icon={Copy}
            label="Copy Name"
            onClick={() => {
              void workbench.commands.execute("k8s.resource.copyName", lookup);
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
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {tone && typeof status === "string" && (
            <Pill tone={tone}>{status}</Pill>
          )}
          {namespace !== undefined && (
            <span className="truncate">{namespace}</span>
          )}
          {owner && (
            <LinkButton
              onClick={() => {
                open(owner.target);
              }}
              className="truncate"
            >
              {owner.target.kind} {owner.target.name}
            </LinkButton>
          )}
          {row.created && (
            <span className="ml-auto shrink-0 pr-2 tabular-nums">
              {humanDuration(now - Date.parse(row.created))}
            </span>
          )}
        </div>
        <ActionBar
          inline
          actions={workbench.actions("resource/details", lookup)}
          className="-ml-1.5"
        />
      </header>
      <TabBar
        label="Views of the object"
        tabs={OBJECT_TABS.map(({ id, title }) => ({
          value: id,
          label: title,
          ...(id === "events" && { count: warnings, warn: true }),
        }))}
        value={tab}
        onChange={(next) => {
          states.setDetailsTab(uri, next);
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {snapshot.overview || tab !== "overview" ? (
          <ObjectContent
            tab={tab}
            snapshot={snapshot}
            values={values}
            onOpen={open}
          />
        ) : (
          <>
            <ViewStatus status={snapshot.status} what="the object" inline />
            <Cells selected={selected} now={now} />
          </>
        )}
      </div>
    </aside>
  );
}

/** Warning events of the object, from its Overview or its Events view, whichever came. */
function warningCount(
  overview: Overview | undefined,
  events: readonly { readonly type: string }[] | undefined,
): number {
  const listed =
    events ??
    overview?.sections
      .flatMap((section) => section.blocks)
      .flatMap((block) => (block.type === "events" ? block.events : []));
  return (listed ?? []).filter((event) => event.type === "Warning").length;
}

function Name({ name, generated }: { name: string; generated: number | null }) {
  if (generated === null || generated <= 0 || generated >= name.length)
    return name;
  return (
    <>
      {name.slice(0, generated)}
      <span className="font-normal text-muted-foreground-2">
        {name.slice(generated)}
      </span>
    </>
  );
}

/** The row's cells, wide columns included, until the object comes. */
function Cells({ selected, now }: { selected: Selected; now: number }) {
  const { columns, row } = selected;
  return (
    <PropertyList
      className="p-3 text-[13px]"
      items={columns.map((column, index) => ({
        key: column.name,
        label: column.name,
        value:
          column.kind === "age"
            ? row.created
              ? humanDuration(now - Date.parse(row.created))
              : ""
            : String(row.cells[index] ?? ""),
      }))}
    />
  );
}
