import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { inWorkbench, testWorkbench } from "../testing";
import { TitleBar } from "./TitleBar";

afterEach(cleanup);

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
  const { workbench, container } = await mounted();
  await settled();
  const chip = screen.getByRole("button", {
    name: "Mode of prod-eu: Production · read-only",
  });
  expect(chip.textContent).toBe("Production · read-only");
  expect(container.querySelector("header")?.dataset.strong).toBe("");

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

test("a context nobody marked has no chip and no strong cue", async () => {
  const { workbench, container } = await mounted();
  await act(() => workbench.spaces.open("qa"));
  expect(screen.queryByRole("button", { name: /^Mode of/ })).toBeNull();
  expect(container.querySelector("header")?.dataset.strong).toBeUndefined();
});

test("a type other than Production has its chip and no strong cue", async () => {
  const { workbench, container } = await mounted();
  act(() => {
    workbench.spaces.select("dev");
  });
  await settled();
  expect(
    screen.getByRole("button", { name: "Mode of dev: Development" }),
  ).toBeTruthy();
  expect(container.querySelector("header")?.dataset.strong).toBeUndefined();
});
