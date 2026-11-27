import type { ErrorCode } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import type { Workbench } from "../services";
import type { ErrorLike } from "../errors";
import { notifyError } from "../notifyError";
import { REPORT_PROBLEM, REVEAL_LOG_FILE } from "../report/commands";
import { START_OVER_PROTECTION } from "../spaces/modeCommands";

const problemToast = (code: string) => `problem:${code}`;

/** What a problem's notice offers first, by its code, where it is a way out rather than a look further. */
const WAYS_OUT: Readonly<
  Partial<
    Record<ErrorCode, { readonly label: string; readonly command: string }>
  >
> = {
  "protection.unreadable": {
    label: "Start Over…",
    command: START_OVER_PROTECTION,
  },
};

/** One notification for a problem of Twigo's own files, when it appears: what it means for the person, with the way out where there is one and the ways to look further. */
export function announceProblem(
  { commands, keys }: Workbench,
  problem: ErrorLike,
): void {
  const run = (command: string) => () => {
    void commands.execute(command, keys.lookup(null));
  };
  const reveal = { label: "Reveal Log File", run: run(REVEAL_LOG_FILE) };
  const report = { label: "Report…", run: run(REPORT_PROBLEM) };
  const out = WAYS_OUT[problem.code];
  notifyError(problem, {
    warning: true,
    key: problemToast(problem.code),
    ...(out === undefined
      ? { action: reveal, more: [report] }
      : {
          action: { label: out.label, run: run(out.command) },
          more: [reveal, report],
        }),
  });
}

export function dismissProblem(code: string): void {
  notify.dismiss(problemToast(code));
}
