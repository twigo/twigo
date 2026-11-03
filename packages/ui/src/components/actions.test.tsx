import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, beforeEach, expect, test, vi } from "vitest";
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

test("a context menu's action runs as the menu closes, with the focus back where it was", async () => {
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

test("a dropdown's action runs as the menu closes, with the focus back on its trigger", async () => {
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

describe("with the menu's close animated", () => {
  const style = window.getComputedStyle.bind(window);
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) => {
        const computed = style(element, pseudo);
        if (
          !(element instanceof HTMLElement) ||
          element.dataset.slot !== "context-menu-content"
        )
          return computed;
        return new Proxy(computed, {
          get(target, key) {
            if (key === "animationName")
              return element.dataset.state === "closed" ? "exit" : "enter";
            if (key === "display") return "block";
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function"
              ? (value as () => unknown).bind(target)
              : value;
          },
        });
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const endClose = () => {
    const content = document.querySelector(
      '[data-slot="context-menu-content"]',
    );
    if (!content) throw new Error("no menu");
    const end = new Event("animationend");
    Object.defineProperty(end, "animationName", { value: "exit" });
    act(() => {
      content.dispatchEvent(end);
    });
  };

  test("a choice runs as its menu starts to close, and a menu opened again meanwhile runs nothing more", async () => {
    const run = vi.fn();
    openContextMenu([[action("Delete", { run })]]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await closed();
    expect(
      document.querySelector('[data-slot="context-menu-content"]'),
    ).not.toBeNull();
    expect(run).toHaveBeenCalledOnce();
    fireEvent.contextMenu(screen.getByText("Row"));
    await closed();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    endClose();
    await closed();
    expect(run).toHaveBeenCalledOnce();
  });

  test("a choice acts on what its menu was opened for, though another menu opens before the close ends", async () => {
    let target = "";
    const copied: string[] = [];
    render(
      <ActionContextMenu
        actions={[
          [
            action("Copy Name", {
              run: () => {
                copied.push(target);
              },
            }),
          ],
        ]}
      >
        <div>
          {["api-1", "api-2"].map((name) => (
            <div
              key={name}
              onContextMenu={() => {
                target = name;
              }}
            >
              {name}
            </div>
          ))}
        </div>
      </ActionContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("api-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
    await closed();
    fireEvent.contextMenu(screen.getByText("api-2"));
    await closed();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
    endClose();
    await closed();
    expect(copied).toEqual(["api-1", "api-2"]);
  });

  test("the focus a choice gives stays once the close animation ends", async () => {
    render(
      <>
        <button type="button">Before</button>
        <input aria-label="Picker" />
        <ActionContextMenu
          actions={[
            [
              action("Open Picker", {
                run: () => {
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
    screen.getByRole("button", { name: "Before" }).focus();
    fireEvent.contextMenu(screen.getByText("Row"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Picker" }));
    await closed();
    endClose();
    await closed();
    expect(document.activeElement).toBe(screen.getByLabelText("Picker"));
  });

  test("a click on a menu that is already fading out chooses nothing", async () => {
    const run = vi.fn();
    openContextMenu([[action("Copy Name", { run })]]);
    const item = screen.getByRole("menuitem", { name: "Copy Name" });
    fireEvent.click(item);
    await closed();
    fireEvent.click(item);
    await closed();
    fireEvent.contextMenu(screen.getByText("Row"));
    await closed();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    endClose();
    await closed();
    expect(run).toHaveBeenCalledOnce();
  });

  test("a menu opened again while it fades out takes the focus, and gives it back on Escape", async () => {
    render(
      <>
        <button type="button">Before</button>
        <ActionContextMenu actions={[[action("Copy Name")]]}>
          <div>Row</div>
        </ActionContextMenu>
      </>,
    );
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    fireEvent.contextMenu(screen.getByText("Row"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
    await closed();
    fireEvent.contextMenu(screen.getByText("Row"));
    await closed();
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(
      true,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    endClose();
    await closed();
    expect(document.activeElement).toBe(before);
  });

  test("a right click elsewhere while the menu is shown keeps where the focus goes back", async () => {
    const run = vi.fn();
    render(
      <ActionContextMenu actions={[[action("Copy Name", { run })]]}>
        <div role="grid" tabIndex={0} aria-label="Pods">
          <div>api-1</div>
          <div>api-2</div>
        </div>
      </ActionContextMenu>,
    );
    const grid = screen.getByRole("grid", { name: "Pods" });
    grid.focus();
    fireEvent.contextMenu(screen.getByText("api-1"));
    await closed();
    fireEvent.contextMenu(screen.getByText("api-2"));
    await closed();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
    await closed();
    endClose();
    await closed();
    expect(run).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(grid);
  });

  test("a right click while another menu holds the focus sends it back around the trigger", async () => {
    const run = vi.fn();
    render(
      <>
        <div role="menu" tabIndex={-1} aria-label="Other" />
        <div role="grid" tabIndex={0} aria-label="Pods">
          <ActionContextMenu actions={[[action("Copy Name", { run })]]}>
            <div>api-1</div>
          </ActionContextMenu>
        </div>
      </>,
    );
    screen.getByRole("menu", { name: "Other" }).focus();
    fireEvent.contextMenu(screen.getByText("api-1"));
    await closed();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
    await closed();
    endClose();
    await closed();
    expect(run).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(
      screen.getByRole("grid", { name: "Pods" }),
    );
  });

  test("a right click while nothing holds the focus sends it around the trigger", async () => {
    let focused: Element | null = null;
    render(
      <div role="grid" tabIndex={0} aria-label="Pods">
        <ActionContextMenu
          actions={[
            [
              action("Copy Name", {
                run: () => {
                  focused = document.activeElement;
                },
              }),
            ],
          ]}
        >
          <div>api-1</div>
        </ActionContextMenu>
      </div>,
    );
    const grid = screen.getByRole("grid", { name: "Pods" });
    fireEvent.contextMenu(screen.getByText("api-1"));
    await closed();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
    await closed();
    expect(focused).toBe(grid);
  });
});
