import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Copy, SquareArrowOutUpRight, X } from "lucide-react";
import type { ObjectQuery, ObjectRef, Overview, Row } from "@twigo/protocol";
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
import { cellTone, columnRule, statusColumn } from "./columns";
import { useResources } from "./discovery";
import { KindIcon } from "./KindIcon";
import { measureText } from "./list/metrics";
import { ObjectContent } from "./object/ObjectContent";
import { OBJECT_TABS } from "./object/tabs";
import { useReveal } from "./object/reveal";
import { useDrawnUsage } from "./object/usageSaid";
import { hasUsage } from "./object/figures";
import { refResource, refUri, useObject } from "./object/useObject";
import { objectOf, type Selected } from "./selection";
import type { ListServices } from "./services";
import { objectUri } from "./uri";
import { useNow } from "./useNow";
import { useVisible } from "./useVisible";
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
  const { discovery, selection, states } = services;
  useChanges(states.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  const resources = useResources(discovery, space);
  const [width, setWidth] = useState(470);
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
      overview: tab === "overview",
      manifest: tab === "yaml",
      events: tab === "events",
      related: true,
      usage: asked,
    },
  );
  const reveal = useReveal(id);
  const usage = useDrawnUsage(services.usageSaid, space, snapshot.usage);
  const open = (target: ObjectRef) => {
    if (resources.state !== "ready") return;
    const next = refUri(space, resources.value, target);
    if (next) onOpen(next);
  };
  const owner = snapshot.related?.owners.find(
    (candidate) => candidate.controller,
  );
  const ownerGvr =
    owner && resources.state === "ready"
      ? refResource(resources.value, owner.target)?.gvr
      : undefined;
  const statusAt = selected.columns.findIndex(
    (column) => column.name === statusColumn(gvr),
  );
  const status = statusAt < 0 ? undefined : row.cells[statusAt];
  const tone =
    typeof status === "string"
      ? (cellTone(gvr, selected.columns[statusAt]?.name ?? "", status) ?? "ok")
      : undefined;
  const warnings = warningCount(snapshot.overview, snapshot.events?.events);
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
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-border-subtle pt-2.5 pr-2 pb-2 pl-3.5">
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
          {[
            namespace !== undefined && (
              <span key="namespace" className="truncate">
                {namespace}
              </span>
            ),
            owner && (
              <LinkButton
                key="owner"
                onClick={() => {
                  open(owner.target);
                }}
                className="flex min-w-0 items-center gap-1"
              >
                {ownerGvr && (
                  <KindIcon gvr={ownerGvr} className="size-3 shrink-0" />
                )}
                <span className="truncate">
                  {owner.target.kind} {owner.target.name}
                </span>
              </LinkButton>
            ),
            row.created && (
              <span key="age" className="shrink-0 tabular-nums">
                {humanDuration(now - Date.parse(row.created))}
              </span>
            ),
          ]
            .filter(Boolean)
            .flatMap((part, index) =>
              index === 0
                ? [part]
                : [
                    <span
                      key={`dot-${String(index)}`}
                      aria-hidden
                      className="text-muted-foreground-2"
                    >
                      ·
                    </span>,
                    part,
                  ],
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
            space={space}
            states={services.overviews}
            kind={`${group}/${resource}`}
            snapshot={snapshot}
            values={values}
            reveal={reveal}
            usage={usage}
            onOpen={open}
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
      className="p-3 text-[13px]"
      items={columns.map((column, index) => {
        const { cell } = columnRule(gvr, column);
        return {
          key: column.name,
          label: column.name,
          value:
            cell === "age"
              ? row.created
                ? humanDuration(now - Date.parse(row.created))
                : ""
              : cell === "cpu" || cell === "memory"
                ? (measureText(cell, row.cells[index] ?? null) ?? "–")
                : String(row.cells[index] ?? ""),
        };
      })}
    />
  );
}
