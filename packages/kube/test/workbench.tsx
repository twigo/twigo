import { act, render } from "@testing-library/react";
import { afterAll, beforeAll, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { WorkbenchView, type Workbench } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import { registerKube } from "../src/register";

export async function settle(steps = 6) {
  for (let i = 0; i < steps; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
    act(() => {
      vi.advanceTimersToNextFrame();
    });
  }
}

export async function mountKube(
  backend: Backend = createMockBackend("ready"),
): Promise<Workbench> {
  const pending = testWorkbench("ready", backend);
  await vi.advanceTimersByTimeAsync(10);
  const workbench = await pending;
  registerKube(workbench);
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  return workbench;
}

export async function openList(
  backend: Backend = createMockBackend("ready"),
  uri = "k8s-list://prod-eu/v1/pods",
): Promise<Workbench> {
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(uri);
  });
  await settle();
  return workbench;
}

export function withScreenSize(width = 800) {
  const unsized = globalThis.ResizeObserver;
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => width,
    });
    globalThis.ResizeObserver = class {
      constructor(private readonly report: ResizeObserverCallback) {}
      observe(target: Element) {
        this.report(
          [
            {
              target,
              contentRect: new DOMRectReadOnly(
                0,
                0,
                target.clientWidth,
                target.clientHeight,
              ),
            } as ResizeObserverEntry,
          ],
          this,
        );
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  });
  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    globalThis.ResizeObserver = unsized;
  });
}
