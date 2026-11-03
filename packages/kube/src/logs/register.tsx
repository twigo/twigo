import { ScrollText } from "lucide-react";
import type { Gvr } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import { LOGS_SCHEME, logsUri, parseLogsUri } from "../uri";
import { logsKind } from "./entries";
import { LogsEditor } from "./LogsEditor";
import { LogsTabs, type LogsTab } from "./state";

/** What a command needs to open an object's logs. */
export interface LogsObject {
  readonly space: string;
  readonly gvr: Gvr;
  readonly namespace: string;
  readonly name: string;
}

/**
 * Logs in the panel (ARCHITECTURE 4.6): the `logs://` editor, opened by
 * `l` on a row, in the details and in an object's editor, and the keys of
 * a logs tab.
 */
export function registerLogs(workbench: Workbench): {
  tabs: LogsTabs;
  open: (object: LogsObject, previous?: { container: string }) => void;
} {
  const { editors, commands, keybindings } = workbench;
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

  const open = (object: LogsObject, previous?: { container: string }) => {
    const uri = logsUri(object);
    if (previous) {
      tabs.prepare(uri, {
        containers: { type: "named", name: previous.container },
        previous: true,
      });
    }
    editors.open(uri);
  };

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
        const change: Partial<LogsTab> = { [field]: !tabs.get(uri)[field] };
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
