import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import type { Gvr, Resource } from "@twigo/protocol";
import {
  Count,
  EmptyState,
  Skeleton,
  StatusDot,
  Tree,
  type TreeRow,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
} from "@twigo/workbench";
import { byHealth, statusColumn, worstHealth } from "../columns";
import { useResources } from "../discovery";
import { kindIcon, pluralTitle, sections, type Section } from "../kinds";
import type { ListStatus } from "../list/listStatus";
import type { ListServices } from "../services";
import { listUri, parseListUri } from "../uri";

export const EXPLORER_VIEW = "kube.resources";

const DEFAULT_OPEN = ["Workloads"];

/**
 * The resource tree of the active space (ARCHITECTURE 4.1): the lists the
 * user pinned, then the kinds by section. A click opens a list as a
 * preview, a double click keeps it; a kind whose list is open shows its
 * rows and its worst health. The open sections are kept per space.
 */
export function Explorer({ services }: { services: ListServices }) {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  if (!space) return null;
  return <SpaceExplorer key={space.id} services={services} space={space.id} />;
}

function SpaceExplorer({
  services,
  space,
}: {
  services: ListServices;
  space: string;
}) {
  const resources = useResources(services.discovery, space);
  if (resources.state === "loading") {
    return (
      <div aria-busy className="flex flex-col gap-2 px-4 py-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-3 w-3/4" />
        ))}
      </div>
    );
  }
  if (resources.state === "failed") {
    return (
      <EmptyState icon={CircleAlert} variant="error" density="inline">
        {resources.error.message}
      </EmptyState>
    );
  }
  return (
    <ResourceTree
      space={space}
      services={services}
      resources={resources.value}
    />
  );
}

function readOpen(saved: unknown): readonly string[] {
  if (
    typeof saved !== "object" ||
    saved === null ||
    !("open" in saved) ||
    !Array.isArray(saved.open)
  ) {
    return DEFAULT_OPEN;
  }
  return saved.open.filter((key): key is string => typeof key === "string");
}

function ResourceTree({
  space,
  services,
  resources,
}: {
  space: string;
  services: ListServices;
  resources: readonly Resource[];
}) {
  const { spaces, editors } = useWorkbench();
  const { statuses, pinned } = services;
  useChanges(editors.changes);
  useChanges(statuses.changes);
  const register = useListRegistration({ treeFocus: true });
  const open = readOpen(spaces.view(space, EXPLORER_VIEW));
  const toggle = (key: string) => {
    spaces.setView(space, EXPLORER_VIEW, {
      open: open.includes(key)
        ? open.filter((other) => other !== key)
        : [...open, key],
    });
  };

  const pins = pinned.list(space);
  const rows: TreeRow[] = [
    ...(pins.length > 0
      ? [
          { id: "heading:pinned", depth: 0, label: "Pinned", heading: true },
          ...pins.map((pin): TreeRow => {
            const gvr = parseListUri(pin.uri)?.gvr;
            return {
              id: pin.uri,
              depth: 0,
              label: <Pinned title={pin.title} detail={pin.detail} />,
              ...(gvr && { icon: kindIcon(gvr) }),
              trailing: <Total status={statuses.get(pin.uri)} gvr={gvr} />,
            };
          }),
          {
            id: "heading:resources",
            depth: 0,
            label: "Resources",
            heading: true,
          },
        ]
      : []),
    ...flatten(sections(resources), new Set(open), (resource) => {
      const uri = listUri({ space, gvr: resource.gvr });
      return {
        id: uri,
        label: pluralTitle(resource.kind, resource.gvr.resource),
        trailing: <Total status={statuses.get(uri)} gvr={resource.gvr} whole />,
      };
    }),
  ];

  return (
    <Tree
      label="Resources"
      rows={rows}
      active={editors.active}
      onOpen={(id, keep) => {
        editors.open(id, { preview: !keep });
      }}
      onToggle={toggle}
      register={register}
    />
  );
}

/** Sections and their kinds as tree rows, the kinds of open sections only. */
function flatten(
  tree: readonly Section<Resource>[],
  open: ReadonlySet<string>,
  item: (resource: Resource) => Pick<TreeRow, "id" | "label" | "trailing">,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (
    list: readonly Section<Resource>[],
    parent: string | undefined,
    depth: number,
  ) => {
    for (const section of list) {
      const key =
        parent === undefined ? section.title : `${parent}/${section.title}`;
      const isOpen = open.has(key);
      rows.push({
        id: key,
        ...(parent !== undefined && { parent }),
        depth,
        label: section.title,
        ...(section.icon && { icon: section.icon }),
        open: isOpen,
      });
      if (!isOpen) continue;
      walk(section.groups, key, depth + 1);
      for (const resource of section.items) {
        rows.push({ ...item(resource), parent: key, depth: depth + 1 });
      }
    }
  };
  walk(tree, undefined, 0);
  return rows;
}

function Pinned({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): ReactNode {
  return (
    <>
      {title}
      {detail && (
        <span className="ml-1.5 text-xs text-muted-foreground">{detail}</span>
      )}
    </>
  );
}

/**
 * An open list's rows, after a dot of its worst health when it has a status
 * column; `whole` counts the kind's rows whatever health the list picked.
 */
function Total({
  status,
  gvr,
  whole = false,
}: {
  status: ListStatus | undefined;
  gvr: Gvr | undefined;
  whole?: boolean;
}) {
  if (!status) return null;
  const column = gvr && statusColumn(gvr);
  const counts =
    gvr && column ? byHealth(gvr, column, status.counts) : undefined;
  const worst = counts ? worstHealth(counts) : "ok";
  // Counts come before a health filter, so they sum to the kind's rows.
  const total =
    whole && counts
      ? counts.ok.count + counts.warn.count + counts.error.count
      : status.total;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
      {worst !== "ok" && <StatusDot tone={worst} />}
      <Count value={total} />
    </span>
  );
}
