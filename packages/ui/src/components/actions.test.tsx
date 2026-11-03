import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ActionContextMenu, ActionDropdown, type Action } from "./actions";

afterEach(cleanup);

function action(label: string, more: Partial<Action> = {}): Action {
  return { id: label, label, run: () => undefined, ...more };
}

const closed = () => act(() => new Promise((resolve) => setTimeout(resolve)));

test("a context menu's action runs once the menu has closed, with the focus back where it was", async () => {
  let focused: Element | null = null;
  render(
    <>
      <button type="button">Before</button>
      <input aria-label="Picker" />
      <ActionContextMenu
        actions={[
          [
            action("Open Picker", {
              run: () => {
                focused = document.activeElement;
                screen.getByLabelText("Picker").focus();
              },
            }),
          ],
        ]}
      >
        <div>Row</div>
      </ActionContextMenu>
    </>,
  );
  const before = screen.getByRole("button", { name: "Before" });
  const picker = screen.getByLabelText("Picker");
  before.focus();
  fireEvent.contextMenu(screen.getByText("Row"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open Picker" }));
  await closed();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(focused).toBe(before);
  expect(document.activeElement).toBe(picker);
});

test("a dropdown's action runs once the menu has closed and its trigger has the focus back", async () => {
  let focused: Element | null = null;
  render(
    <>
      <input aria-label="Picker" />
      <ActionDropdown
        label="Row actions"
        actions={[
          [
            action("Open Picker", {
              run: () => {
                focused = document.activeElement;
                screen.getByLabelText("Picker").focus();
              },
            }),
          ],
        ]}
      >
        <button type="button">⋯</button>
      </ActionDropdown>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Row actions" });
  const picker = screen.getByLabelText("Picker");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitem", { name: "Open Picker" }));
  await closed();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(focused).toBe(trigger);
  expect(document.activeElement).toBe(picker);
});
