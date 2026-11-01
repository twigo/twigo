import { ListView, type ListSnapshot, type Resource } from "@twigo/protocol";
import { commandScore } from "@twigo/ui";
import type {
  QuickAccessProvider,
  QuickPickItem,
  Workbench,
} from "@twigo/workbench";
import type { Discovery } from "./discovery";
import { kindIcon, PODS, pluralTitle } from "./kinds";
import type { Selection } from "./selection";
import { listUri } from "./uri";

/** A `:` query in k9s's grammar: `po payments /api app=web @prod-eu`. */
export interface K9sQuery {
  readonly resource: string;
  readonly namespace?: string;
  readonly text?: string;
  readonly labels?: string;
  readonly context?: string;
}

export function parseK9s(input: string): K9sQuery | undefined {
  const [resource, ...rest] = input.trim().split(/\s+/).filter(Boolean);
  if (!resource) return undefined;
  const labels: string[] = [];
  let query: K9sQuery = { resource };
  for (const token of rest) {
    if (token.startsWith("/")) query = { ...query, text: token.slice(1) };
    else if (token.startsWith("@"))
      query = { ...query, context: token.slice(1) };
    else if (token.includes("=")) labels.push(token);
    else query = { ...query, namespace: token };
  }
  return labels.length > 0 ? { ...query, labels: labels.join(",") } : query;
}

/**
 * The resource a name means, as kubectl resolves it: plural, singular, short
 * name or kind. Discovery lists the core group first, so `events` is core.
 */
export function resolveResource(
  resources: readonly Resource[],
  name: string,
): Resource | undefined {
  const wanted = name.toLowerCase();
  return resources.find(
    (resource) =>
      resource.gvr.resource === wanted ||
      resource.singular === wanted ||
      resource.kind.toLowerCase() === wanted ||
      resource.shortNames.includes(wanted),
  );
}

function gvrId({ gvr }: Resource): string {
  return `${gvr.group}/${gvr.version}/${gvr.resource}`;
}

function names(resource: Resource): string {
  return [...resource.shortNames, resource.gvr.resource].join(" · ");
}

/** `:`: opens or focuses a resource list, k9s style (ARCHITECTURE 4.5). */
export function listProvider(
  workbench: Workbench,
  discovery: Discovery,
): QuickAccessProvider {
  const { spaces, editors } = workbench;
  const titled = (resource: Resource, extra?: string): QuickPickItem => ({
    id: gvrId(resource),
    label: pluralTitle(resource.kind, resource.gvr.resource),
    description: extra ?? names(resource),
    icon: kindIcon(resource.gvr),
  });
  return {
    prefix: ":",
    placeholder:
      "A resource, then a namespace, /filter, label=value or @context",
    help: "Open a resource list, k9s style",
    async items(filter) {
      const space = spaces.active;
      if (!space) return [];
      const resources = await discovery.resources(space.id);
      const query = parseK9s(filter);
      if (!query) {
        return resources.map((resource) => titled(resource));
      }
      if (!/\s/.test(filter.trim())) {
        return resources
          .map((resource) => ({
            resource,
            score: Math.max(
              ...[
                ...resource.shortNames,
                resource.gvr.resource,
                resource.kind,
              ].map((name) => commandScore(name, query.resource, [])),
            ),
          }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ resource }) => titled(resource));
      }
      const resource = resolveResource(resources, query.resource);
      if (!resource) return [];
      const parts = [
        query.namespace && `in ${query.namespace}`,
        query.text && `/${query.text}`,
        query.labels,
        query.context && `@${query.context}`,
      ].filter(Boolean);
      return [titled(resource, parts.join(" "))];
    },
    async accept(item, filter) {
      const space = spaces.active;
      if (!space) return;
      const resources = await discovery.resources(space.id);
      const query = parseK9s(filter);
      const typed = query && /\s/.test(filter.trim()) ? query : undefined;
      const resource = typed
        ? resolveResource(resources, typed.resource)
        : resources.find((candidate) => gvrId(candidate) === item.id);
      if (!resource) return;
      const target = typed?.context ? await spaces.open(typed.context) : space;
      editors.open(
        listUri({
          space: target.id,
          gvr: resource.gvr,
          ...(typed?.namespace &&
            typed.namespace !== "all" && { namespaces: [typed.namespace] }),
          ...(typed?.text && { text: typed.text }),
          ...(typed?.labels && { labels: typed.labels }),
        }),
      );
    },
  };
}

