import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { inWorkbench, testWorkbench } from "../testing";
import { TitleBar } from "./TitleBar";

const unsized = globalThis.ResizeObserver;
const watching = new Set<{
  target: Element;
  report: ResizeObserverCallback;
  observer: ResizeObserver;
}>();

beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly report: ResizeObserverCallback) {}
    observe(target: Element) {
      watching.add({ target, report: this.report, observer: this });
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      for (const each of watching) {
        if (each.observer === this) watching.delete(each);
      }
    }
  };
});

afterEach(() => {
  cleanup();
  watching.clear();
  globalThis.ResizeObserver = unsized;
});

function widen(width: number) {
  act(() => {
    for (const { target, report, observer } of watching) {
      if (target.tagName !== "HEADER") continue;
      report(
        [{ target, contentRect: { width } } as ResizeObserverEntry],
        observer,
      );
    }
  });
}

/** The mock answers after a timer. */
const settled = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

async function mounted() {
  const workbench = await testWorkbench();
  const view = render(<TitleBar />, { wrapper: inWorkbench(workbench) });
  return { workbench, ...view };
}

test("the whole title bar drags the window, its controls excepted", async () => {
  const { container } = await mounted();
  expect(
    container.querySelector('header[data-tauri-drag-region="deep"]'),
  ).not.toBeNull();
});

test("the breadcrumb names the space and its scope and opens their pickers", async () => {
  const { workbench } = await mounted();
  const space = screen.getByRole("button", { name: "Switch space" });
  expect(space.textContent).toBe("prod-eu");
  expect(space.querySelector("[data-color]")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Select namespace" }).textContent,
  ).toBe("All namespaces");
  fireEvent.click(space);
  expect(workbench.quickAccess.session?.value).toBe("ctx ");
  act(() => {
    workbench.quickAccess.hide();
  });
  fireEvent.click(screen.getByRole("button", { name: "Select namespace" }));
  expect(workbench.quickAccess.session?.value).toBe("ns ");
});

test("the breadcrumb follows the space and its namespace scope", async () => {
  const { workbench } = await mounted();
  act(() => {
    workbench.spaces.select("staging");
    workbench.spaces.update("staging", (state) => ({
      ...state,
      namespaces: ["payments"],
    }));
  });
  const space = screen.getByRole("button", { name: "Switch space" });
  expect(space.textContent).toBe("staging");
  expect(
    screen.getByRole("button", { name: "Select namespace" }).textContent,
  ).toBe("payments");
});

test("the bar is tinted with the active context's colour, an automatic or a chosen one too", async () => {
  const { workbench, container } = await mounted();
  const header = () => container.querySelector("header");
  const tint = () => ({
    color: header()?.getAttribute("data-color"),
    variable: header()?.style.getPropertyValue("--twigo-context"),
  });
  expect(tint()).toEqual({ color: "red", variable: "var(--context-red)" });

  await act(() => workbench.spaces.open("qa"));
  const automatic = workbench.colors.of("qa");
  expect(workbench.colors.source("qa")).toBe("automatic");
  expect(tint()).toEqual({
    color: automatic,
    variable: `var(--context-${automatic})`,
  });

  act(() => {
    workbench.colors.choose("qa", "yellow");
  });
  expect(tint()).toEqual({
    color: "yellow",
    variable: "var(--context-yellow)",
  });
});

test("the search opens quick access, and the bar has no part toggles", async () => {
  const { workbench } = await mounted();
  fireEvent.click(screen.getByRole("button", { name: /Search prod-eu/ }));
  expect(workbench.quickAccess.session?.value).toBe("");
  expect(screen.queryByRole("button", { name: /Toggle/ })).toBeNull();
});

