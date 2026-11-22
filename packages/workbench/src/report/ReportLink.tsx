import { LinkButton } from "@twigo/ui";
import { useWorkbench } from "../react";
import { REPORT_PROBLEM } from "./commands";

export function ReportLink({ className }: { className?: string }) {
  const { commands, keys } = useWorkbench();
  return (
    <LinkButton
      {...(className && { className })}
      onClick={() => {
        void commands.execute(REPORT_PROBLEM, keys.lookup(null));
      }}
    >
      Report…
    </LinkButton>
  );
}
