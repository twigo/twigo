import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { initials } from "./spaceBadge";
import { SpaceRail } from "./SpaceRail";

afterEach(cleanup);

test.each([
  ["prod-eu", "PE"],
  ["staging", "ST"],
  ["dev+qa", "DQ"],
  ["kind-local", "KL"],
  ["кластер", "КЛ"],
])("%s is %s", (name, letters) => {
  expect(initials(name)).toBe(letters);
});

test("a tile per space, the active one current, a click switches", async () => {
  const workbench = await testWorkbench();
  render(<SpaceRail />, { wrapper: inWorkbench(workbench) });
  const tile = (name: string) => screen.getByRole("button", { name });
  expect(tile("prod-eu").getAttribute("aria-current")).toBe("true");
  expect(tile("staging").textContent).toBe("ST");
  fireEvent.click(tile("dev"));
  expect(workbench.spaces.active?.id).toBe("dev");
  expect(tile("dev").getAttribute("aria-current")).toBe("true");
  expect(workbench.keys.lookup(null)("context.name")).toBe("dev");
});

test("the last button opens the space picker", async () => {
  const workbench = await testWorkbench();
  render(<SpaceRail />, { wrapper: inWorkbench(workbench) });
  fireEvent.click(screen.getByRole("button", { name: "Open a space" }));
  expect(workbench.quickAccess.session?.value).toBe("ctx ");
});
