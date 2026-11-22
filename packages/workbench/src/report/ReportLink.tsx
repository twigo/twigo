import { Button, LinkButton } from "@twigo/ui";
import { useWorkbench } from "../react";
import { REPORT_PROBLEM } from "./commands";

function useReport() {
  const { commands, keys } = useWorkbench();
  return () => {
    void commands.execute(REPORT_PROBLEM, keys.lookup(null));
  };
}

/** Report… as a link, for a line of text. */
export function ReportLink({ className }: { className?: string }) {
  const report = useReport();
  return (
    <LinkButton {...(className && { className })} onClick={report}>
      Report…
    </LinkButton>
  );
}

/** Report… as a button, beside the one that reopens what Twigo stopped. */
export function ReportButton() {
  const report = useReport();
  return (
    <Button size="sm" variant="outline" onClick={report}>
      Report…
    </Button>
  );
}
