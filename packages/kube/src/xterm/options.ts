import type { Workbench } from "@twigo/workbench";
import { workbenchKey } from "./keys";
import type { TerminalOptions } from "./terminal";

export function terminalOptions(workbench: Workbench): TerminalOptions {
  return {
    backend: workbench.backend,
    platform: workbench.platform,
    report: (error) => {
      workbench.report(error);
    },
    openUrl: (url) => {
      workbench.openUrl(url);
    },
    binds: (event) =>
      workbenchKey(workbench.keybindings, workbench.platform, event),
  };
}
