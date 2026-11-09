import type { LucideIcon } from "lucide-react";
import {
  ListView,
  toIpcError,
  type Backend,
  type Column,
  type ListSnapshot,
  type Resource,
  type Row,
} from "@twigo/protocol";
import { fuzzyMatch, type TextRange } from "@twigo/ui";
import {
  filtered,
  type QuickAccessProvider,
  type QuickPickItem,
  type RecentEditor,
  type Workbench,
} from "@twigo/workbench";
import { cellTone, IN_FLIGHT, statusColumn } from "./columns";
import { sameGvr, type Discovery } from "./discovery";
import { kindIcon, PODS, pluralTitle } from "./kinds";
import type { ListServices } from "./services";
import { listUri, parseListUri, parseObjectUri } from "./uri";

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
  const titled = (
    resource: Resource,
    extra?: string,
    search?: string,
  ): QuickPickItem => {
    const label = pluralTitle(resource.kind, resource.gvr.resource);
    const match = search === undefined ? undefined : fuzzyMatch(label, search);
    return {
      id: gvrId(resource),
      label,
      ...(match && { matches: match.ranges }),
      description: extra ?? names(resource),
      icon: kindIcon(resource.gvr),
    };
  };
  return {
    prefix: ":",
    placeholder:
      "A resource, then a namespace, /filter, label=value or @context",
    help: "Open a resource list, k9s style",
    hint: "Lists",
    toSide: true,
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
              ].map((name) => fuzzyMatch(name, query.resource)?.score ?? 0),
            ),
          }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ resource }) => titled(resource, undefined, query.resource));
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
    async accept(item, filter, _context, options) {
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
        { side: options?.side ?? false },
      );
    },
  };
}

/** A namespace's name is an RFC 1123 label. */
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** The namespaces of a space, or none when the person may not list them. */
async function listNamespaces(
  backend: Backend,
  space: string,
): Promise<readonly string[] | undefined> {
  try {
    return await backend.invoke("namespaces_list", space);
  } catch (error) {
    if (toIpcError(error).kind === "forbidden") return undefined;
    throw error;
  }
}

/**
 * `ns `: the active space's namespace scope (ARCHITECTURE 4.2). Whoever may
 * not list namespaces types one in.
 */
