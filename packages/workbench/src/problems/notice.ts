import type { Workbench } from "../services";
import type { ErrorLike } from "../errors";
import { notifyError } from "../notifyError";
import { REPORT_PROBLEM, REVEAL_LOG_FILE } from "../report/commands";
import { variant } from "../variants";

/** One notification for a problem of Twigo's own files, when it first appears: what it means for the person, with the ways to look further: `problems:notice`. */
export function announceProblem(
  { commands, keys }: Workbench,
  problem: ErrorLike,
): void {
  // @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
  if (variant("problems") !== "notice") return;
  const run = (command: string) => () => {
    void commands.execute(command, keys.lookup(null));
  };
  notifyError(problem, {
    warning: true,
    key: `problem:${problem.code}`,
    action: { label: "Reveal Log File", run: run(REVEAL_LOG_FILE) },
    more: [{ label: "Report…", run: run(REPORT_PROBLEM) }],
  });
}