test("the chip follows the context's name and opens what set its mode", async () => {
  const { workbench } = await mounted();
  await settled();
  const chip = screen.getByRole("button", {
    name: "Mode of prod-eu: Production · read-only",
  });
  expect(chip.textContent).toBe("Production · read-only");

  fireEvent.click(chip);
  expect(screen.getByText("The default for Production.")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /Unlock for 15 minutes/ }),
  );
  await settled();
  expect(workbench.catalog.find("prod-eu")?.access.mode).toBe("guarded");
  expect(
    screen.getByRole("button", {
      name: "Mode of prod-eu: Production · unlocked",
    }),
  ).toBeTruthy();
});

test("pressing what is already pressed changes nothing, so an unlock keeps its relock", async () => {
  const { workbench } = await mounted();
  const invoke = vi.spyOn(workbench.backend, "invoke");
  await settled();
  fireEvent.click(screen.getByRole("button", { name: /^Mode of prod-eu/ }));
  fireEvent.click(screen.getByRole("button", { name: "Read-only" }));
  fireEvent.click(screen.getByRole("button", { name: "Production" }));
  await settled();
  expect(invoke).not.toHaveBeenCalledWith(
    "context_mode_set",
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "context_environment_set",
    expect.anything(),
  );

  fireEvent.click(
    screen.getByRole("button", { name: /Unlock for 15 minutes/ }),
  );
  await settled();
  const until = workbench.catalog.find("prod-eu")?.access.unlockedUntil;
  fireEvent.click(screen.getByRole("button", { name: "Guarded" }));
  await settled();
  expect(workbench.catalog.find("prod-eu")?.access.unlockedUntil).toBe(until);
  expect(screen.getByText(/You unlocked it for now/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Lock now" }));
  await settled();
  expect(workbench.catalog.find("prod-eu")?.access.mode).toBe("read-only");
});

test("the popover takes the focus itself, so a second Enter cannot open up production", async () => {
  await mounted();
  await settled();
  const chip = screen.getByRole("button", { name: /^Mode of prod-eu/ });
  chip.focus();
  fireEvent.click(chip);
  await settled();
  expect(document.activeElement).toBe(
    screen.getByRole("dialog", { name: "Mode of prod-eu" }),
  );

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await settled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(chip);
});

test("a popover left open on one context does not stay open on the next", async () => {
  const { workbench } = await mounted();
  await settled();
  fireEvent.click(screen.getByRole("button", { name: /^Mode of prod-eu/ }));
  expect(screen.getByRole("dialog", { name: "Mode of prod-eu" })).toBeTruthy();
  act(() => {
    workbench.spaces.select("staging");
  });
  await settled();
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  await settled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a choice of the person can go back to the default", async () => {
  const { workbench } = await mounted();
  await settled();
  fireEvent.click(screen.getByRole("button", { name: /^Mode of prod-eu/ }));
  fireEvent.click(screen.getByRole("button", { name: "Guarded" }));
  await settled();
  expect(workbench.catalog.find("prod-eu")?.access.source).toEqual({
    kind: "user",
  });
  fireEvent.click(screen.getByRole("button", { name: "Use the default" }));
  await settled();
  expect(workbench.catalog.find("prod-eu")?.access.mode).toBe("read-only");
});

test("under a policy file the popover names the rule and offers no way around it", async () => {
  const workbench = await testWorkbench(
    undefined,
    createMockBackend("policyFile"),
  );
  render(<TitleBar />, { wrapper: inWorkbench(workbench) });
  await settled();
  fireEvent.click(screen.getByRole("button", { name: /^Mode of prod-eu/ }));
  expect(screen.getByText(/prod-\* in .*policy\.json sets this/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Read-write" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Unlock/ })).toBeNull();
});

test("a context nobody marked has no chip", async () => {
  const { workbench } = await mounted();
  await act(() => workbench.spaces.open("qa"));
  expect(screen.queryByRole("button", { name: /^Mode of/ })).toBeNull();
});

test("a type other than Production has its chip", async () => {
  const { workbench } = await mounted();
  act(() => {
    workbench.spaces.select("dev");
  });
  await settled();
  expect(
    screen.getByRole("button", { name: "Mode of dev: Development" }),
  ).toBeTruthy();
});

test("the search folds to an icon that keeps its key hint and still opens quick access", async () => {
  const { workbench } = await mounted();
  const search = () => screen.getByRole("button", { name: "Search prod-eu" });
  widen(1280);
  expect(search().textContent).toBe("Search prod-eu⌘P");

  widen(1100);
  expect(search().textContent).toBe("⌘P");
  fireEvent.click(search());
  expect(workbench.quickAccess.session?.value).toBe("");

  widen(1280);
  expect(search().textContent).toBe("Search prod-eu⌘P");
});

test("the chip folds to its icon after the search, its words kept for the tooltip and the popover", async () => {
  await mounted();
  await settled();
  const chip = () =>
    screen.getByRole("button", {
      name: "Mode of prod-eu: Production · read-only",
    });
  widen(1100);
  expect(chip().textContent).toBe("Production · read-only");

  widen(900);
  expect(chip().textContent).toBe("");
  expect(chip().querySelector("svg")).not.toBeNull();
  fireEvent.focus(chip());
  expect(screen.getAllByText("Production · read-only").length).toBeGreaterThan(
    0,
  );
  fireEvent.click(chip());
  expect(screen.getByRole("dialog", { name: "Mode of prod-eu" })).toBeTruthy();
});

test("a folded chip of a type with no icon of its own still shows one", async () => {
  const { workbench } = await mounted();
  act(() => {
    workbench.spaces.select("dev");
  });
  await settled();
  widen(700);
  const chip = screen.getByRole("button", { name: "Mode of dev: Development" });
  expect(chip.textContent).toBe("");
  expect(chip.querySelector("svg")).not.toBeNull();
  widen(1440);
  expect(chip.querySelector("svg")).toBeNull();
});

test("at 1,100 px the name and the scope show whole beside the chip's words", async () => {
  await mounted();
  await settled();
  widen(1100);
  expect(screen.getByRole("button", { name: "Switch space" }).textContent).toBe(
    "prod-eu",
  );
  expect(
    screen.getByRole("button", { name: "Select namespace" }).textContent,
  ).toBe("All namespaces");
  expect(
    screen.getByRole("button", { name: /^Mode of prod-eu/ }).textContent,
  ).toBe("Production · read-only");
});

async function inLongSpace() {
  const mock = createMockBackend("ready");
  const backend = {
    invoke: (command: string, request: unknown) =>
      command === "spaces_list"
        ? Promise.resolve([
            {
              id: "all",
              name: "all",
              contexts: ["prod-eu", "staging", "dev", "qa", "kind-local"],
            },
          ])
        : (mock.invoke as (...args: unknown[]) => unknown)(command, request),
    subscribe: mock.subscribe.bind(mock),
  } as Backend;
  const workbench = await testWorkbench(undefined, backend);
  render(<TitleBar />, { wrapper: inWorkbench(workbench) });
  return workbench;
}

test("a name of more than 28 characters can be cut, never below 28; a shorter one is not cut", async () => {
  const workbench = await inLongSpace();
  const name = workbench.spaces.active?.contexts.join(" + ") ?? "";
  expect(name.length).toBeGreaterThan(28);
  const crumb = screen.getByRole("button", { name: "Switch space" });
  expect(crumb.textContent).toBe(name);
  expect(crumb.style.minWidth).toBe("calc(28ch + 2rem)");
  cleanup();

  await mounted();
  expect(
    screen.getByRole("button", { name: "Switch space" }).style.minWidth,
  ).toBe("max-content");
});

test("the scope is cut in the middle: its last characters stay whole and what comes before gives way", async () => {
  const { workbench } = await mounted();
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["payments", "checkout", "ledger", "platform-observability"],
    }));
  });
  const crumb = screen.getByRole("button", { name: "Select namespace" });
  const scope = "payments, checkout, ledger, platform-observability";
  expect(crumb.textContent).toBe(scope);
  const [head, tail] = [...(crumb.querySelector("span")?.children ?? [])];
  expect(tail?.textContent).toBe(scope.slice(-8));
  expect(head?.textContent).toBe(scope.slice(0, -8));
});