export function namespaceProvider(workbench: Workbench): QuickAccessProvider {
  const { spaces, backend } = workbench;
  const ALL = "all namespaces";
  return {
    prefix: "ns ",
    placeholder: "Scope the space to a namespace",
    help: "Set the namespace scope",
    acceptLabel: "Select",
    async items(filter) {
      const space = spaces.active;
      if (!space) return [];
      const search = filter.trim();
      const listed = await listNamespaces(backend, space.id);
      const typed = listed === undefined && NAMESPACE.test(search);
      const current = spaces.state(space.id).namespaces;
      const items = [ALL, ...(listed ?? (typed ? [search] : []))].map(
        (name) => ({
          id: name,
          label: name,
          ...(((name === ALL && current.length === 0) ||
            current.includes(name)) && {
            description: "current",
          }),
          ...(typed &&
            name === search &&
            !current.includes(name) && {
              description: "you may not list namespaces",
            }),
        }),
      );
      return typed ? items : filtered(items, search);
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
export function firstRows(view: ListView): Promise<ListSnapshot> {
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

const RECENT = "recent:";

/**
 * No prefix: the active space's recent editors that match, then its pods by
 * name, filtered in Rust as the live upstream serves them. Picking a pod
 * opens its list with its details shown, without a GET; ⌘↵ opens either to
 * the side.
 */
export function resourceProvider(
  workbench: Workbench,
  { selection, discovery }: Pick<ListServices, "selection" | "discovery">,
): QuickAccessProvider {
  const { spaces, backend, editors, recent } = workbench;
  const picks = new WeakMap<
    QuickPickItem,
    { space: string; columns: readonly Column[]; row: Row }
  >();
  return {
    prefix: "",
    placeholder: "Go to a recent editor or a pod by name",
    help: "Go to a resource",
    toSide: true,
    async items(filter) {
      const space = spaces.active;
      if (!space) return [];
      const served = discovery.last(space.id);
      const resources = served?.state === "ready" ? served.value : [];
      const recents = filtered(
        recent.list(space.id).map((entry) => recentItem(entry, resources)),
        filter,
      );
      const snapshot = await firstRows(
        new ListView(backend, {
          space: space.id,
          gvr: PODS,
          namespaced: true,
          namespaces: [...spaces.state(space.id).namespaces],
          labelSelector: null,
          fieldSelector: null,
          owners: null,
          text: filter.trim() === "" ? null : filter.trim(),
          columns: null,
          sort: null,
          countBy: null,
          groupBy: null,
          values: null,
        }),
      );
      const at = (column: string | undefined) =>
        snapshot.columns.findIndex((candidate) => candidate.name === column);
      const name = at("Name");
      const namespace = at("Namespace");
      const status = statusColumn(PODS);
      const statusAt = at(status);
      const pods = snapshot.ids.flatMap((id) => {
        const row = snapshot.rows.get(id);
        if (!row) return [];
        const label = String(row.cells[name] ?? id);
        const text = statusAt < 0 ? "" : String(row.cells[statusAt] ?? "");
        const tone = status && cellTone(PODS, status, text);
        const item: QuickPickItem = {
          id,
          label,
          matches: substring(label, filter),
          icon: kindIcon(PODS),
          ...(namespace >= 0 && {
            description: String(row.cells[namespace] ?? ""),
          }),
          ...(tone && {
            state: { tone, label: text, pulse: IN_FLIGHT.test(text) },
          }),
          kind: "Pod",
          group: "Pods",
        };
        picks.set(item, { space: space.id, columns: snapshot.columns, row });
        return [item];
      });
      return [...recents, ...pods];
    },
    accept(item, _filter, _context, options) {
      const side = options?.side ?? false;
      if (item.id.startsWith(RECENT)) {
        editors.open(item.id.slice(RECENT.length), { side });
        return;
      }
      const pick = picks.get(item);
      if (!pick) return;
      const uri = listUri({ space: pick.space, gvr: PODS, text: item.label });
      selection.set(uri, {
        gvr: PODS,
        kind: "Pod",
        namespaced: true,
        columns: pick.columns,
        row: pick.row,
        reveal: true,
      });
      editors.open(uri, { preview: true, side });
    },
  };
}

/** A recent editor as quick access and the home show it. */
export interface RecentRow {
  readonly label: string;
  readonly icon?: LucideIcon;
  /** An object's namespace, or a list's scope and filter. */
  readonly description?: string;
  readonly kind?: string;
}

/** A recent editor as a row: an object by its kind and namespace, a list by its scope and filter. */
export function recentRow(
  { uri, title }: RecentEditor,
  resources: readonly Resource[],
): RecentRow {
  const object = parseObjectUri(uri);
  const list = object ? undefined : parseListUri(uri);
  const gvr = object?.gvr ?? list?.gvr;
  const kind =
    object && resources.find((resource) => sameGvr(resource.gvr, object.gvr));
  const scope = list && [
    ...(list.namespaces ?? []),
    ...(list.text ? [`/${list.text}`] : []),
  ];
  return {
    label: title,
    ...(gvr && { icon: kindIcon(gvr) }),
    ...(object?.namespace && { description: object.namespace }),
    ...(scope && scope.length > 0 && { description: scope.join(" ") }),
    ...(kind ? { kind: kind.kind } : list && { kind: "List" }),
  };
}

function recentItem(
  entry: RecentEditor,
  resources: readonly Resource[],
): QuickPickItem {
  return {
    id: `${RECENT}${entry.uri}`,
    ...recentRow(entry, resources),
    group: "Recent",
  };
}

/**
 * Where the pods' filter found the text in a name: Rust keeps a row whose
 * text holds it as a substring in any case of ASCII letters
 * (twigo-cache's view filter); a negation or a regex marks nothing.
 */
export function substring(label: string, filter: string): TextRange[] {
  const search = lowerAscii(filter.trim());
  const at = search === "" ? -1 : lowerAscii(label).indexOf(search);
  return at < 0 ? [] : [{ start: at, end: at + search.length }];
}

function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
