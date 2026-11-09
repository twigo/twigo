import { useEffect, useMemo } from "react";
import type { ObjectRef } from "@twigo/protocol";
import { EmptyState, InlineActions, Segmented } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import {
  hasStatusSubresource,
  useResources,
  type Discovery,
} from "../discovery";
import type { EditServices } from "../edit/services";
import { YamlTab } from "../edit/YamlTab";
import { canShell } from "../exec/kinds";
import { logsKind } from "../logs/entries";
import { parseObjectUri } from "../uri";
import { ObjectContent } from "./ObjectContent";
import type { OverviewStates } from "./overviewStates";
import { OBJECT_TABS, type ObjectTab, type ObjectTabs } from "./tabs";
import { useReveal } from "./reveal";
import { objectQuery, refUri, useObject } from "./useObject";

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
  edits,
}: EditorProps & {
  discovery: Discovery;
  overviews: OverviewStates;
  tabs: ObjectTabs;
  edits: EditServices;
}) {
  const { backend, editors, commands, keys } = useWorkbench();
  const input = useMemo(() => parseObjectUri(uri), [uri]);
  const resources = useResources(discovery, input?.space ?? "");
  useChanges(tabs.changes);
  useChanges(edits.copies.changes);
  const tab = tabs.get(uri);
  const query = input && objectQuery(input, resources);
  // An edit holds the object's text until it is applied, and an applied one
  // until the object shows it, so the object is followed for what changes
  // under it, whichever view is shown.
  const editing =
    edits.copies.get(uri) !== undefined || edits.copies.held(uri) !== undefined;
  const { snapshot, values, id } = useObject(backend, query, {
    overview: tab === "overview",
    manifest: tab === "yaml" || editing,
    events: tab === "events",
    related: tab === "related",
  });
  const reveal = useReveal(id);
  const statusLocked = hasStatusSubresource(resources, input?.gvr);
  const manifest = snapshot.manifest;
  useEffect(() => {
    if (manifest !== undefined) edits.copies.see(uri, manifest, statusLocked);
  }, [edits.copies, uri, manifest, statusLocked]);
  if (!input) return <EmptyState title="Not an object">{uri}</EmptyState>;
  const opened = edits.copies.get(uri)?.base;
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
      reveal={reveal}
      onOpen={open}
      yaml={(json) => (
        <YamlTab
          edits={edits}
          uri={uri}
          space={input.space}
          json={json}
          statusLocked={statusLocked}
        />
      )}
      {...(opened !== undefined && {
        kept: (problem: { title: string; body: string }) => (
          <YamlTab
            edits={edits}
            uri={uri}
            space={input.space}
            json={opened}
            statusLocked={statusLocked}
            gone={problem}
          />
        ),
      })}
      {...(input.namespace !== undefined && {
        onLogs: (choice) => {
          void commands.execute("k8s.logs.open", keys.lookup(null), {
            space: input.space,
            gvr: input.gvr,
            namespace: input.namespace,
            name: input.name,
            ...choice,
          });
        },
      })}
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
  const workbench = useWorkbench();
  useChanges(tabs.changes);
  useChanges(workbench.menus.changes);
  useChanges(workbench.keys.changes);
  const input = parseObjectUri(uri);
  const lookup = workbench.keys.lookup(null);
  // The editor's object, as a row's keys tell a row's commands about it.
  const scoped = (key: string) => {
    if (key === "resource.logs") {
      return input !== undefined && logsKind(input.gvr) !== undefined;
    }
    if (key === "resource.shell") {
      return input !== undefined && canShell(input.gvr);
    }
    return lookup(key);
  };
  return (
    <div className="flex items-center gap-2">
      <InlineActions
        actions={workbench
          .actions(
            "editor/title",
            scoped,
            input?.namespace === undefined
              ? undefined
              : { ...input, namespace: input.namespace },
          )
          .flat()}
      />
      <Segmented<ObjectTab>
        label="Views of the object"
        items={OBJECT_TABS.map(({ id, title }) => ({
          value: id,
          label: title,
        }))}
        value={tabs.get(uri)}
        onChange={(value) => {
          tabs.set(uri, value);
        }}
      />
    </div>
  );
}
