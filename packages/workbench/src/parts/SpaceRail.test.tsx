import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { QuickAccessWidget } from "../quickaccess/QuickAccessWidget";
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

test("a tile's menu picks the colour of its own space, in a picker that has the focus", async () => {
  const workbench = await testWorkbench();
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  render(
    <>
      <SpaceRail />
      <QuickAccessWidget />
    </>,
    { wrapper: inWorkbench(workbench) },
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "qa" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Set Space Colour/ }));
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  const picker = document.activeElement ?? document.body;
  expect(picker.getAttribute("placeholder")).toBe("Colour of qa");

  fireEvent.change(picker, { target: { value: "purple" } });
  fireEvent.keyDown(picker, { key: "Enter", code: "Enter" });
  await act(() => Promise.resolve());
  expect(workbench.colors.of("qa")).toBe("purple");
  expect(workbench.colors.of("prod-eu")).toBe("red");
});

test("the last button opens the space picker", async () => {
  const workbench = await testWorkbench();
  render(<SpaceRail />, { wrapper: inWorkbench(workbench) });
  fireEvent.click(screen.getByRole("button", { name: "Open a space" }));
  expect(workbench.quickAccess.session?.value).toBe("ctx ");
});
