import { notify } from "@twigo/ui";
import type { Workbench } from "../services";
import type { ErrorLike } from "../errors";
import { notifyError } from "../notifyError";
import { REPORT_PROBLEM, REVEAL_LOG_FILE } from "../report/commands";
import { variant } from "../variants";

const problemToast = (code: string) => `problem:${code}`;

/** One notification for a problem of Twigo's own files, when it appears: what it means for the person, with the ways to look further: `problems:notice`. */
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
    key: problemToast(problem.code),
    action: { label: "Reveal Log File", run: run(REVEAL_LOG_FILE) },
    more: [{ label: "Report…", run: run(REPORT_PROBLEM) }],
  });
}

/** A problem that Rust no longer lists takes its notification with it. */
export function dismissProblem(code: string): void {
  notify.dismiss(problemToast(code));
}
