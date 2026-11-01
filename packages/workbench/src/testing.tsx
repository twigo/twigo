import type { ReactNode } from "react";
import { act } from "@testing-library/react";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { WorkbenchContext } from "./react";
import { registerCore } from "./core";
import { Workbench } from "./services";

/** A workbench on the mock backend and the US layout, with the core registered and its spaces loaded. */
export async function testWorkbench(
  scenario: MockScenario = "ready",
): Promise<Workbench> {
  const workbench = new Workbench(createMockBackend(scenario), "mac", {
    id: "us",
    keys: {},
  });
  registerCore(workbench);
  await act(() => workbench.spaces.load());
  return workbench;
}

export function inWorkbench(workbench: Workbench) {
  return ({ children }: { children: ReactNode }) => (
    <WorkbenchContext.Provider value={workbench}>
      {children}
    </WorkbenchContext.Provider>
  );
}
