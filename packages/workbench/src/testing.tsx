import type { ReactNode } from "react";
import { act, fireEvent } from "@testing-library/react";
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

export function tabOf(uri: string): HTMLElement {
  const tab = [
    ...document.querySelectorAll<HTMLElement>("[role=tab][data-tab-panel-id]"),
  ].find((each) => each.dataset.tabPanelId === uri);
  if (!tab) throw new Error(`no tab for ${uri}`);
  return tab;
}

/** The empty part of the tab strip of an area's first group. */
export function stripOf(area: Area): HTMLElement {
  const panel = document.querySelector('[aria-label="Panel"]');
  const strip = [
    ...document.querySelectorAll<HTMLElement>(".dv-void-container"),
  ].find((each) => (panel?.contains(each) ?? false) === (area === "panel"));
  if (!strip) throw new Error(`no tab strip in the ${area} area`);
  return strip;
}

/**
 * A left click as a browser delivers it: the presses reach their listeners,
 * and then the nearest element that can take the focus takes it, or the
 * focus falls to the page, which jsdom does not do.
 */
export function click(element: Element): void {
  fireEvent.pointerDown(element, { button: 0 });
  fireEvent.mouseDown(element, { button: 0 });
  const focusable = element.closest<HTMLElement>(
    "button, input, textarea, [tabindex]",
  );
  if (focusable) focusable.focus();
  else if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  fireEvent.pointerUp(element, { button: 0 });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}
