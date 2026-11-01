import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { testWorkbench } from "./testing";
import { WorkbenchView } from "./WorkbenchView";

vi.mock("./parts/Shell", () => ({
  Shell: () => {
    throw new Error("shell broke");
  },
}));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a crash outside every part shows the error in the window instead of a blank page", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  expect(screen.getByText("Workbench crashed")).toBeTruthy();
  expect(screen.getByText("shell broke")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});
