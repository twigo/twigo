import { useEffect, useMemo, useState } from "react";
import { CircleAlert } from "lucide-react";
import type { Resource } from "@twigo/protocol";
import { ActionBar, EmptyState, GridSkeleton } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { Details } from "../Details";
import { CAPABILITY_PREFIXES } from "../capabilities";
import { logsKind } from "../logs/entries";
import { rowState } from "../rowState";
import { objectOf } from "../selection";
import { sameGvr, useResources } from "../discovery";
import { pluralTitle } from "../kinds";
import type { ListServices } from "../services";
import { parseListUri, type ListInput } from "../uri";
import { useWidth } from "../useWidth";
import { ViewStatus } from "../ViewStatus";
import { ResourceGrid } from "./ResourceGrid";

/** Below this width the details slide over the list instead of beside it. */
const DOCK_WIDTH = 960;

/**
 * A `k8s-list://` editor (ARCHITECTURE 4.3, 4.4). Without `ns` in its URI
 * it follows the space's namespace scope. An opened row's details stand
 * beside the list, which narrows to its name, ready and status columns,
 * or slide over it in a narrow editor; marked rows get a bar of what can
 * be done to them.
 */
export function ListEditor({
  uri,
  services,
}: EditorProps & { services: ListServices }) {
  const { editors } = useWorkbench();
  const input = useMemo(() => parseListUri(uri), [uri]);
  const resources = useResources(services.discovery, input?.space ?? "");
  const resource =
    input && resources.state === "ready"
      ? servedAs(resources.value, input)
      : undefined;
  const title = resource
    ? pluralTitle(resource.kind, resource.gvr.resource)
    : undefined;
  useEffect(() => {
    if (title) editors.setTitle(uri, title);
  }, [editors, uri, title]);

  if (!input) return null;
  const { group, resource: plural } = input.gvr;
  const named = group ? `${plural}.${group}` : plural;
  if (resources.state === "failed") {
    return (
      <ViewStatus
        status={{ state: "error", error: resources.error }}
        what={named}
      />
    );
  }
  if (resources.state === "ready" && !resource) {
    return (
      <EmptyState
        icon={CircleAlert}
        title={`The cluster does not serve ${named}`}
        className="h-full"
      />
    );
  }
  if (!resource || !title) return <GridSkeleton />;
  return (
    <Loaded
      uri={uri}
      input={input}
      resource={resource}
      title={title}
      services={services}
    />
  );
}

/**
 * Discovery names each group's preferred version; a list of another
 * version that the cluster serves has the same kind and scope.
 */
function servedAs(
  resources: readonly Resource[],
  input: ListInput,
): Resource | undefined {
  return (
    resources.find((candidate) => sameGvr(candidate.gvr, input.gvr)) ??
    resources.find(
      (candidate) =>
        candidate.gvr.group === input.gvr.group &&
        candidate.gvr.resource === input.gvr.resource,
    )
  );
}

function Loaded({
  uri,
  input,
  resource,
  title,
  services,
}: {
  uri: string;
  input: ListInput;
  resource: Resource;
  title: string;
  services: ListServices;
}) {
  const workbench = useWorkbench();
  const { keys, lists, editors, menus, commands, catalog } = workbench;
  const { selection, states, capabilities } = services;
  useChanges(selection.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  useChanges(capabilities.changes);
  useChanges(commands.changes);
  useChanges(catalog.changes);
  const selected = selection.get(uri);
  const namespace = selected && objectOf(selected).namespace;
  const referenced = CAPABILITY_PREFIXES.flatMap((prefix) =>
    commands.referenced(prefix),
  );
  const capabilityKeys = JSON.stringify(referenced);
  const contexts = catalog.list;
  useEffect(() => {
    capabilities.ask(
      uri,
      input.space,
      resource.gvr,
      namespace,
      JSON.parse(capabilityKeys) as string[],
      contexts,
    );
  }, [
    capabilities,
    uri,
    input.space,
    resource.gvr,
    namespace,
    capabilityKeys,
    contexts,
  ]);
  const allowed = capabilities.values(uri, referenced);
  const scoped = JSON.stringify({
    ...allowed,
    ...rowState(resource, selected),
  });
  const marks = selection.marks(uri);
  const [open, setOpen] = useState(selected?.reveal === true);
  const [revealed, setRevealed] = useState(selected);
  if (selected !== revealed) {
    setRevealed(selected);
    if (selected?.reveal) setOpen(true);
  }
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  const width = useWidth(wrapper);
  const docked = width >= DOCK_WIDTH;

  useEffect(() => {
    if (!wrapper) return;
    const scope = keys.scope(wrapper);
    scope.set("detailsOpen", open);
    scope.set("listMarked", marks.size > 0);
    scope.set("resource.selected", selected !== undefined);
    scope.set("resource.logs", logsKind(input.gvr) !== undefined);
    scope.set("resource.group", resource.gvr.group);
    scope.set("resource.kind", resource.kind);
    scope.set("resource.namespaced", resource.namespaced);
    scope.set("resource.scalable", resource.subresources.includes("scale"));
    for (const [key, value] of Object.entries(
      JSON.parse(scoped) as Record<string, boolean>,
    ))
      scope.set(key, value);
    const unregister = lists.register(wrapper, {
      filter: () => {
        states.focus(uri);
      },
      close: () => {
        setOpen(false);
      },
      peek: () => {
        setOpen(!open);
      },
    });
    return () => {
      unregister();
      scope.dispose();
    };
  }, [
    wrapper,
    keys,
    lists,
    states,
    uri,
    open,
    marks.size,
    selected,
    input.gvr,
    resource,
    scoped,
  ]);

  return (
    <div ref={setWrapper} className="relative flex h-full overflow-hidden">
      <div className="relative h-full min-w-0 flex-1">
        <ResourceGrid
          uri={uri}
          input={input}
          resource={resource}
          title={title}
          services={services}
          narrow={open && docked && selected !== undefined}
          onActivate={() => {
            setOpen(true);
          }}
        />
        {marks.size > 0 && (
          <div className="absolute bottom-3 left-1/2 z-[5] -translate-x-1/2">
            <ActionBar
              actions={workbench.actions(
                "resource/marked",
                keys.lookup(wrapper),
              )}
            >
              <span className="px-2 tabular-nums">
                <span className="font-semibold">
                  {marks.size.toLocaleString("en")}
                </span>{" "}
                marked
              </span>
            </ActionBar>
          </div>
        )}
      </div>
      {open && selected && (
        <Details
          uri={uri}
          selected={selected}
          space={input.space}
          services={services}
          docked={docked}
          onOpen={(object) => {
            editors.pin(uri);
            editors.open(object, { preview: true });
          }}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
