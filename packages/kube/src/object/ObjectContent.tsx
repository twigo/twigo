import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type {
  ObjectRef,
  ObjectSnapshot,
  Related,
  RelatedObject,
} from "@twigo/protocol";
import { cn, EmptyState, LinkButton, Skeleton } from "@twigo/ui";
import { ViewStatus } from "../ViewStatus";
import { isProblem, objectProblem } from "../viewProblem";
import { Manifest } from "../edit/Manifest";
import { Events, Overview, type OverviewProps } from "./Overview";
import type { PageStates } from "./pageStates";
import { keepPlace } from "./place";
import { OBJECT_TABS, type ObjectTab } from "./tabs";

/** The one label column of an object's page, which every property list in it reads. */
export const LABEL_COLUMN = "[--label-column:112px]";

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
  pages,
  uri,
  object,
  snapshot,
  values,
  reveal,
  yaml,
  kept,
  onOpen,
  onLogs,
  onEvents,
  fullPage,
}: {
  tab: ObjectTab;
  /** The object's space, which its Overview's live lists query. */
  space: string;
  states: OverviewProps["states"];
  /** The object's resource, `apps/deployments`. */
  kind: string;
  pages: PageStates;
  uri: string;
  /** The object shown, as `namespace/name`. */
  object: string;
  snapshot: ObjectSnapshot;
  values: OverviewProps["values"];
  reveal?: OverviewProps["reveal"];
  /** The YAML tab of an editor that edits; without it the tab is read-only, as the details show it. */
  yaml?: (json: string) => ReactNode;
  /**
   * The YAML tab of an object that has an edit, for when the object is gone
   * or cannot be read: the edit stays reachable, with why in its bar.
   */
  kept?: (problem: { title: string; body: string }) => ReactNode;
  onOpen: (target: ObjectRef) => void;
  onLogs?: OverviewProps["onLogs"];
  onEvents: OverviewProps["onEvents"];
  /** The full page, whose sections open but the Metadata. */
  fullPage?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const overview = tab === "overview" && snapshot.overview !== undefined;
  useEffect(() => {
    const element = scroller.current;
    return element ? pages.attach(uri, element) : undefined;
  }, [pages, uri]);
  // Another object of the kind opens where the last was left, which one of
  // its changes, drawn again, must not undo.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!overview || !element) return;
    return keepPlace(element, pages.place(uri), (place) => {
      pages.setPlace(uri, place);
    });
  }, [pages, uri, overview]);
  return (
    <div
      ref={scroller}
      role="tabpanel"
      aria-label={OBJECT_TABS.find(({ id }) => id === tab)?.title}
      tabIndex={-1}
      className={cn(
        "h-full bg-editor outline-none",
        LABEL_COLUMN,
        tab === "yaml" ? "overflow-hidden" : "overflow-auto",
        (tab === "events" || tab === "related") && "p-3 text-body",
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
              object={object}
              pages={pages}
              uri={uri}
              onOpen={onOpen}
              values={values}
              reveal={reveal}
              onLogs={onLogs}
              onEvents={onEvents}
              usage={snapshot.usage}
              {...(fullPage !== undefined && { fullPage })}
            />
          )}
        </Shown>
      )}
      {tab === "yaml" && (
        <Shown
          snapshot={snapshot}
          has={snapshot.manifest !== undefined}
          kept={kept}
        >
          {snapshot.manifest !== undefined &&
            (yaml?.(snapshot.manifest) ?? (
              <Manifest json={snapshot.manifest} />
            ))}
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
  kept,
  children,
}: {
  snapshot: ObjectSnapshot;
  has: boolean;
  kept?: (problem: { title: string; body: string }) => ReactNode;
  children: ReactNode;
}) {
  const { status } = snapshot;
  const found = objectProblem(snapshot);
  if (found && kept) return kept(found);
  if (isProblem(status))
    return <ViewStatus status={status} what="the object" />;
  if (found) return <EmptyState title="The object does not exist" />;
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
          <h3 className="mb-1 text-xs font-semibold text-support">Owns</h3>
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
      <h3 className="mb-1 text-xs font-semibold text-support">{title}</h3>
      {objects.length === 0 ? (
        <p className="text-support">None</p>
      ) : (
        <ul className="flex flex-col">
          {objects.map(({ target, controller }) => (
            <li
              key={`${target.kind}/${target.name}`}
              className="flex items-baseline gap-2"
            >
              <span className="w-28 shrink-0 text-support">{target.kind}</span>
              <LinkButton
                onClick={() => {
                  onOpen(target);
                }}
                className="truncate"
              >
                {target.name}
              </LinkButton>
              {controller && (
                <span className="text-xs text-support">controller</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
