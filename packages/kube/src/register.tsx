import { FileCode, FolderTree, GitCompare } from "lucide-react";
import { Changes, type Workbench } from "@twigo/workbench";
import { Explorer, EXPLORER_VIEW } from "./explorer/Explorer";
import { registerEdits } from "./edit/commands";
import { DiffEditor } from "./edit/DiffEditors";
import { ManifestEditor } from "./edit/ManifestEditor";
import { Home } from "./home/Home";
import { ListIcon, ObjectIcon } from "./KindIcon";
import { ListActions } from "./list/ListActions";
import { ListEditor } from "./list/ListEditor";
import { clusterEntries, listEntries } from "./list/statusEntries";
import { ObjectEditor, ObjectTabSwitch } from "./object/ObjectEditor";
import { ObjectTabs } from "./object/tabs";
import {
  listProvider,
  namespaceProvider,
  resourceProvider,
} from "./quickaccess";
import { registerLogs } from "./logs/register";
import { LogsTabs } from "./logs/state";
import { registerResourceActions } from "./resourceActions";
import { editorSpace } from "./edit/services";
import { createServices, type ListServices } from "./services";
import {
  DIFF_SCHEME,
  LIST_SCHEME,
  OBJECT_SCHEME,
  parseDiffUri,
  parseListUri,
  parseObjectUri,
  parseUntitledUri,
  UNTITLED_SCHEME,
} from "./uri";

