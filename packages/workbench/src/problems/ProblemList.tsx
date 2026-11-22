import { Button } from "@twigo/ui";
import { ErrorMessage } from "../ErrorMessage";
import { useWorkbench } from "../react";
import { REPORT_PROBLEM, REVEAL_LOG_FILE } from "../report/commands";

export const PROBLEMS_TITLE = "What Twigo could not do with its own files";

export function ProblemList() {
  const { problems, commands, keys } = useWorkbench();
  const run = (command: string) => {
    problems.setOpen(false);
    void commands.execute(command, keys.lookup(null));
  };
  return (
    <>
      <p className="text-body font-semibold text-content">{PROBLEMS_TITLE}</p>
      {problems.list.map((problem) => (
        <p key={problem.code} className="mt-1 text-support">
          <ErrorMessage error={problem} />
        </p>
      ))}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            run(REVEAL_LOG_FILE);
          }}
        >
          Reveal Log File
        </Button>
        <Button
          size="sm"
          onClick={() => {
            run(REPORT_PROBLEM);
          }}
        >
          Report…
        </Button>
      </div>
    </>
  );
}
