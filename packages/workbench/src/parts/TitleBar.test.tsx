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
  expect(space.querySelector("[data-color]")?.getAttribute("data-color")).toBe(
    "red",
  );
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
    workbench.spaces.select("dev+qa");
    workbench.spaces.update("dev+qa", (state) => ({
      ...state,
      namespaces: ["payments"],
    }));
  });
  const space = screen.getByRole("button", { name: "Switch space" });
  expect(space.textContent).toBe("dev + qa");
  expect(space.querySelector("[data-color]")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Select namespace" }).textContent,
  ).toBe("payments");
});

test("the search opens quick access and the toggles show and hide the parts", async () => {
  const { workbench } = await mounted();
  fireEvent.click(screen.getByRole("button", { name: /Search prod-eu/ }));
  expect(workbench.quickAccess.session?.value).toBe("");
  const panel = screen.getByRole("button", { name: "Toggle Panel" });
  expect(panel.getAttribute("aria-pressed")).toBe("false");
  await act(async () => {
    fireEvent.click(panel);
    await Promise.resolve();
  });
  expect(workbench.spaces.state("prod-eu").parts.panel.visible).toBe(true);
});
