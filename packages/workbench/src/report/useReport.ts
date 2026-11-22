import { useWorkbench } from "../react";
import { REPORT_PROBLEM } from "./commands";

export function useReport(): () => void {
  const { commands, keys } = useWorkbench();
  return () => {
    void commands.execute(REPORT_PROBLEM, keys.lookup(null));
  };
}
