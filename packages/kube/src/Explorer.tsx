import { useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react";
import type { Resource } from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { cn, EmptyState, Skeleton } from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";
import { useResources, type Discovery } from "./discovery";
import { KindIcon } from "./KindIcon";
import { pluralTitle, sections, type Section } from "./kinds";
import { listUri } from "./uri";

/**
 * The resource tree of the active space (ARCHITECTURE 4.1): a click opens the
 * kind's table as a preview, a double click keeps it.
 */
export function Explorer({ discovery }: { discovery: Discovery }) {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  if (!space) return null;
  return (
    <SpaceExplorer key={space.id} discovery={discovery} space={space.id} />
  );
}

function SpaceExplorer({
  discovery,
  space,
}: {
  discovery: Discovery;
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
        {toIpcError(resources.error).message}
      </EmptyState>
    );
  }
  return (
    <div
      role="tree"
      aria-label="Resources"
      className="h-full overflow-auto pb-2"
    >
      {sections(resources.value).map((section) => (
        <ExplorerSection
          key={section.title}
          space={space}
          section={section}
          depth={0}
        />
      ))}
    </div>
  );
}

function ExplorerSection({
  space,
  section,
  depth,
}: {
  space: string;
  section: Section<Resource>;
  depth: number;
}) {
  const { editors } = useWorkbench();
  useChanges(editors.changes);
  const { title, items, groups } = section;
  const [open, setOpen] = useState(title === "Workloads");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
        }}
        style={{ paddingLeft: 8 + depth * 16 }}
        className="flex h-[22px] w-full items-center gap-1 pr-2 text-left text-[13px] font-medium hover:bg-row-hover"
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
        {title}
      </button>
      {open && (
        <div role="group">
          {groups.map((group) => (
            <ExplorerSection
              key={group.title}
              space={space}
              section={group}
              depth={depth + 1}
            />
          ))}
          {items.map((resource) => {
            const uri = listUri({ space, gvr: resource.gvr });
            return (
              <button
                key={uri}
                type="button"
                role="treeitem"
                aria-selected={editors.active === uri}
                onClick={() => {
                  editors.open(uri, { preview: true });
                }}
                onDoubleClick={() => {
                  editors.open(uri);
                }}
                style={{ paddingLeft: 28 + depth * 16 }}
                className={cn(
                  "flex h-[22px] w-full items-center gap-1.5 pr-2 text-left text-[13px] hover:bg-row-hover",
                  editors.active === uri && "bg-selected-unfocused",
                )}
              >
                <KindIcon
                  gvr={resource.gvr}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate">
                  {pluralTitle(resource.kind, resource.gvr.resource)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
