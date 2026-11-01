import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

vi.mock("allotment", () => {
  function Allotment({ children }: { children: ReactNode }) {
    return <div>{children}</div>;
  }
  Allotment.Pane = function Pane({ children }: { children: ReactNode }) {
    return <div>{children}</div>;
  };
  return { Allotment, LayoutPriority: { High: "HIGH" } };
});

vi.mock("./TitleBar", () => ({
  TitleBar: () => {
    throw new Error("title bar broke");
  },
}));

vi.mock("./SpaceRail", () => ({
  SpaceRail: () => {
    throw new Error("space rail broke");
  },
}));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const alerts = () =>
  screen.getAllByRole("alert").map((a) => a.getAttribute("title"));

test("a crashed title bar, space rail or status item leaves the rest of the window working", async () => {
  const workbench = await testWorkbench();
  workbench.views.registerStatusBarItem({
    id: "broken",
    alignment: "left",
    priority: 0,
    component: () => {
      throw new Error("status item broke");
    },
  });
  workbench.views.registerStatusBarItem({
    id: "working",
    alignment: "right",
    priority: 0,
    component: () => <span>still here</span>,
  });
  render(<WorkbenchView workbench={workbench} />);
  expect(alerts()).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Title bar crashed: title bar broke"),
      expect.stringContaining("Space rail crashed: space rail broke"),
      expect.stringContaining("broken crashed: status item broke"),
    ]),
  );
  expect(screen.getByText("still here")).toBeTruthy();
  act(() => {
    workbench.quickAccess.show(">");
  });
  expect(screen.getByRole("combobox")).toBeTruthy();
});

test("a crash in quick access closes it, and it opens again", async () => {
  const workbench = await testWorkbench();
  let broken = true;
  workbench.quickAccess.register({
    prefix: "!",
    placeholder: "",
    help: "",
    items: () =>
      broken
        ? [
            {
              id: "bad",
              get label(): string {
                throw new Error("label broke");
              },
            },
          ]
        : [{ id: "good", label: "good item" }],
    accept: () => undefined,
  });
  render(<WorkbenchView workbench={workbench} />);
  await act(async () => {
    workbench.quickAccess.show("!");
    await Promise.resolve();
  });
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(screen.queryByRole("combobox")).toBeNull();

  broken = false;
  await act(async () => {
    workbench.quickAccess.show("!");
    await Promise.resolve();
  });
  expect(screen.getByText("good item")).toBeTruthy();
});
