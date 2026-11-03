import { useMemo } from "react";
import type { ObjectQuery, ObjectRef } from "@twigo/protocol";
import { EmptyState, Segmented } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { sameGvr, useResources, type Discovery } from "../discovery";
import { parseObjectUri } from "../uri";
import { ObjectContent } from "./ObjectContent";
import type { OverviewStates } from "./overviewStates";
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
  overviews,
  tabs,
}: EditorProps & {
  discovery: Discovery;
  overviews: OverviewStates;
  tabs: ObjectTabs;
}) {
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
    <ObjectContent
      tab={tab}
      space={input.space}
      states={overviews}
      kind={`${input.gvr.group}/${input.gvr.resource}`}
      snapshot={snapshot}
      values={values}
      onOpen={open}
    />
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
