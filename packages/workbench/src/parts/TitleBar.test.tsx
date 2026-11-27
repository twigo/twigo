import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { confirmAsking, inWorkbench, testWorkbench } from "../testing";
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

const COPIES = { words: 400, search: 60 };

function measure(width: number, copies: Partial<typeof COPIES> = COPIES) {
  const sizes: Record<string, number> = { ...COPIES, ...copies };
  act(() => {
    for (const { target, report, observer } of watching) {
      const size =
        target.tagName === "HEADER"
          ? width
          : target.childElementCount === 0
            ? 0
            : sizes[target.getAttribute("data-copy") ?? ""];
      if (size === undefined) continue;
      report(
        [{ target, contentRect: { width: size } } as ResizeObserverEntry],
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
  const space = screen.getByRole("button", { name: "Switch space, prod-eu" });
  expect(space.textContent).toBe("prod-eu");
  expect(space.querySelector("[data-color]")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Select namespace, All namespaces" })
      .textContent,
  ).toBe("All namespaces");
  fireEvent.click(space);
  expect(workbench.quickAccess.session?.value).toBe("ctx ");
  act(() => {
    workbench.quickAccess.hide();
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Select namespace, All namespaces" }),
  );
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
  const space = screen.getByRole("button", { name: "Switch space, staging" });
  expect(space.textContent).toBe("staging");
  expect(
    screen.getByRole("button", { name: "Select namespace, payments" })
      .textContent,
  ).toBe("payments");
});

test("several namespaces read as the scope chip does, the first name and how many follow, with every name in the tooltip and a name that says them", async () => {
  const { workbench, container } = await mounted();
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["auth", "checkout", "payments"],
    }));
  });
  const scope = screen.getByRole("button", {
    name: "Select namespace, auth and 2 more",
  });
  expect(scope.textContent).toBe("auth+2");
  const copy = container.querySelector('[data-copy="words"]')?.textContent;
  expect(copy).toContain("auth+2");
  expect(copy).not.toContain("checkout");
  fireEvent.focus(scope);
  expect(
    await screen.findAllByText("Namespaces: auth, checkout, payments"),
  ).not.toHaveLength(0);
  fireEvent.click(scope);
  expect(workbench.quickAccess.session?.value).toBe("ns ");
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
  await confirmAsking(workbench);
  await waitFor(() => {
    expect(workbench.catalog.find("prod-eu")?.access.mode).toBe("guarded");
  });
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
  expect(invoke).not.toHaveBeenCalledWith("command_plan", expect.anything());

  fireEvent.click(
    screen.getByRole("button", { name: /Unlock for 15 minutes/ }),
  );
  await confirmAsking(workbench);
  await waitFor(() => {
    expect(workbench.catalog.find("prod-eu")?.access.unlockedUntil).not.toBe(
      null,
    );
  });
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
  await confirmAsking(workbench);
  await waitFor(() => {
    expect(workbench.catalog.find("prod-eu")?.access.source).toMatchObject({
      kind: "user",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Use the default" }));
  await confirmAsking(workbench);
  await waitFor(() => {
    expect(workbench.catalog.find("prod-eu")?.access.mode).toBe("read-only");
  });
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

test("while the person's protection file cannot be read the popover says why and offers no change", async () => {
  const workbench = await testWorkbench(
    undefined,
    createMockBackend("protectionUnreadable"),
  );
  render(<TitleBar />, { wrapper: inWorkbench(workbench) });
  await settled();
  fireEvent.click(screen.getByRole("button", { name: /^Mode of prod-eu/ }));
  expect(
    screen.getByText(/protection\.json, which holds the modes and types/),
  ).toBeTruthy();
  for (const offered of ["Read-write", "Guarded", "Staging", "None"]) {
    expect(screen.queryByRole("button", { name: offered })).toBeNull();
  }
  expect(screen.queryByRole("button", { name: /Unlock/ })).toBeNull();
});

test("a context nobody marked has a quiet chip that opens the choices of any other, where the variant shows it", async () => {
  const { workbench } = await mounted();
  await act(() => workbench.spaces.open("qa"));
  fireEvent.click(
    screen.getByRole("button", { name: "Mode of qa: Not marked" }),
  );
  expect(screen.getByText(/Nobody has said what this context is/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await screen.findByRole("button", { name: "Mode of qa: Staging · guarded" });
});

test("no mode is the choice of a context nobody marked, so pressing the guarded it shows plans it", async () => {
  const { workbench } = await mounted();
  await act(() => workbench.spaces.open("qa"));
  fireEvent.click(
    screen.getByRole("button", { name: "Mode of qa: Not marked" }),
  );
  expect(
    screen
      .getByRole("button", { name: "Guarded" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Guarded" }));
  await screen.findByRole("button", { name: "Mode of qa: Guarded" });
  expect(workbench.catalog.find("qa")?.access.source).toEqual({
    kind: "user",
    overrides: null,
  });
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
  measure(1280);
  expect(search().textContent).toBe("Search prod-eu⌘P");

  measure(1100);
  expect(search().textContent).toBe("⌘P");
  fireEvent.click(search());
  expect(workbench.quickAccess.session?.value).toBe("");

  measure(1280);
  expect(search().textContent).toBe("Search prod-eu⌘P");
});

test("the chip folds to its icon last, its words kept for the tooltip and the popover", async () => {
  await mounted();
  await settled();
  const chip = () =>
    screen.getByRole("button", {
      name: "Mode of prod-eu: Production · read-only",
    });
  measure(1100);
  expect(chip().textContent).toBe("Production · read-only");
  measure(700);
  expect(chip().textContent).toBe("Production · read-only");

  measure(500);
  expect(chip().textContent).toBe("");
  expect(chip().querySelector("svg")).not.toBeNull();
  fireEvent.focus(chip());
  expect(screen.getByRole("tooltip").textContent).toBe(
    "Production · read-only",
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
  measure(500);
  const chip = screen.getByRole("button", { name: "Mode of dev: Development" });
  expect(chip.textContent).toBe("");
  expect(chip.querySelector("svg")).not.toBeNull();
  measure(1440);
  expect(chip.querySelector("svg")).toBeNull();
});

test("the search leaves the middle before the chip folds, and comes back to it as the bar widens", async () => {
  const { container } = await mounted();
  await settled();
  const columns = () =>
    container.querySelector("header")?.style.gridTemplateColumns;
  const words = () =>
    screen.getByRole("button", { name: /^Mode of prod-eu/ }).textContent;
  measure(1440);
  const centred = columns();
  measure(1100);
  expect(columns()).toBe(centred);
  measure(700);
  expect(columns()).not.toBe(centred);
  expect(
    columns()
      ?.replace(/\([^)]*\)/g, "()")
      .split(" "),
  ).toHaveLength(2);
  expect(words()).toBe("Production · read-only");
  measure(500);
  expect(words()).toBe("");
  measure(1440);
  expect(columns()).toBe(centred);
  expect(words()).toBe("Production · read-only");
});

test("a bar that has not been measured shows the search and the chip whole", async () => {
  await mounted();
  await settled();
  expect(
    screen.getByRole("button", { name: "Search prod-eu" }).textContent,
  ).toBe("Search prod-eu⌘P");
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

const named = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^${label}`) });

const parts = (label: string) =>
  [...(named(label).firstElementChild?.children ?? [])].map(
    (part) => part.textContent,
  );

test("a long name is cut in the middle: the first characters and the end stay, 28 in all, and a short one is whole", async () => {
  await inLongSpace();
  const name = "prod-eu + staging + dev + qa + kind-local";
  expect(named("Switch space").textContent).toBe(name);
  expect(parts("Switch space")).toEqual([
    "prod-eu + stagin",
    "g + dev + qa ",
    "+ kind-local",
  ]);
  cleanup();

  await mounted();
  expect(parts("Switch space")).toEqual([]);
  expect(named("Switch space").textContent).toBe("prod-eu");
});

test("the first namespace is cut in the middle too, its end staying, and All namespaces is never cut", async () => {
  const { workbench } = await mounted();
  expect(parts("Select namespace")).toEqual([]);
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["platform-observability-eu", "search"],
    }));
  });
  expect(named("Select namespace").textContent).toBe(
    "platform-observability-eu+1",
  );
  expect(parts("Select namespace")).toEqual([
    "platform-obser",
    "vability-",
    "eu",
  ]);
});

test("with no active space the bar shows the search whole, whatever the last space's breadcrumb took", async () => {
  const { workbench } = await mounted();
  const search = () => screen.getByRole("button", { name: /^Search / });
  measure(1100);
  expect(search().textContent).toBe("⌘P");
  vi.spyOn(workbench.spaces, "active", "get").mockReturnValue(undefined);
  act(() => {
    workbench.spaces.changes.emit();
  });
  measure(1100);
  expect(screen.queryByRole("button", { name: /^Switch space/ })).toBeNull();
  expect(search().textContent).toBe("Search Twigo⌘P");
});