/** Kubernetes in the workbench, through its registries only (ARCHITECTURE 2.3). */
export function registerKube(workbench: Workbench): void {
  const services = createServices(workbench);
  const { views, editors, commands, keybindings, quickAccess, menus } =
    workbench;

  quickAccess.register(listProvider(workbench, services.discovery));
  quickAccess.register(namespaceProvider(workbench));
  quickAccess.register(resourceProvider(workbench, services));
  [
    { id: "k8s.list.open", title: "Open Resource List…", prefix: ":" },
    { id: "k8s.namespace.select", title: "Select Namespace…", prefix: "ns " },
  ].forEach(({ id, title, prefix }, order) => {
    commands.register({
      id,
      title,
      category: "Kubernetes",
      run: () => {
        quickAccess.show(prefix);
      },
    });
    menus.append("menubar/go", { command: id, group: "3_kubernetes", order });
  });

  views.registerContainer({
    id: "kube.explorer",
    title: "Explorer",
    icon: FolderTree,
    location: "sidebar",
    order: 0,
  });
  views.registerView({
    id: EXPLORER_VIEW,
    title: "Resources",
    container: "kube.explorer",
    component: () => <Explorer services={services} />,
  });
  views.registerStatusBarItem({
    id: "kube.cluster",
    alignment: "left",
    priority: 900,
    useEntries: clusterEntries(services.statuses, services.discovery),
  });
  views.registerStatusBarItem({
    id: "kube.list",
    alignment: "right",
    priority: 100,
    useEntries: listEntries(services),
  });
  registerSpaceStatus(workbench, services);
  views.registerWatermark({
    id: "kube.home",
    when: "!space.multiContext",
    component: ({ space }) => <Home space={space} services={services} />,
  });

  editors.register({
    id: "kube.list",
    scheme: LIST_SCHEME,
    space: (uri) => parseListUri(uri.href)?.space,
    title: (uri) => {
      const resource = parseListUri(uri.href)?.gvr.resource ?? uri.href;
      return resource.charAt(0).toUpperCase() + resource.slice(1);
    },
    icon: ListIcon,
    component: ({ uri }) => <ListEditor uri={uri} services={services} />,
    actions: ({ uri }) => <ListActions uri={uri} services={services} />,
  });

  const objectTabs = new ObjectTabs();
  editors.register({
    id: "kube.object",
    scheme: OBJECT_SCHEME,
    space: (uri) => parseObjectUri(uri.href)?.space,
    title: (uri) => parseObjectUri(uri.href)?.name ?? uri.href,
    icon: ObjectIcon,
    component: ({ uri }) => (
      <ObjectEditor
        uri={uri}
        discovery={services.discovery}
        overviews={services.overviews}
        tabs={objectTabs}
        edits={services.edits}
      />
    ),
    actions: ({ uri }) => <ObjectTabSwitch uri={uri} tabs={objectTabs} />,
  });

  editors.register({
    id: "kube.diff",
    scheme: DIFF_SCHEME,
    space: (uri) => {
      const input = parseDiffUri(uri.href);
      if (input?.kind === "objects") return input.space;
      return input && editorSpace(services.edits, input.editor);
    },
    title: (uri) => {
      const input = parseDiffUri(uri.href);
      if (!input) return uri.href;
      const name = (editor: string) =>
        parseObjectUri(editor)?.name ?? editor.replace(/^\w+:\/\//, "");
      switch (input.kind) {
        case "apply":
          return `Apply · ${name(input.editor)}`;
        case "server":
          return `Server · ${name(input.editor)}`;
        case "objects":
          return `${name(input.left)} ↔ ${name(input.right)}`;
      }
    },
    icon: ({ className }) => <GitCompare className={className} />,
    component: ({ uri }) => (
      <DiffEditor
        uri={uri}
        edits={services.edits}
        discovery={services.discovery}
      />
    ),
  });

  editors.register({
    id: "kube.manifest",
    scheme: UNTITLED_SCHEME,
    space: (uri) => services.edits.copies.get(uri.href)?.space,
    title: (uri) => `Manifest ${String(parseUntitledUri(uri.href) ?? "")}`,
    icon: ({ className }) => <FileCode className={className} />,
    component: ({ uri }) => (
      <ManifestEditor
        uri={uri}
        edits={services.edits}
        discovery={services.discovery}
      />
    ),
  });

  commands.register({
    id: "k8s.details.close",
    title: "Close Details",
    category: "Resource",
    enablement: "detailsOpen",
    run: () => workbench.lists.focused("close")?.close(),
  });
  keybindings.register("core", [
    { key: "escape", command: "k8s.details.close", when: "detailsOpen" },
  ]);
  registerLogs(workbench, new LogsTabs(workbench.backend));
  registerResourceActions(workbench, services);
  registerEdits(workbench, {
    discovery: services.discovery,
    edits: services.edits,
    tabs: objectTabs,
  });
}

/**
 * Each space's connection on its rail tile (ARCHITECTURE 4.2), as
 * discovery last answered: Rust follows the active space only, so a space
 * left behind shows idle until it is active again, or the failure it had.
 * A one-context space's Kubernetes version comes once it first connects.
 */
function registerSpaceStatus(
  workbench: Workbench,
  { discovery }: ListServices,
): void {
  const changes = new Changes();
  const versions = new Map<string, string>();
  const asked = new Set<string>();
  discovery.changes.subscribe(() => {
    const space = workbench.spaces.active;
    const [only, ...more] = space?.contexts ?? [];
    if (
      space &&
      only !== undefined &&
      more.length === 0 &&
      !asked.has(space.id) &&
      discovery.last(space.id)?.state === "ready"
    ) {
      asked.add(space.id);
      discovery.version(only).then(
        (version) => {
          versions.set(space.id, version);
          changes.emit();
        },
        () => {
          asked.delete(space.id);
        },
      );
    }
    changes.emit();
  });
  workbench.spaces.changes.subscribe(() => {
    changes.emit();
  });
  workbench.spaceStatus.register({
    changes,
    status: (space) => {
      const last = discovery.last(space);
      const active = workbench.spaces.active?.id === space;
      const version = versions.get(space);
      const known = version === undefined ? {} : { version };
      if (last?.state === "failed")
        return { tone: "error", label: last.error.message, ...known };
      if (!active)
        return {
          tone: "idle",
          label: last ? "In the background" : "Not connected yet",
          ...known,
        };
      return last?.state === "ready"
        ? { tone: "ok", label: "Connected", ...known }
        : { tone: "warn", label: "Connecting", ...known };
    },
  });
}
