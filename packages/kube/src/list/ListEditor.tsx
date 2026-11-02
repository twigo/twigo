import { useEffect, useMemo, useState } from "react";
import { CircleAlert } from "lucide-react";
import type { Resource } from "@twigo/protocol";
import { ActionBar, EmptyState, GridSkeleton } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { Details } from "../Details";
import { sameGvr, useResources } from "../discovery";
import { pluralTitle } from "../kinds";
import type { ListServices } from "../services";
import { parseListUri, type ListInput } from "../uri";
import { ResourceGrid } from "./ResourceGrid";

/**
 * A `k8s-list://` editor (ARCHITECTURE 4.3, 4.4). Without `ns` in its URI
 * it follows the space's namespace scope. An opened row's details slide in
 * over the list; marked rows get a bar of what can be done to them.
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
      <EmptyState
        icon={CircleAlert}
        variant="error"
        title={`Could not load ${named}`}
        className="h-full"
      >
        <p className="max-w-md">{resources.error.message}</p>
      </EmptyState>
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
  const { keys, lists, editors, menus } = workbench;
  const { selection, states } = services;
  useChanges(selection.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  const selected = selection.get(uri);
  const marks = selection.marks(uri);
  const [open, setOpen] = useState(selected?.reveal === true);
  const [revealed, setRevealed] = useState(selected);
  if (selected !== revealed) {
    setRevealed(selected);
    if (selected?.reveal) setOpen(true);
  }
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!wrapper) return;
    const scope = keys.scope(wrapper);
    scope.set("detailsOpen", open);
    scope.set("listMarked", marks.size > 0);
    const unregister = lists.register(wrapper, {
      filter: () => {
        states.focus(uri);
      },
      close: () => {
        setOpen(false);
      },
    });
    return () => {
      unregister();
      scope.dispose();
    };
  }, [wrapper, keys, lists, states, uri, open, marks.size]);

  return (
    <div ref={setWrapper} className="relative h-full overflow-hidden">
      <ResourceGrid
        uri={uri}
        input={input}
        resource={resource}
        title={title}
        services={services}
        onActivate={() => {
          setOpen(true);
        }}
      />
      {marks.size > 0 && (
        <div className="absolute bottom-3 left-1/2 z-[5] -translate-x-1/2">
          <ActionBar
            actions={workbench.actions("resource/marked", keys.lookup(wrapper))}
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
      {open && selected && (
        <Details
          selected={selected}
          space={input.space}
          discovery={services.discovery}
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
