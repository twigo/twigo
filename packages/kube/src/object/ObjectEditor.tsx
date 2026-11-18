import { useEffect, useMemo, useState } from "react";
import { Copy } from "lucide-react";
import type { Cell, ObjectRef } from "@twigo/protocol";
import {
  ActionRow,
  cn,
  EmptyState,
  FullActionRow,
  IconButton,
} from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import {
  CAPABILITY_PREFIXES,
  type Asked,
  type Capabilities,
} from "../capabilities";
import {
  hasStatusSubresource,
  servedAs,
  useResources,
  type Discovery,
} from "../discovery";
import type { EditServices } from "../edit/services";
import { YamlTab } from "../edit/YamlTab";
import { canShell } from "../exec/kinds";
import { canForward } from "../forward/kinds";
import { logsKind } from "../logs/entries";
import { replicasOf } from "../resourceActions";
import type { Subject } from "../resourceActions";
import { rowState } from "../rowState";
import { parseObjectUri } from "../uri";
import { useVisible } from "../useVisible";
import { ObjectContent } from "./ObjectContent";
import { ObjectHeader } from "./ObjectHeader";
import { noContainerRuns } from "./noContainerRuns";
import { ObjectViews } from "./ObjectViews";
import { FULL_PAGE, TWO_COLUMNS, useClientWidth, useHeld } from "./pageStage";
import { PropertyColumns } from "./propertyColumns";
import { SummaryColumn } from "./SummaryColumn";
import type { Outline } from "./outline";
import type { OverviewStates } from "./overviewStates";
import {
  OBJECT_FILTERED,
  OBJECT_SUBJECT,
  OBJECT_URI,
  useFiltered,
  type PageStates,
} from "./pageStates";
import type { ObjectTabs } from "./tabs";
import { useReveal } from "./reveal";
import { hasUsage } from "./figures";
import { objectQuery, refResource, refUri, useObject } from "./useObject";
import { useHeader } from "./useHeader";
import { Vitals } from "./Vitals";

/**
 * A `k8s://` editor (ARCHITECTURE 4.3): one object, live, as its Overview,
 * its YAML, its events and its related objects, under the same header as the
 * inspector's, whose commands act on this object; Rust follows only the tab
 * shown.
 */
