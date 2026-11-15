import { SquareTerminal } from "lucide-react";
import { useChanges, type Workbench } from "@twigo/workbench";
import type { ExecTabs } from "./exec/tabs";
import type { LogsTabs } from "./logs/state";
import type { TerminalTabs } from "./terminal/tabs";

/**
 * The status bar's count of a space's sessions that run on while the panel
 * is hidden, shells, terminals and logs alike; a click shows the panel.
 */
export function registerSessions(
  workbench: Workbench,
  tabs: {
    readonly logs: LogsTabs;
    readonly shells: ExecTabs;
    readonly terminals: TerminalTabs;
  },
): void {
  const { spaces, views } = workbench;
  const live = (space: string): number =>
    tabs.logs.live(space) +
    [tabs.shells, tabs.terminals].reduce(
      (count, kind) =>
        count +
        kind.list().filter(([, tab]) => tab.input.space === space && tab.live)
          .length,
      0,
    );
  views.registerStatusBarItem({
    id: "kube.sessions",
    alignment: "left",
    priority: 175,
    useEntries: () => {
      useChanges(spaces.changes);
      useChanges(tabs.logs.changes);
      useChanges(tabs.shells.changes);
      useChanges(tabs.terminals.changes);
      const space = spaces.active;
      if (!space || spaces.state(space.id).parts.panel.visible) return [];
      const count = live(space.id);
      return count === 0
        ? []
        : [
            {
              id: "sessions",
              text: count === 1 ? "1 session" : `${String(count)} sessions`,
              icon: SquareTerminal,
              tooltip: "Show the panel",
              run: () => {
                spaces.setPart(space.id, "panel", { visible: true });
              },
            },
          ];
    },
  });
}