/** `ns `: the active space's namespace scope (ARCHITECTURE 4.2). */
export function namespaceProvider(workbench: Workbench): QuickAccessProvider {
  const { spaces, backend } = workbench;
  const ALL = "all namespaces";
  return {
    prefix: "ns ",
    placeholder: "Scope the space to a namespace",
    help: "Set the namespace scope",
    async items(filter) {
      const space = spaces.active;
      if (!space) return [];
      const namespaces = await backend.invoke("namespaces_list", space.id);
      const current = spaces.state(space.id).namespaces;
      const items = [ALL, ...namespaces].map((name) => ({
        id: name,
        label: name,
        ...(((name === ALL && current.length === 0) ||
          current.includes(name)) && {
          description: "current",
        }),
      }));
      const search = filter.trim();
      return search === ""
        ? items
        : items.filter((item) => commandScore(item.label, search, []) > 0);
    },
    accept(item) {
      const space = spaces.active;
      if (!space) return;
      spaces.update(space.id, (state) => ({
        ...state,
        namespaces: item.id === ALL ? [] : [item.id],
      }));
    },
  };
}

const MATCHES = 30;
const WAIT_MS = 3000;

/** The first rows a list query returns, then the subscription closes. */
function firstRows(view: ListView): Promise<ListSnapshot> {
  return new Promise((resolve) => {
    const done = (snapshot: ListSnapshot) => {
      clearTimeout(timer);
      stop();
      view.close();
      resolve(snapshot);
    };
    const timer = setTimeout(() => {
      done(view.getSnapshot());
    }, WAIT_MS);
    const stop = view.subscribe(() => {
      const snapshot = view.getSnapshot();
      const { state } = snapshot.status;
      if (
        ["ready", "relisting", "stale"].includes(state) &&
        snapshot.columns.length > 0
      ) {
        done(snapshot);
      } else if (["forbidden", "unauthorized", "error"].includes(state)) {
        done(snapshot);
      }
    });
    view.setWindow(0, MATCHES);
  });
}

/**
 * No prefix: pods of the active space by name, filtered in Rust, as the live
 * upstream serves them; picking one opens its list with its details shown,
 * without a GET.
 */
export function resourceProvider(
  workbench: Workbench,
  selection: Selection,
): QuickAccessProvider {
  const { spaces, backend, editors } = workbench;
  let shown: { space: string; snapshot: ListSnapshot } | undefined;
  return {
    prefix: "",
    placeholder: "Go to a pod by name",
    help: "Go to a resource",
    async items(filter) {
      const space = spaces.active;
      if (!space) return [];
      const snapshot = await firstRows(
        new ListView(backend, {
          space: space.id,
          gvr: PODS,
          namespaces: [...spaces.state(space.id).namespaces],
          labelSelector: null,
          text: filter.trim() === "" ? null : filter.trim(),
          sort: null,
          groupBy: null,
        }),
      );
      shown = { space: space.id, snapshot };
      const name = snapshot.columns.findIndex(
        (column) => column.name === "Name",
      );
      const namespace = snapshot.columns.findIndex(
        (column) => column.name === "Namespace",
      );
      return snapshot.ids.flatMap((id) => {
        const row = snapshot.rows.get(id);
        if (!row) return [];
        return [
          {
            id,
            label: String(row.cells[name] ?? id),
            ...(namespace >= 0 && {
              description: String(row.cells[namespace] ?? ""),
            }),
          },
        ];
      });
    },
    accept(item) {
      const row = shown?.snapshot.rows.get(item.id);
      if (!shown || !row) return;
      selection.set({
        space: shown.space,
        gvr: PODS,
        kind: "Pod",
        columns: shown.snapshot.columns,
        row,
        reveal: true,
      });
      editors.open(
        listUri({ space: shown.space, gvr: PODS, text: item.label }),
        {
          preview: true,
        },
      );
    },
  };
}
