import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Changes } from "../changes";
import { QuickAccessWidget } from "../quickaccess/QuickAccessWidget";
import type { SpaceConnection } from "../spaces/status";
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

test("a tile's dot and tooltip follow its connection, and a tile without one has neither", async () => {
  const workbench = await testWorkbench();
  const changes = new Changes();
  let staging: SpaceConnection = { tone: "warn", label: "Reconnecting" };
  workbench.spaceStatus.register({
    changes,
    status: (space) => (space === "staging" ? staging : undefined),
  });
  render(<SpaceRail />, { wrapper: inWorkbench(workbench) });
  const tile = (name: string) => screen.getByRole("button", { name });
  const dot = (name: string) => tile(name).querySelector("span.rounded-full");
  expect(dot("prod-eu")).toBeNull();
  expect(dot("staging")?.classList.contains("animate-pulse")).toBe(true);
  fireEvent.focus(tile("staging"));
  expect(screen.getByRole("tooltip").textContent).toBe("staging⌘2Reconnecting");

  staging = { tone: "error", label: "Unauthorized" };
  act(() => {
    changes.emit();
  });
  expect(dot("staging")?.classList.contains("bg-error")).toBe(true);
  expect(dot("staging")?.classList.contains("animate-pulse")).toBe(false);
  expect(screen.getByRole("tooltip").textContent).toBe("staging⌘2Unauthorized");
  fireEvent.blur(tile("staging"));
  fireEvent.focus(tile("prod-eu"));
  expect(screen.getByRole("tooltip").textContent).toBe("prod-eu⌘1");
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
