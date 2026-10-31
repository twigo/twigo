import { Shell } from "./parts/Shell";
import { WorkbenchContext } from "./react";
import type { Workbench } from "./services";

export function WorkbenchView({ workbench }: { workbench: Workbench }) {
  return (
    <WorkbenchContext.Provider value={workbench}>
      <Shell />
    </WorkbenchContext.Provider>
  );
}
