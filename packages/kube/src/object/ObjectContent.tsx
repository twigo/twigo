import type { ReactNode } from "react";
import type {
  ObjectRef,
  ObjectSnapshot,
  Related,
  RelatedObject,
} from "@twigo/protocol";
import { cn, EmptyState, LinkButton, Skeleton } from "@twigo/ui";
import { ViewStatus } from "../ViewStatus";
import { Manifest } from "./Manifest";
import { Events, Overview, type OverviewProps } from "./Overview";
import { OBJECT_TABS, type ObjectTab } from "./tabs";

/**
 * One view of an object (ARCHITECTURE 4.3): its Overview, YAML, events or
 * related objects, or why that view cannot show; the editor and the
 * details both draw an object through it.
 */
export function ObjectContent({
  tab,
  space,
  states,
  kind,
  snapshot,
  values,
  onOpen,
  onLogs,
}: {
  tab: ObjectTab;
  /** The object's space, which its Overview's live lists query. */
  space: string;
  states: OverviewProps["states"];
  /** The object's resource, `apps/deployments`. */
  kind: string;
  snapshot: ObjectSnapshot;
  values: OverviewProps["values"];
  onOpen: (target: ObjectRef) => void;
  onLogs?: OverviewProps["onLogs"];
}) {
  return (
    <div
      role="tabpanel"
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
              space={space}
              states={states}
              kind={kind}
              onOpen={onOpen}
              values={values}
              onLogs={onLogs}
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
            <RelatedView related={snapshot.related} onOpen={onOpen} />
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
