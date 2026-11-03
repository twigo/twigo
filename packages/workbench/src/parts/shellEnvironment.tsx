import { TriangleAlert } from "lucide-react";
import { useChanges, useWorkbench } from "../react";
import type { StatusEntry } from "../views/registry";
import { SHELL_ENVIRONMENT_TITLE as TITLE } from "./shellEnvironmentIds";
import { ShellEnvironmentFailure } from "./ShellEnvironmentFailure";

/** A warning while Twigo runs without the login shell's environment (ARCHITECTURE 6.1). */
export function useShellEnvironmentEntries(): readonly StatusEntry[] {
  const { shellEnvironment } = useWorkbench();
  useChanges(shellEnvironment.changes);
  const { current, detailsOpen } = shellEnvironment;
  if (current.state === "resolving" && shellEnvironment.retrying)
    return [{ id: "shell", text: "Loading shell environment…", tone: "warn" }];
  if (current.state !== "failed") return [];
  return [
    {
      id: "shell",
      text: "Shell environment",
      icon: TriangleAlert,
      tooltip: TITLE,
      popover: {
        open: detailsOpen,
        onOpenChange: (open) => {
          shellEnvironment.setDetailsOpen(open);
        },
        content: <ShellEnvironmentFailure failed={current} />,
      },
    },
  ];
}
