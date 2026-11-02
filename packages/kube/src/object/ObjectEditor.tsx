import { useMemo, type ReactNode } from "react";
import type {
  ObjectQuery,
  ObjectRef,
  ObjectSnapshot,
  Related,
  RelatedObject,
} from "@twigo/protocol";
import { cn, EmptyState, LinkButton, Segmented, Skeleton } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { sameGvr, useResources, type Discovery } from "../discovery";
import { parseObjectUri } from "../uri";
import { Manifest } from "./Manifest";
import { ViewStatus } from "../ViewStatus";
import { Events, Overview } from "./Overview";
import { OBJECT_TABS, type ObjectTab, type ObjectTabs } from "./tabs";
import { refUri, useObject } from "./useObject";

/**
 * A `k8s://` editor (ARCHITECTURE 4.3): one object, live, as its Overview,
 * its YAML, its events and its related objects; Rust follows only the tab
 * shown.
 */
export function ObjectEditor({
  uri,
  discovery,
  tabs,
}: EditorProps & { discovery: Discovery; tabs: ObjectTabs }) {
  const { backend, editors } = useWorkbench();
  const input = useMemo(() => parseObjectUri(uri), [uri]);
  const resources = useResources(discovery, input?.space ?? "");
  useChanges(tabs.changes);
  const tab = tabs.get(uri);
  const known =
    input && resources.state === "ready"
      ? resources.value.find((resource) => sameGvr(resource.gvr, input.gvr))
      : undefined;
  const query: ObjectQuery | undefined = input && {
    space: input.space,
    gvr: input.gvr,
    namespaced: known?.namespaced ?? input.namespace !== undefined,
    namespace: input.namespace ?? null,
    name: input.name,
  };
  const { snapshot, values } = useObject(backend, query, {
    overview: tab === "overview",
    manifest: tab === "yaml",
    events: tab === "events",
    related: tab === "related",
  });
  if (!input) return <EmptyState title="Not an object">{uri}</EmptyState>;
  const open = (target: ObjectRef) => {
    if (resources.state !== "ready") return;
    const next = refUri(input.space, resources.value, target);
    if (!next) return;
    editors.pin(uri);
    editors.open(next, { preview: true });
  };
  return (
    <div
      role="region"
      aria-label={OBJECT_TABS.find(({ id }) => id === tab)?.title}
      className={cn(
        "h-full bg-editor",
        tab === "yaml" ? "overflow-hidden" : "overflow-auto",
        (tab === "events" || tab === "related") && "p-3 text-[13px]",
      )}
    >
      {tab === "overview" && (
        <Shown snapshot={snapshot} has={snapshot.overview !== undefined}>
          {snapshot.overview && (
            <Overview
              overview={snapshot.overview}
              onOpen={open}
              values={values}
            />
          )}
        </Shown>
      )}
      {tab === "yaml" && (
        <Shown snapshot={snapshot} has={snapshot.manifest !== undefined}>
          {snapshot.manifest !== undefined && (
            <Manifest json={snapshot.manifest} />
          )}
        </Shown>
      )}
      {tab === "events" && (
        <Shown snapshot={snapshot} has={snapshot.events !== undefined}>
          {snapshot.events && <Events list={snapshot.events} />}
        </Shown>
      )}
      {tab === "related" && (
        <Shown snapshot={snapshot} has={snapshot.related !== undefined}>
          {snapshot.related && (
            <RelatedView related={snapshot.related} onOpen={open} />
          )}
        </Shown>
      )}
    </div>
  );
}

/** A part once it has come; before, a placeholder or why it cannot come. */
function Shown({
  snapshot,
  has,
  children,
}: {
  snapshot: ObjectSnapshot;
  has: boolean;
  children: ReactNode;
}) {
  const { status } = snapshot;
  const problem = <ViewStatus status={status} what="the object" />;
  if (
    status.state === "error" ||
    status.state === "forbidden" ||
    status.state === "unauthorized"
  )
    return problem;
  if (status.state === "ready" && !snapshot.exists)
    return <EmptyState title="The object does not exist" />;
  if (!has)
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  return children;
}

/** An object's owners and the objects it owns, or why those cannot be listed. */
export function RelatedView({
  related,
  onOpen,
}: {
  related: Related;
  onOpen: (target: ObjectRef) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <RelatedList title="Owners" objects={related.owners} onOpen={onOpen} />
      {related.unavailable === null ? (
        <RelatedList title="Owns" objects={related.owned} onOpen={onOpen} />
      ) : (
        <section aria-label="Owns">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            Owns
          </h3>
          <p className="text-error">{related.unavailable}</p>
        </section>
      )}
    </div>
  );
}

function RelatedList({
  title,
  objects,
  onOpen,
}: {
  title: string;
  objects: readonly RelatedObject[];
  onOpen: (target: ObjectRef) => void;
}) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
        {title}
      </h3>
      {objects.length === 0 ? (
        <p className="text-muted-foreground">None</p>
      ) : (
        <ul className="flex flex-col">
          {objects.map(({ target, controller }) => (
            <li
              key={`${target.kind}/${target.name}`}
              className="flex items-baseline gap-2"
            >
              <span className="w-28 shrink-0 text-muted-foreground">
                {target.kind}
              </span>
              <LinkButton
                onClick={() => {
                  onOpen(target);
                }}
                className="truncate"
              >
                {target.name}
              </LinkButton>
              {controller && (
                <span className="text-xs text-muted-foreground">
                  controller
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The editor's views as a switch at the right of its group's tab bar. */
export function ObjectTabSwitch({
  uri,
  tabs,
}: {
  uri: string;
  tabs: ObjectTabs;
}) {
  useChanges(tabs.changes);
  return (
    <Segmented<ObjectTab>
      label="Views of the object"
      items={OBJECT_TABS.map(({ id, title }) => ({ value: id, label: title }))}
      value={tabs.get(uri)}
      onChange={(value) => {
        tabs.set(uri, value);
      }}
    />
  );
}
