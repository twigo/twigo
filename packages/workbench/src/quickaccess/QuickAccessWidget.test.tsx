import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { QuickAccessWidget } from "./QuickAccessWidget";
import type { QuickPickItem } from "./registry";

afterEach(cleanup);

test("items loaded for another value are neither shown nor accepted", async () => {
  const workbench = await testWorkbench();
  const pending = new Map<string, (items: QuickPickItem[]) => void>();
  const accept = vi.fn();
  workbench.quickAccess.register({
    prefix: "!",
    placeholder: "",
    help: "",
    items: (filter) =>
      new Promise((resolve) => {
        pending.set(filter, resolve);
      }),
    accept,
  });
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  act(() => {
    workbench.quickAccess.show("!a");
  });
  await act(async () => {
    pending.get("a")?.([{ id: "a", label: "alpha" }]);
    await Promise.resolve();
  });
  expect(screen.getByText("alpha")).toBeTruthy();

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "!ab" } });
  expect(screen.queryByText("alpha")).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(accept).not.toHaveBeenCalled();

  await act(async () => {
    pending.get("ab")?.([{ id: "ab", label: "alphabet" }]);
    await Promise.resolve();
  });
  expect(screen.getByText("alphabet")).toBeTruthy();
});
