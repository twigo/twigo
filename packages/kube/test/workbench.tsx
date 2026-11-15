import { act, render, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { WorkbenchView, type Workbench } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import { registerKube } from "../src/register";
import { tabPaths } from "../src/tabPaths";
import { testSignal } from "./setup";

export async function settle(steps = 6) {
  const signal = testSignal();
  for (let i = 0; i < steps; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
    signal?.throwIfAborted();
    act(() => {
      vi.advanceTimersToNextFrame();
    });
  }
}

export async function mountKube(
  backend: Backend = createMockBackend("ready"),
): Promise<Workbench> {
  const signal = testSignal();
  const pending = testWorkbench("ready", backend);
  await vi.advanceTimersByTimeAsync(10);
  signal?.throwIfAborted();
  const workbench = await pending;
  signal?.throwIfAborted();
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

export const hoverIcons = (row: HTMLElement) =>
  within(row)
    .queryAllByRole("button")
    .map((button) => button.getAttribute("aria-label"))
    .filter((label) => label !== "Row actions" && label !== "Mark row");

export const bareTabPaths = (workbench: Workbench) =>
  tabPaths(workbench, { last: () => undefined });

export function withScreenSize(width = 800) {
  const unsized = globalThis.ResizeObserver;
  const widths = new Map<Element, number>();
  const watchers = new Map<Element, Set<ResizeObserverCallback>>();
  const entry = (target: Element) =>
    ({
      target,
      contentRect: new DOMRectReadOnly(
        0,
        0,
        target.clientWidth,
        target.clientHeight,
      ),
    }) as ResizeObserverEntry;
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return widths.get(this) ?? width;
      },
    });
    globalThis.ResizeObserver = class {
      readonly #watched = new Set<Element>();
      constructor(private readonly report: ResizeObserverCallback) {}
      observe(target: Element) {
        this.#watched.add(target);
        watchers.set(
          target,
          (watchers.get(target) ?? new Set()).add(this.report),
        );
        this.report([entry(target)], this);
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        for (const target of this.#watched)
          watchers.get(target)?.delete(this.report);
        this.#watched.clear();
      }
    };
  });
  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    globalThis.ResizeObserver = unsized;
  });
  afterEach(() => {
    widths.clear();
    watchers.clear();
  });
  return {
    resize(target: Element, to: number) {
      widths.set(target, to);
      act(() => {
        for (const report of watchers.get(target) ?? [])
          report([entry(target)], {} as ResizeObserver);
      });
    },
  };
}
