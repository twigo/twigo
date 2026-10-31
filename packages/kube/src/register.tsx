import { FolderTree, ScanSearch } from "lucide-react";
import type { Workbench } from "@twigo/workbench";
import { Discovery } from "./discovery";
import { Explorer } from "./Explorer";
import { Inspector } from "./Inspector";
import { ListIcon } from "./KindIcon";
import { ListEditor, type ListServices } from "./ListEditor";
import { Lists } from "./lists";
import {
  listProvider,
  namespaceProvider,
  resourceProvider,
} from "./quickaccess";
import { Selection } from "./selection";
import { LIST_SCHEME, parseListUri } from "./uri";

/** Kubernetes in the workbench, through its registries only (ARCHITECTURE 2.3). */
export function registerKube(workbench: Workbench): void {
  const services: ListServices = {
    discovery: new Discovery(workbench.backend),
    lists: new Lists(),
    selection: new Selection(),
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
    id: "kube.resources",
    title: "Resources",
    container: "kube.explorer",
    component: () => <Explorer discovery={services.discovery} />,
  });
  views.registerContainer({
    id: "kube.inspector",
    title: "Inspector",
    icon: ScanSearch,
    location: "secondary",
    order: 0,
  });
  views.registerView({
    id: "kube.inspector",
    title: "Inspector",
    container: "kube.inspector",
    component: () => <Inspector selection={services.selection} />,
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
  });

  const moves: readonly {
    id: string;
    title: string;
    keys: string[];
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
  ];
  for (const { id, title, run } of moves) {
    commands.register({
      id,
      title,
      category: "List",
      enablement: "listFocus",
      run,
    });
  }
  keybindings.register(
    "core",
    moves.flatMap(({ id, keys }) =>
      keys.map((key) => ({ key, command: id, when: "listFocus" })),
    ),
  );
}
