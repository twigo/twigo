import type { ReactNode } from "react";
import { act } from "@testing-library/react";
import { createMockBackend } from "@twigo/protocol/mock";
import { WorkbenchContext } from "./react";
import { registerCore } from "./core";
import { Workbench } from "./services";

/** A workbench on the mock backend and the US layout, with the core registered and its spaces loaded. */
export async function testWorkbench(): Promise<Workbench> {
  const workbench = new Workbench(createMockBackend("ready"), "mac", {
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
