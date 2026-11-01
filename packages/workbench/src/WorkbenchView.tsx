import { PanelBoundary } from "./parts/PanelBoundary";
import { Shell } from "./parts/Shell";
import { WorkbenchContext } from "./react";
import type { Workbench } from "./services";

export function WorkbenchView({ workbench }: { workbench: Workbench }) {
  return (
    <WorkbenchContext.Provider value={workbench}>
      <PanelBoundary label="Workbench">
        <Shell />
      </PanelBoundary>
    </WorkbenchContext.Provider>
  );
}
