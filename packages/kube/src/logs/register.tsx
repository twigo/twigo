import { ScrollText } from "lucide-react";
import type { LogTarget } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import { LOGS_SCHEME, logsUri, parseLogsUri } from "../uri";
import { logsKind } from "./entries";
import { LogsEditor } from "./LogsEditor";
import { LogsTabs, type LogsTab } from "./state";

/**
 * Logs in the panel (ARCHITECTURE 4.6): the `logs://` editor, opened by
 * `l` on a row, in the details and in an object's editor, and the keys of
 * a logs tab.
 */
export function registerLogs(workbench: Workbench): {
  tabs: LogsTabs;
  open: (object: LogTarget) => void;
} {
  const { editors, commands, keybindings, menus } = workbench;
  const tabs = new LogsTabs(workbench.backend);
  editors.onClose((uri) => {
    tabs.closed(uri);
  });

  editors.register({
    id: "kube.logs",
    scheme: LOGS_SCHEME,
    area: "panel",
    title: (uri) => {
      const input = parseLogsUri(uri.href);
      return input
        ? `Logs · ${logsKind(input.gvr) ?? input.gvr.resource} ${input.name}`
        : uri.href;
    },
    icon: ({ className }) => <ScrollText className={className} />,
    component: ({ uri }) => <LogsEditor uri={uri} tabs={tabs} />,
  });

  /** Opens or focuses an object's logs, on one container and its previous instance when a finding asks. */
  const open = (
    object: LogTarget,
    choice?: { container: string; previous: boolean },
  ) => {
    const uri = logsUri(object);
    // A finding's instance may have ended long before the tab's 15 minutes.
    if (choice) {
      tabs.prepare(uri, {
        containers: { type: "named", name: choice.container },
        previous: choice.previous,
        since: { type: "start" },
      });
    }
    editors.open(uri);
  };
  commands.register({
    id: "k8s.logs.open",
    title: "Logs",
    category: "Logs",
    icon: ScrollText,
    run: (args) => {
      const asked = logsRequest(args);
      if (asked) open(asked.object, asked.choice);
    },
  });
  // It acts on the object its caller names, so the palette has nothing to give it.
  menus.append("commandPalette", { command: "k8s.logs.open", when: "false" });
  menus.append("editor/title", {
    command: "k8s.logs.open",
    group: "navigation",
    when: "resource.logs",
  });

  const active = () => editors.activeIn("panel");
  const toggles: readonly {
    id: string;
    title: string;
    key: string;
    field: "follow" | "wrap" | "timestamps";
  }[] = [
    { id: "k8s.logs.toggleFollow", title: "Follow", key: "f", field: "follow" },
    { id: "k8s.logs.toggleWrap", title: "Wrap Lines", key: "w", field: "wrap" },
    {
      id: "k8s.logs.toggleTimestamps",
      title: "Show Timestamps",
      key: "t",
      field: "timestamps",
    },
  ];
  for (const { id, title, field } of toggles) {
    commands.register({
      id,
      title,
      category: "Logs",
      enablement: "logLines",
      run: () => {
        const uri = active();
        if (!uri) return;
        const on = !tabs.get(uri)[field];
        if (field === "follow") {
          tabs.follow(uri, on);
          return;
        }
        const change: Partial<LogsTab> = { [field]: on };
        tabs.update(uri, change);
      },
    });
  }
  commands.register({
    id: "k8s.logs.find",
    title: "Find in Logs",
    category: "Logs",
    enablement: "logsFocus",
    run: () => {
      const uri = active();
      if (uri) tabs.focus(uri, "search");
    },
  });
  // Bare keys fire only while the lines have the focus, never in a field.
  keybindings.register("core", [
    ...toggles.map(({ id, key }) => ({ key, command: id, when: "logLines" })),
    { key: "mod+f", command: "k8s.logs.find", when: "logsFocus" },
  ]);
  return { tabs, open };
}

/** A `k8s.logs.open` request, as a finding's button sends it. */
function logsRequest(
  args: unknown,
):
  | { object: LogTarget; choice?: { container: string; previous: boolean } }
  | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const { space, gvr, namespace, name, container, previous } = args as Record<
    string,
    unknown
  >;
  if (
    typeof space !== "string" ||
    typeof namespace !== "string" ||
    typeof name !== "string" ||
    typeof gvr !== "object" ||
    gvr === null
  )
    return undefined;
  const { group, version, resource } = gvr as Record<string, unknown>;
  if (
    typeof group !== "string" ||
    typeof version !== "string" ||
    typeof resource !== "string"
  )
    return undefined;
  const object = { space, gvr: { group, version, resource }, namespace, name };
  return typeof container === "string"
    ? { object, choice: { container, previous: previous === true } }
    : { object };
}
