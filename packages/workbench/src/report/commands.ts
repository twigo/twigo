import type { LogVerbosity } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import type { QuickPickItem } from "../quickaccess/registry";
import type { Workbench } from "../services";

export const REPORT_PROBLEM = "workbench.action.reportProblem";
export const REVEAL_LOG_FILE = "workbench.action.revealLogFile";
export const SET_LOG_LEVEL = "workbench.action.setLogLevel";

const LEVELS: readonly (QuickPickItem & { id: LogVerbosity })[] = [
  { id: "info", label: "Info", description: "The default" },
  { id: "debug", label: "Debug", description: "More of what Twigo does" },
  { id: "trace", label: "Trace", description: "Every step, with a large log" },
];

/** Help's diagnostics commands (ARCHITECTURE 4.10): the report, the log file and how much the log says. */
export function registerReportCommands({
  commands,
  menus,
  quickAccess,
  backend,
  problemReport,
}: Workbench): void {
  commands.register({
    id: REPORT_PROBLEM,
    title: "Report a Problem…",
    category: "Help",
    run: () => problemReport.show(),
  });
  commands.register({
    id: REVEAL_LOG_FILE,
    title: "Reveal Log File",
    category: "Help",
    run: async () => {
      await backend.invoke("log_reveal", null);
    },
  });
  commands.register({
    id: SET_LOG_LEVEL,
    title: "Set Log Level…",
    category: "Help",
    run: async () => {
      const picked = await quickAccess.pick(
        "Set the log level until Twigo quits",
        LEVELS,
      );
      if (!picked) return;
      const level = picked.id as LogVerbosity;
      await backend.invoke("log_level_set", { level });
      notify.info(
        level === "info"
          ? "Twigo logs at info again."
          : `Twigo logs at ${level} until it quits.`,
        { key: SET_LOG_LEVEL },
      );
    },
  });
  [REPORT_PROBLEM, REVEAL_LOG_FILE, SET_LOG_LEVEL].forEach((command, order) => {
    menus.append("menubar/help", { command, group: "2_diagnostics", order });
  });
}
