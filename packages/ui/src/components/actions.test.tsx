import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ActionContextMenu,
  ActionDropdown,
  type Action,
  type ActionGroups,
} from "./actions";

afterEach(cleanup);

function action(label: string, more: Partial<Action> = {}): Action {
  return { id: label, label, run: () => undefined, ...more };
}

const closed = () => act(() => new Promise((resolve) => setTimeout(resolve)));

function openContextMenu(actions: ActionGroups) {
  render(
    <ActionContextMenu actions={actions}>
      <div>Row</div>
    </ActionContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("Row"));
}

function openDropdown(actions: ActionGroups, keepOpen = false) {
  render(
    <ActionDropdown label="Row actions" actions={actions} keepOpen={keepOpen}>
      <button type="button">⋯</button>
    </ActionDropdown>,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Row actions" }), {
    button: 0,
    ctrlKey: false,
  });
}

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

test("a right click opens the actions in their groups, and without actions there is no menu", () => {
  openContextMenu([
    [action("Copy Name", { keys: "⌘C" }), action("Open Details")],
    [action("Delete", { keys: "⌘⌫", danger: true })],
  ]);
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Copy Name⌘C", "Open Details", "Delete⌘⌫"]);
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  cleanup();

  openContextMenu([]);
  expect(screen.queryByRole("menu")).toBeNull();
});

test.each([
  ["context menu", openContextMenu],
  ["dropdown", openDropdown],
])("a %s's disabled item does not run", async (_, open) => {
  const run = vi.fn();
  open([[action("Delete", { disabled: true, run })]]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  await closed();
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("with keepOpen a dropdown stays open and runs each choice at once", () => {
  const ran: string[] = [];
  const choice = (label: string, checked: boolean) =>
    action(label, {
      checked,
      run: () => {
        ran.push(label);
      },
    });
  openDropdown([[choice("IP", false), choice("Node", true)]], true);
  fireEvent.click(screen.getByRole("menuitem", { name: "IP" }));
  expect(ran).toEqual(["IP"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Node" }));
  expect(ran).toEqual(["IP", "Node"]);
  expect(screen.getByRole("menu")).toBeInTheDocument();
});
