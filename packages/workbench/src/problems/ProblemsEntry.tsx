import { TriangleAlert } from "lucide-react";
import { useChanges, useWorkbench } from "../react";
import { variant } from "../variants";
import type { StatusEntry } from "../views/registry";
import { ProblemList } from "./ProblemList";

/** The status bar's count of Twigo's own problems, which opens them with the ways to look further: `problems:status`. */
export function useProblemEntries(): readonly StatusEntry[] {
  const { problems } = useWorkbench();
  useChanges(problems.changes);
  // @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
  if (variant("problems") !== "status" || problems.list.length === 0) return [];
  const count = problems.list.length;
  return [
    {
      id: "problems",
      text: `${String(count)} ${count === 1 ? "problem" : "problems"}`,
      icon: TriangleAlert,
      tone: "warn",
      tooltip: "What Twigo could not do with its own files",
      popover: {
        open: problems.open,
        onOpenChange: (open) => {
          problems.setOpen(open);
        },
        content: <ProblemList />,
      },
    },
  ];
}
