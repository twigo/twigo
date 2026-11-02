import { FolderTree } from "lucide-react";
import type { Workbench } from "@twigo/workbench";
import { ColumnPresets } from "./columnPresets";
import { Discovery } from "./discovery";
import { Explorer, EXPLORER_VIEW } from "./Explorer";
import { FilterField } from "./FilterField";
import { HealthFilter } from "./HealthFilter";
import { ListFilters } from "./filters";
import { ListIcon } from "./KindIcon";
import { ListEditor, type ListServices } from "./ListEditor";
import { ListStatuses } from "./listStatus";
import { ClusterStatusItem, ListSummaryItem } from "./ListStatusItem";
import { Lists } from "./lists";
import {
  listProvider,
  namespaceProvider,
  resourceProvider,
} from "./quickaccess";
import { registerResourceActions } from "./resourceActions";
import { Selection } from "./selection";
import { LIST_SCHEME, parseListUri } from "./uri";

/** Kubernetes in the workbench, through its registries only (ARCHITECTURE 2.3). */
export function registerKube(workbench: Workbench): void {
  const services: ListServices = {
    discovery: new Discovery(workbench),
    lists: new Lists(),
    filters: new ListFilters(),
    columns: new ColumnPresets(workbench.state),
    selection: new Selection(),
    statuses: new ListStatuses(),
  };
  const { views, editors, commands, keybindings, quickAccess } = workbench;

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
    workbench.menus.append("menubar/go", {
      command: id,
      group: "3_kubernetes",
      order,
    });
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
    component: () => (
      <Explorer discovery={services.discovery} lists={services.lists} />
    ),
  });
  views.registerStatusBarItem({
    id: "kube.cluster",
    alignment: "left",
    priority: 100,
    component: () => (
      <ClusterStatusItem
        statuses={services.statuses}
        discovery={services.discovery}
      />
    ),
  });
  views.registerStatusBarItem({
    id: "kube.list",
    alignment: "right",
    priority: 100,
    component: () => (
      <ListSummaryItem
        statuses={services.statuses}
        filters={services.filters}
      />
    ),
  });

  editors.register({
    id: "kube.list",
    scheme: LIST_SCHEME,
    title: (uri) => {
      const resource = parseListUri(uri.href)?.gvr.resource ?? uri.href;
      return resource.charAt(0).toUpperCase() + resource.slice(1);
    },
    icon: ListIcon,
    component: ({ uri }) => <ListEditor uri={uri} services={services} />,
    actions: ({ uri }) => (
      <div className="flex items-center gap-2">
        <HealthFilter
          uri={uri}
          filters={services.filters}
          statuses={services.statuses}
        />
        <FilterField uri={uri} filters={services.filters} />
      </div>
    ),
  });

  const moves: readonly {
    id: string;
    title: string;
    keys: string[];
    when?: string;
    run: () => void;
  }[] = [
    {
      id: "list.focusDown",
      title: "Focus Next Row",
      keys: ["j", "down"],
      run: () => services.lists.focused()?.move(1),
    },
    {
      id: "list.focusUp",
      title: "Focus Previous Row",
      keys: ["k", "up"],
      run: () => services.lists.focused()?.move(-1),
    },
    {
      id: "list.focusFirst",
      title: "Focus First Row",
      keys: ["home"],
      run: () => services.lists.focused()?.moveToEdge("first"),
    },
    {
      id: "list.focusLast",
      title: "Focus Last Row",
      keys: ["end", "shift+g"],
      run: () => services.lists.focused()?.moveToEdge("last"),
    },
    {
      id: "list.open",
      title: "Open",
      keys: ["enter"],
      run: () => services.lists.focused()?.activate(),
    },
    {
      id: "k8s.details.close",
      title: "Close Details",
      keys: ["escape"],
      when: "detailsOpen",
      run: () => services.lists.focused()?.closeDetails?.(),
    },
    {
      id: "k8s.list.filter",
      title: "Filter Rows",
      keys: ["/", "mod+f"],
      run: () => services.lists.focused()?.filter?.(),
    },
    {
      id: "list.collapse",
      title: "Collapse",
      keys: ["left"],
      when: "treeFocus",
      run: () => services.lists.focused()?.collapse?.(),
    },
    {
      id: "list.expand",
      title: "Expand",
      keys: ["right"],
      when: "treeFocus",
      run: () => services.lists.focused()?.expand?.(),
    },
  ];
  for (const { id, title, when = "listFocus", run } of moves) {
    commands.register({ id, title, category: "List", enablement: when, run });
  }
  keybindings.register(
    "core",
    moves.flatMap(({ id, keys, when = "listFocus" }) =>
      keys.map((key) => ({ key, command: id, when })),
    ),
  );
  registerResourceActions(workbench, services);
}
