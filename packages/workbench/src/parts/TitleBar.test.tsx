import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { TitleBar } from "./TitleBar";

afterEach(cleanup);

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
