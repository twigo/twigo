import { FolderTree } from "lucide-react";
import { Changes, type Workbench } from "@twigo/workbench";
import { Explorer, EXPLORER_VIEW } from "./explorer/Explorer";
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
import { registerResourceActions } from "./resourceActions";
import { createServices, type ListServices } from "./services";
import {
  LIST_SCHEME,
  OBJECT_SCHEME,
  parseListUri,
  parseObjectUri,
} from "./uri";

/** Kubernetes in the workbench, through its registries only (ARCHITECTURE 2.3). */
export function registerKube(workbench: Workbench): void {
  const services = createServices(workbench);
  const { views, editors, commands, keybindings, quickAccess, menus } =
    workbench;

  quickAccess.register(listProvider(workbench, services.discovery));
  quickAccess.register(namespaceProvider(workbench));
  quickAccess.register(resourceProvider(workbench, services.selection));
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

  editors.register({
    id: "kube.list",
    scheme: LIST_SCHEME,
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
    title: (uri) => parseObjectUri(uri.href)?.name ?? uri.href,
    icon: ObjectIcon,
    component: ({ uri }) => (
      <ObjectEditor
        uri={uri}
        discovery={services.discovery}
        tabs={objectTabs}
      />
    ),
    actions: ({ uri }) => <ObjectTabSwitch uri={uri} tabs={objectTabs} />,
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
  registerResourceActions(workbench, services);
}

/**
 * Each space's connection on its rail tile (ARCHITECTURE 4.2), as
 * discovery last answered: Rust follows the active space only, so a space
 * left behind shows idle until it is active again, or the failure it had.
 */
function registerSpaceStatus(
  workbench: Workbench,
  { discovery }: ListServices,
): void {
  const changes = new Changes();
  discovery.changes.subscribe(() => {
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
      if (last?.state === "failed")
        return { tone: "error", label: last.error.message };
      if (!active)
        return {
          tone: "idle",
          label: last ? "In the background" : "Not connected yet",
        };
      return last?.state === "ready"
        ? { tone: "ok", label: "Connected" }
        : { tone: "warn", label: "Connecting" };
    },
  });
}
