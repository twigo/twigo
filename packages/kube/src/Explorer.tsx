import { useEffect, useId, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Resource } from "@twigo/protocol";
import { cn, EmptyState, Skeleton } from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";
import { useResources, type Discovery } from "./discovery";
import { pluralTitle, sections, type Section } from "./kinds";
import type { Lists } from "./lists";
import { listUri } from "./uri";

export const EXPLORER_VIEW = "kube.resources";

const DEFAULT_OPEN = ["Workloads"];

/**
 * The resource tree of the active space (ARCHITECTURE 4.1): a click opens the
 * kind's table as a preview, a double click keeps it. The list commands move
 * through it, left and right close and open sections, and the open sections
 * are kept per space.
 */
export function Explorer({
  discovery,
  lists,
}: {
  discovery: Discovery;
  lists: Lists;
}) {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  if (!space) return null;
  return (
    <SpaceExplorer
      key={space.id}
      discovery={discovery}
      lists={lists}
      space={space.id}
    />
  );
}

function SpaceExplorer({
  discovery,
  lists,
  space,
}: {
  discovery: Discovery;
  lists: Lists;
  space: string;
}) {
  const resources = useResources(discovery, space);
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
  return <Tree space={space} lists={lists} resources={resources.value} />;
}

type Row =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly parent: string | undefined;
      readonly depth: number;
      readonly title: string;
      readonly icon: LucideIcon | undefined;
      readonly open: boolean;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly parent: string;
      readonly depth: number;
      readonly title: string;
    };

/** The rows on screen, in order: every section, and the items of open ones. */
function visibleRows(
  space: string,
  tree: readonly Section<Resource>[],
  open: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = [];
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
        kind: "section",
        key,
        parent,
        depth,
        title: section.title,
        icon: section.icon,
        open: isOpen,
      });
      if (!isOpen) continue;
      walk(section.groups, key, depth + 1);
      for (const resource of section.items) {
        rows.push({
          kind: "item",
          key: listUri({ space, gvr: resource.gvr }),
          parent: key,
          depth: depth + 1,
          title: pluralTitle(resource.kind, resource.gvr.resource),
        });
      }
    }
  };
  walk(tree, undefined, 0);
  return rows;
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

function Tree({
  space,
  lists,
  resources,
}: {
  space: string;
  lists: Lists;
  resources: readonly Resource[];
}) {
  const { spaces, editors, keys } = useWorkbench();
  useChanges(editors.changes);
  const ids = useId();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<string>();
  const saved = readOpen(spaces.view(space, EXPLORER_VIEW));
  const rows = visibleRows(space, sections(resources), new Set(saved));
  const active = editors.active;
  const at = Math.max(
    0,
    rows.findIndex((row) => row.key === (cursor ?? active)),
  );
  const current = rows[at];
  const rowId = (index: number) => `${ids}-${String(index)}`;
  const toggle = (key: string) => {
    spaces.setView(space, EXPLORER_VIEW, {
      open: saved.includes(key)
        ? saved.filter((open) => open !== key)
        : [...saved, key],
    });
  };

  useEffect(() => {
    if (!element) return;
    const scope = keys.scope(element);
    scope.set("listFocus", true);
    scope.set("treeFocus", true);
    return () => {
      scope.dispose();
    };
  }, [element, keys]);

  useEffect(() => {
    if (!element) return;
    const moveTo = (index: number) => {
      const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
      if (row) setCursor(row.key);
    };
    return lists.register(element, {
      move: (delta) => {
        moveTo(at + delta);
      },
      moveToEdge: (edge) => {
        moveTo(edge === "first" ? 0 : rows.length - 1);
      },
      activate: () => {
        if (current?.kind === "section") toggle(current.key);
        else if (current) editors.open(current.key, { preview: true });
      },
      collapse: () => {
        if (current?.kind === "section" && current.open) toggle(current.key);
        else if (current?.parent !== undefined) setCursor(current.parent);
      },
      expand: () => {
        if (current?.kind !== "section") return;
        if (!current.open) toggle(current.key);
        else if (rows[at + 1]?.parent === current.key) moveTo(at + 1);
      },
    });
  });

  useEffect(() => {
    document
      .getElementById(`${ids}-${String(at)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [ids, at]);

  return (
    <div
      ref={setElement}
      role="tree"
      tabIndex={0}
      aria-label="Resources"
      aria-activedescendant={current ? rowId(at) : undefined}
      className="group h-full overflow-auto pb-2 outline-none"
    >
      {rows.map((row, index) => (
        <div
          key={row.key}
          id={rowId(index)}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.kind === "section" ? row.open : undefined}
          aria-selected={row.kind === "item" && row.key === active}
          onClick={() => {
            setCursor(row.key);
            if (row.kind === "section") toggle(row.key);
            else editors.open(row.key, { preview: true });
          }}
          onDoubleClick={
            row.kind === "item"
              ? () => {
                  editors.open(row.key);
                }
              : undefined
          }
          style={{
            paddingLeft: (row.kind === "section" ? 8 : 12) + row.depth * 16,
          }}
          className={cn(
            "relative flex h-[22px] cursor-default items-center gap-1 pr-2 text-[13px] select-none hover:bg-row-hover",
            row.kind === "item" &&
              row.key === active &&
              "bg-selected-unfocused",
            index === at && "group-focus:bg-selected",
          )}
        >
          {Array.from({ length: row.depth }, (_, level) => (
            <span
              key={level}
              aria-hidden
              style={{ left: 15.5 + level * 16 }}
              className="pointer-events-none absolute inset-y-0 w-px bg-border"
            />
          ))}
          {row.kind === "section" ? (
            <SectionLabel row={row} />
          ) : (
            <span className="truncate">{row.title}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ row }: { row: Extract<Row, { kind: "section" }> }) {
  const Chevron = row.open ? ChevronDown : ChevronRight;
  return (
    <>
      <Chevron className="size-4 shrink-0 text-muted-foreground" />
      {row.icon && (
        <row.icon className="mr-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{row.title}</span>
    </>
  );
}
