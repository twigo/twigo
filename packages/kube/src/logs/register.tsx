import { ScrollText } from "lucide-react";
import * as v from "valibot";
import type { LogTarget } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import { LOGS_SCHEME, logsUri, parseLogsUri } from "../uri";
import { logsKind } from "./entries";
import { LogsEditor } from "./LogsEditor";
import type { LogsTab, LogsTabs } from "./state";

/**
 * Logs in the panel (ARCHITECTURE 4.6): the `logs://` editor of `tabs`,
 * opened by `l` on a row, in the details and in an object's editor through
 * `k8s.logs.open`, and the keys of a logs tab.
 */
export function registerLogs(workbench: Workbench, tabs: LogsTabs): void {
  const { editors, commands, keybindings, menus } = workbench;
  editors.onClose((uri) => {
    tabs.closed(uri);
  });

  editors.register({
    id: "kube.logs",
    scheme: LOGS_SCHEME,
    area: "panel",
    space: (uri) => parseLogsUri(uri.href)?.space,
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
      tabs.setSource(uri, {
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
}

/** A `k8s.logs.open` request, as a finding's button sends it: a target, and maybe a container and its previous instance. */
const REQUEST = v.object({
  space: v.string(),
  gvr: v.object({
    group: v.string(),
    version: v.string(),
    resource: v.string(),
  }),
  namespace: v.string(),
  name: v.string(),
  container: v.optional(v.string()),
  previous: v.optional(v.boolean()),
});

function logsRequest(
  args: unknown,
):
  | { object: LogTarget; choice?: { container: string; previous: boolean } }
  | undefined {
  const parsed = v.safeParse(REQUEST, args);
  if (!parsed.success) return undefined;
  const { space, gvr, namespace, name, container, previous } = parsed.output;
  const object = { space, gvr, namespace, name };
  return container === undefined
    ? { object }
    : { object, choice: { container, previous: previous === true } };
}
