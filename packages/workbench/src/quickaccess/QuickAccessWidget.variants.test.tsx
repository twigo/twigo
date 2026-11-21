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
import type { QuickAccessProvider, QuickPickItem } from "./registry";

afterEach(cleanup);

const ITEMS: readonly QuickPickItem[] = [
  { id: "all", label: "All namespaces" },
  { id: "payments", label: "payments", checked: true },
  { id: "auth", label: "auth", checked: false },
];

async function opened(extra: Partial<QuickAccessProvider>) {
  const workbench = await testWorkbench();
  const accept = vi.fn();
  const acceptChecked = vi.fn();
  workbench.quickAccess.register({
    prefix: "!",
    placeholder: "",
    help: "",
    acceptLabel: "Only this",
    checkedWords: (count) => `${String(count)} namespaces`,
    items: () => ITEMS,
    accept,
    acceptChecked,
    ...extra,
  });
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  await act(async () => {
    workbench.quickAccess.show("!");
    await Promise.resolve();
  });
  return { workbench, accept, acceptChecked };
}

const input = () => screen.getByRole("combobox");
const press = (code: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(input(), { key: code, code, ...init });
const rowOf = (name: string) => screen.getByRole("option", { name });
const footer = () => screen.getByLabelText("Keys").textContent;

test("a checklist ticks on a click and applies the ticked set on Enter from the start", async () => {
  const { workbench, accept, acceptChecked } = await opened({
    checklist: true,
  });
  expect(footer()).toContain("Apply · 1 namespaces");
  fireEvent.click(rowOf("auth"));
  expect(rowOf("auth").getAttribute("aria-checked")).toBe("true");
  expect(accept).not.toHaveBeenCalled();

  press("Enter");
  await act(() => Promise.resolve());
  expect(acceptChecked).toHaveBeenCalledWith(
    ["payments", "auth"],
    "",
    expect.anything(),
  );
  expect(workbench.quickAccess.session).toBeUndefined();
});

test("a live pick applies each tick at once and stays open, and a click or Enter takes a row alone", async () => {
  const { workbench, accept, acceptChecked } = await opened({ live: true });
  press("ArrowDown");
  press("ArrowDown");
  press("ArrowDown");
  fireEvent.keyDown(input(), { key: " ", code: "Space" });
  expect(acceptChecked).toHaveBeenLastCalledWith(
    ["payments", "auth"],
    "",
    expect.anything(),
  );
  expect(workbench.quickAccess.session).toBeDefined();
  expect(footer()).toContain("Only this");

  fireEvent.click(rowOf("payments"));
  await act(() => Promise.resolve());
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "payments" }),
    "",
    expect.anything(),
    { side: false },
  );
  expect(acceptChecked).toHaveBeenCalledTimes(1);
});
