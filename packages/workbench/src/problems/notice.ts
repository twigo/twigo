import { notify } from "@twigo/ui";
import type { Workbench } from "../services";
import type { ErrorLike } from "../errors";
import { notifyError } from "../notifyError";
import { REPORT_PROBLEM, REVEAL_LOG_FILE } from "../report/commands";

const problemToast = (code: string) => `problem:${code}`;

/** One notification for a problem of Twigo's own files, when it appears: what it means for the person, with the ways to look further. */
export function announceProblem(
  { commands, keys }: Workbench,
  problem: ErrorLike,
): void {
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

export function dismissProblem(code: string): void {
  notify.dismiss(problemToast(code));
}
