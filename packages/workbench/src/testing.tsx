import type { ReactNode } from "react";
import { act } from "@testing-library/react";
import type { Backend } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import type { Area } from "./editors/registry";
import type { Platform } from "./keybindings/chord";
import { WorkbenchContext } from "./react";
import { registerCore } from "./core";
import { Workbench } from "./services";
import { StateStore } from "./state/store";

/**
 * A workbench on the mock backend and the US layout, with the core
 * registered, and its state, catalog and spaces loaded.
 */
export async function testWorkbench(
  scenario: MockScenario = "ready",
  backend: Backend = createMockBackend(scenario),
  platform: Platform = "mac",
): Promise<Workbench> {
  const state = await StateStore.load(backend, () => undefined);
  const workbench = new Workbench(
    backend,
    platform,
    { id: "us", keys: {} },
    state,
  );
  registerCore(workbench);
  await act(() =>
    Promise.all([workbench.catalog.watch(), workbench.spaces.load()]),
  );
  return workbench;
}

export function inWorkbench(workbench: Workbench) {
  return ({ children }: { children: ReactNode }) => (
    <WorkbenchContext.Provider value={workbench}>
      {children}
    </WorkbenchContext.Provider>
  );
}

/** The URIs of the editors whose tabs an area shows, by the panel id dockview gives each tab. */
export function tabsIn(area: Area): string[] {
  const panel = document.querySelector('[aria-label="Panel"]');
  return [
    ...document.querySelectorAll<HTMLElement>("[role=tab][data-tab-panel-id]"),
  ]
    .filter((tab) => (panel?.contains(tab) ?? false) === (area === "panel"))
    .map((tab) => tab.dataset.tabPanelId ?? "");
}