export function ObjectEditor({
  uri,
  discovery,
  overviews,
  pages,
  tabs,
  edits,
  capabilities,
  fullPages,
}: EditorProps & {
  discovery: Discovery;
  overviews: OverviewStates;
  pages: PageStates;
  tabs: ObjectTabs;
  edits: EditServices;
  capabilities: Capabilities;
  /** What the person chose in the full page's sections, apart from the inspector's. */
  fullPages: OverviewStates;
}) {
  const workbench = useWorkbench();
  const { backend, editors, commands, keys, menus, catalog, spaces, colors } =
    workbench;
  const input = useMemo(() => parseObjectUri(uri), [uri]);
  const resources = useResources(discovery, input?.space ?? "");
  useChanges(tabs.changes);
  useChanges(edits.copies.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  useChanges(commands.changes);
  useChanges(capabilities.changes);
  useChanges(catalog.changes);
  useChanges(spaces.changes);
  useChanges(colors.changes);
  const tab = tabs.get(uri);
  const visible = useVisible();
  const query = input && objectQuery(input, resources);
  // An edit holds the object's text until it is applied, and an applied one
  // until the object shows it, so the object is followed for what changes
  // under it, whichever view is shown.
  const editing =
    edits.copies.get(uri) !== undefined || edits.copies.held(uri) !== undefined;
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const [main, setMain] = useState<HTMLElement | null>(null);
  const wide = useHeld(useClientWidth(element), FULL_PAGE);
  const columnDrawn = useClientWidth(column) > 0;
  const mainWidth = useClientWidth(main);
  const two = useHeld(columnDrawn ? mainWidth : 0, TWO_COLUMNS);
  const asked =
    (tab === "overview" || wide) &&
    visible &&
    input !== undefined &&
    hasUsage(input.gvr);
  const { snapshot, values, id } = useObject(backend, query, {
    overview: true,
    manifest: tab === "yaml" || editing,
    events: tab === "events",
    related: tab === "related",
    usage: asked,
  });
  const reveal = useReveal(id);
  const page = tab === "overview";
  const filtered = useFiltered(pages, uri) && page;
  const known =
    resources.state === "ready" && input
      ? servedAs(resources.value, input.gvr)
      : undefined;
  const header = snapshot.overview?.header;
  const printed = (column: string): Cell | undefined =>
    header?.printed.find((cell) => cell.column === column)?.value;
  const referenced = CAPABILITY_PREFIXES.flatMap((prefix) =>
    commands.referenced(prefix),
  );
  const object = JSON.stringify({
    namespace: input?.namespace,
    name: input?.name,
  });
  const keysAsked = JSON.stringify(referenced);
  const contexts = catalog.list;
  useEffect(() => {
    if (input)
      capabilities.ask(
        uri,
        input.space,
        input.gvr,
        JSON.parse(object) as Asked,
        JSON.parse(keysAsked) as string[],
        contexts,
      );
  }, [capabilities, uri, input, object, keysAsked, contexts]);
  const replicas = replicasOf(printed);
  const subject: Subject | undefined = input &&
    known && {
      space: input.space,
      gvr: input.gvr,
      kind: known.kind,
      namespaced: known.namespaced,
      ...(input.namespace !== undefined && { namespace: input.namespace }),
      name: input.name,
      ...(replicas !== undefined && { replicas }),
    };
  const named = subject && JSON.stringify(subject);
  const scoped = JSON.stringify({
    ...capabilities.values(uri, referenced),
    ...(known && { ...rowState(known, header && printed) }),
    "resource.noContainerRuns": noContainerRuns(snapshot.overview),
  });
  useEffect(() => {
    if (!element || !input) return;
    const scope = keys.scope(element);
    scope.set("pageFocus", page);
    scope.set(OBJECT_URI, page ? uri : undefined);
    scope.set(OBJECT_FILTERED, filtered);
    scope.set(OBJECT_SUBJECT, named);
    scope.set("resource.selected", named !== undefined);
    scope.set("resource.logs", logsKind(input.gvr) !== undefined);
    scope.set("resource.shell", canShell(input.gvr));
    scope.set("resource.forward", canForward(input.gvr));
    scope.set("resource.group", input.gvr.group);
    scope.set("resource.namespaced", known?.namespaced ?? false);
    scope.set(
      "resource.scalable",
      known?.subresources.includes("scale") ?? false,
    );
    scope.set("resource.kind", known?.kind ?? "");
    for (const [key, value] of Object.entries(
      JSON.parse(scoped) as Record<string, boolean>,
    ))
      scope.set(key, value);
    return () => {
      scope.dispose();
    };
  }, [keys, element, input, known, page, filtered, uri, scoped, named]);
  const statusLocked = hasStatusSubresource(resources, input?.gvr);
  const manifest = snapshot.manifest;
  useEffect(() => {
    if (manifest !== undefined) edits.copies.see(uri, manifest, statusLocked);
  }, [edits.copies, uri, manifest, statusLocked]);
  const { verdict, strip, line } = useHeader({
    gvr: input?.gvr,
    header,
    usage: snapshot.usage,
  });
  if (!input) return <EmptyState title="Not an object">{uri}</EmptyState>;
  const opened = edits.copies.get(uri)?.base;
  const open = (target: ObjectRef) => {
    if (resources.state !== "ready") return;
    const next = refUri(input.space, resources.value, target);
    if (!next) return;
    editors.pin(uri);
    editors.open(next, { preview: true });
  };
  const lookup = keys.lookup(element);
  const owner = header?.owner ?? undefined;
  const space = spaces.list.find((each) => each.id === input.space);
  const color = space && colors.ofSpace(space);
  const resource = `${input.gvr.group}/${input.gvr.resource}`;
  const states = wide ? fullPages : overviews;
  const identity = `${input.space}/${input.namespace ?? ""}/${input.name}`;
  const reach = (section: Outline) => {
    if (pages.text(uri) !== "") {
      if (pages.shut(uri).has(section.id))
        pages.setShut(uri, [section.id], false);
    } else if (!states.section(resource, identity, section.id, section.fold))
      states.setSection(resource, identity, section, true);
    if (tab !== "overview") tabs.set(uri, "overview");
    pages.reachSection(uri, section.id);
  };
  const actions =
    subject && workbench.actions("resource/details", lookup, subject);
  return (
    <div
      ref={setElement}
      role="region"
      aria-label={`${known?.kind ?? input.gvr.resource} ${input.name}`}
      className="flex h-full min-h-0 flex-col bg-editor"
    >
      <ObjectHeader
        gvr={input.gvr}
        kind={known?.kind ?? input.gvr.resource}
        name={input.name}
        generated={header?.generated ?? null}
        controls={
          <IconButton
            icon={Copy}
            label="Copy Name"
            onClick={() => {
              void commands.execute("k8s.resource.copyName", lookup, subject);
            }}
          />
        }
        {...(wide &&
          space && { space: { name: space.contexts.join(" + "), color } })}
        namespace={input.namespace}
        owner={
          owner && {
            target: owner,
            gvr:
              resources.state === "ready"
                ? refResource(resources.value, owner)?.gvr
                : undefined,
          }
        }
        node={header?.node ?? undefined}
        created={header?.created ?? undefined}
        verdict={verdict}
        sentence={header?.sentence ?? []}
        verdictLine={line}
        onOpen={open}
        actions={
          subject &&
          actions &&
          (wide ? (
            <FullActionRow
              label={`${subject.kind} actions`}
              actions={actions}
            />
          ) : (
            <ActionRow label={`${subject.kind} actions`} actions={actions} />
          ))
        }
      />
      <div className={cn("flex min-h-0 flex-1", !wide && "flex-col")}>
        {wide && (
          <SummaryColumn
            frame={setColumn}
            cells={strip}
            verdict={verdict}
            overview={snapshot.overview}
            usage={snapshot.usage !== undefined && resource === "/nodes"}
            pages={pages}
            uri={uri}
            onReach={reach}
          />
        )}
        <div ref={setMain} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ObjectViews
            tab={tab}
            snapshot={snapshot}
            onChange={(next) => {
              tabs.set(uri, next);
            }}
            pages={pages}
            uri={uri}
            kind={known?.kind ?? "object"}
          />
          {page && !wide && (
            <Vitals cells={strip} verdict={verdict} layout="strip" />
          )}
          <div className="min-h-0 flex-1">
            <PropertyColumns.Provider value={wide && two ? 2 : 1}>
              <ObjectContent
                tab={tab}
                space={input.space}
                states={states}
                kind={resource}
                pages={pages}
                uri={uri}
                object={`${input.namespace ?? ""}/${input.name}`}
                snapshot={snapshot}
                values={values}
                reveal={reveal}
                onOpen={open}
                onEvents={() => {
                  tabs.set(uri, "events");
                }}
                fullPage={wide}
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
            </PropertyColumns.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
