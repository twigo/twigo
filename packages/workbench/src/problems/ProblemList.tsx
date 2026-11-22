import { Button } from "@twigo/ui";
import { ErrorMessage } from "../ErrorMessage";
import { useWorkbench } from "../react";
import { REPORT_PROBLEM, REVEAL_LOG_FILE } from "../report/commands";

export function ProblemList() {
  const { problems, commands, keys } = useWorkbench();
  const run = (command: string) => {
    problems.setOpen(false);
    void commands.execute(command, keys.lookup(null));
  };
  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        {problems.list.map((problem) => (
          <li key={problem.code}>
            <ErrorMessage error={problem} />
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
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
    </div>
  );
}
