import type { Workbench } from "@twigo/workbench";
import type { ListServices } from "./ListEditor";
import { objectOf } from "./selection";

/**
 * Commands on the selected row of the active list, and the row menu
 * (`resource/context`) that points at them. Logs, shell, YAML and delete
 * join it with their commands.
 */
export function registerResourceActions(
  workbench: Workbench,
  services: ListServices,
): void {
  const { commands, menus, editors } = workbench;
  const target = () => {
    const uri = editors.active;
    const selected =
      uri === undefined ? undefined : services.selection.get(uri);
    if (!uri || !selected) return undefined;
    return { uri, object: objectOf(selected) };
  };
  const actions: readonly {
    id: string;
    title: string;
    group: string;
    when?: string;
    run: () => void | Promise<void>;
  }[] = [
    {
      id: "k8s.resource.details",
      title: "Open Details",
      group: "navigation",
      run: () => {
        const found = target();
        if (found) services.lists.editor(found.uri)?.activate();
      },
    },
    {
      id: "k8s.resource.copyName",
      title: "Copy Name",
      group: "2_copy",
      run: async () => {
        const found = target();
        if (found) await navigator.clipboard.writeText(found.object.name);
      },
    },
    {
      id: "k8s.resource.copyNamespacedName",
      title: "Copy Namespace/Name",
      group: "2_copy",
      when: "resource.namespaced",
      run: async () => {
        const found = target();
        const { namespace, name } = found?.object ?? {};
        if (namespace && name)
          await navigator.clipboard.writeText(`${namespace}/${name}`);
      },
    },
  ];
  actions.forEach(({ id, title, group, when, run }, order) => {
    const enablement = when ? `listFocus && ${when}` : "listFocus";
    commands.register({ id, title, category: "Resource", enablement, run });
    menus.append("resource/context", {
      command: id,
      group,
      order,
      ...(when && { when }),
    });
  });
}
