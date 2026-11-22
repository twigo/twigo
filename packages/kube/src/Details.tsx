import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Copy, SquareArrowOutUpRight, X } from "lucide-react";
import type { ObjectQuery, ObjectRef } from "@twigo/protocol";
import { ActionRow, cn, IconButton, PropertyList } from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";
import { columnRule, rowFinished, rowTone, statusColumn } from "./columns";
import { useResources } from "./discovery";
import { decideRows } from "./list/alarm";
import { CellView, type ShownColumn } from "./list/cells";
import { noContainerRuns } from "./object/noContainerRuns";
import { ObjectHeader } from "./object/ObjectHeader";
import { LABEL_COLUMN, ObjectContent } from "./object/ObjectContent";
import { ObjectViews } from "./object/ObjectViews";
import { OBJECT_TABS } from "./object/tabs";
import { Vitals } from "./object/Vitals";
import { useHeader } from "./object/useHeader";
import { foundTone } from "./object/verdict";
import { useSecretReveal } from "./object/reveal";
import { hasUsage } from "./object/figures";
import { OBJECT_FILTERED, OBJECT_URI, useFiltered } from "./object/pageStates";
import { refResource, refUri, useObject } from "./object/useObject";
import { cellsOf, objectOf, type Selected, type Selection } from "./selection";
import type { ListServices } from "./services";
import { isTabular } from "./tabular";
import { objectUri } from "./uri";
import { useReopen } from "./useReopen";
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
export function Details(props: Omit<ComponentProps<typeof Panel>, "onReopen">) {
  const [key, reopen] = useReopen();
  return <Panel key={key} {...props} onReopen={reopen} />;
}

function Panel({
  uri,
  selected,
  space,
  services,
  docked,
  onOpen,
  onClose,
  onReopen,
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
  onReopen: () => void;
}) {
  const workbench = useWorkbench();
  const { backend, keys, menus } = workbench;
  const { discovery, selection, states } = services;
  useChanges(states.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  const resources = useResources(discovery, space);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const { gvr, kind, namespaced, row } = selected;
  const { namespace, name } = objectOf(selected);
  const { group, version, resource } = gvr;
  const object = objectUri({
    space,
    gvr,
    ...(namespace !== undefined && { namespace }),
    name,
  });
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
  const reveal = useSecretReveal(id);
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
    const cell = cellsOf(selected)(column);
    return typeof cell === "string" ? cell : undefined;
  };
  const { verdict, strip, line } = useHeader({
    gvr,
    header,
    found: foundTone(snapshot.overview),
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
  const lookup = keys.lookup(element);

  return (
    <DetailsFrame
      label={`${kind} details`}
      docked={docked}
      onElement={setElement}
    >
      <ObjectHeader
        object={object}
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
                onOpen(object);
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
        tabs={OBJECT_TABS}
        snapshot={snapshot}
        onChange={(next) => {
          states.setDetailsTab(uri, next);
        }}
        pages={services.pages}
        uri={uri}
        kind={kind}
      />
      {page && <Vitals cells={strip} verdict={verdict} />}
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
            onReopen={onReopen}
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
            <ViewStatus
              status={snapshot.status}
              what="the object"
              onRetry={onReopen}
              inline
            />
            <Cells selected={selected} uri={uri} selection={selection} />
          </>
        )}
      </div>
    </DetailsFrame>
  );
}

/**
 * The column the details stand in: beside the list, or over it where the
 * editor is too narrow, as Lens's drawer, with its left edge resizing it. Its
 * width is the person's, kept with the part sizes (ARCHITECTURE 4.8).
 */
export function DetailsFrame({
  label,
  docked,
  onElement,
  children,
}: {
  label: string;
  /** Beside the list rather than over it. */
  docked: boolean;
  onElement: (element: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const { sizes } = useWorkbench();
  useChanges(sizes.changes);
  const [dragged, setDragged] = useState<number>();
  const width =
    dragged ?? Math.max(MIN_WIDTH, sizes.get("inspector") ?? DEFAULT_WIDTH);
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    onElement(element);
  }, [element, onElement]);
  return (
    <aside
      ref={setElement}
      aria-label={label}
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
      {children}
    </aside>
  );
}

/** The row's cells, wide columns included, until the object comes, each as its list draws it, with the measures a poll brought to the selection. */
function Cells({
  selected,
  uri,
  selection,
}: {
  selected: Selected;
  uri: string;
  selection: Selection;
}) {
  const measured = useSyncExternalStore(selection.watch, () =>
    selection.get(uri),
  );
  const row =
    measured?.row.id === selected.row.id ? measured.row : selected.row;
  const { gvr, columns } = selected;
  const shown: ShownColumn[] = columns.map((column, index) => ({
    name: column.name,
    index,
    rule: columnRule(gvr, column),
  }));
  const health = statusColumn(gvr);
  const { tone, alarmed, finished } = decideRows(
    (each) => rowTone(gvr, health, columns, each),
    (each) => rowFinished(gvr, health, columns, each),
    shown,
  )(row);
  return (
    <PropertyList
      className={cn("p-3 text-body", LABEL_COLUMN)}
      items={shown.map((column) => ({
        key: column.name,
        label: column.name,
        numeric:
          column.rule.figures ||
          isTabular(String(row.cells[column.index] ?? "")),
        value: (
          <CellView
            row={row}
            column={column}
            tone={tone}
            alarmed={alarmed}
            finished={finished}
          />
        ),
      }))}
    />
  );
}
