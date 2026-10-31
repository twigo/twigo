import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { TitleBar } from "./TitleBar";

afterEach(cleanup);

test("the title bar drags the window", async () => {
  const workbench = await testWorkbench();
  const { container } = render(<TitleBar />, {
    wrapper: inWorkbench(workbench),
  });
  expect(
    container.querySelector("header[data-tauri-drag-region]"),
  ).not.toBeNull();
});

test("only a single-context space with a colour shows a dot", async () => {
  const workbench = await testWorkbench();
  render(<TitleBar />, { wrapper: inWorkbench(workbench) });
  const dots = (name: string) =>
    [...screen.getByRole("tab", { name }).querySelectorAll("[data-color]")].map(
      (dot) => dot.getAttribute("data-color"),
    );
  expect(dots("prod-eu")).toEqual(["red"]);
  expect(dots("dev+qa")).toEqual([]);
});

test("a click selects the space and moves the context keys", async () => {
  const workbench = await testWorkbench();
  render(<TitleBar />, { wrapper: inWorkbench(workbench) });
  expect(
    screen.getByRole("tab", { name: "prod-eu" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "dev+qa" }));
  expect(
    screen.getByRole("tab", { name: "dev+qa" }).getAttribute("aria-selected"),
  ).toBe("true");
  const lookup = workbench.keys.lookup(null);
  expect(lookup("space.contexts")).toEqual(["dev", "qa"]);
  expect(lookup("space.multiContext")).toBe(true);
  expect(lookup("context.name")).toBeUndefined();
});
