import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { Workbench, WorkbenchView } from "@twigo/workbench";
import { PODS } from "./kinds";
import { registerKube } from "./register";
import { cellTone } from "./tones";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1000,
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function settle(steps = 6) {
  for (let i = 0; i < steps; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
    act(() => {
      vi.advanceTimersToNextFrame();
    });
  }
}

async function podsList(backend = createMockBackend("ready")) {
  const workbench = new Workbench(backend, "mac", {
    id: "us",
    keys: {},
  });
  registerKube(workbench);
  const loaded = workbench.spaces.load();
  await act(() => vi.advanceTimersByTimeAsync(10));
  await loaded;
  render(<WorkbenchView workbench={workbench} />);
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  return workbench;
}

const rows = () => screen.getAllByRole("row").slice(1);
const details = () =>
  screen.queryByRole("complementary", { name: "Pod details" });
const key = (code: string) => {
  fireEvent.keyDown(screen.getByRole("grid"), { code, key: code });
};

test("a click opens the row's details over the list, arrows follow, Escape closes", async () => {
  await podsList();
  expect(details()).toBeNull();
  const [first, second] = rows();
  if (!first || !second) throw new Error("no rows");
  fireEvent.click(first);
  expect(details()?.textContent).toContain(
    first.children[0]?.textContent ?? "?",
  );
  act(() => {
    screen.getByRole("grid").focus();
  });
  key("KeyJ");
  await settle(2);
  expect(details()?.textContent).toContain(
    second.children[0]?.textContent ?? "?",
  );
  key("Escape");
  expect(details()).toBeNull();
});

test("Enter on the selected row opens its details", async () => {
  await podsList();
  act(() => {
    screen.getByRole("grid").focus();
  });
  key("KeyJ");
  await settle(2);
  expect(details()).toBeNull();
  key("Enter");
  expect(details()).not.toBeNull();
});

test("the status bar counts the active list's rows", async () => {
  await podsList();
  expect(screen.getByText("5,000 pods")).toBeTruthy();
});

const statusOf = (row: HTMLElement) => row.children[3]?.textContent ?? "";
const chip = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

test("a health chip shows only its rows while every count stays", async () => {
  await podsList();
  const counts = () =>
    ["All", "Failing", "Pending", "Healthy"].map(
      (name) => chip(name).textContent,
    );
  const before = counts();
  fireEvent.click(chip("Failing"));
  await settle();
  expect(chip("Failing").getAttribute("aria-pressed")).toBe("true");
  expect(rows().length).toBeGreaterThan(0);
  expect(
    rows().filter((row) => cellTone(PODS, "Status", statusOf(row)) !== "error"),
  ).toEqual([]);
  expect(counts()).toEqual(before);
  fireEvent.click(chip("All"));
  await settle();
  expect(screen.getByText("5,000 pods")).toBeTruthy();
});

test("a count in the status bar shows only those rows", async () => {
  await podsList();
  fireEvent.click(screen.getByRole("button", { name: /pending:/ }));
  await settle();
  expect(chip("Pending").getAttribute("aria-pressed")).toBe("true");
  expect(
    rows().filter((row) => cellTone(PODS, "Status", statusOf(row)) !== "warn"),
  ).toEqual([]);
});

test("/ in the list focuses the filter field, and its text filters the rows", async () => {
  await podsList();
  act(() => {
    screen.getByRole("grid").focus();
  });
  key("Slash");
  const field = screen.getByRole("textbox", { name: "Filter rows" });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "ImagePullBackOff" } });
  await settle();
  expect(rows().length).toBeGreaterThan(0);
  expect(rows().filter((row) => statusOf(row) !== "ImagePullBackOff")).toEqual(
    [],
  );
});

const openMenu = (trigger: HTMLElement) => {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
};

test("a row's actions button and a right click run the resource commands on that row", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  await podsList();
  const second = rows()[1];
  if (!second) throw new Error("no rows");
  const name = second.children[0]?.textContent;
  const namespace = second.children[1]?.textContent;
  const trigger = within(second).getByRole("button", { name: "Row actions" });
  openMenu(trigger);
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Copy Namespace/Name" }),
  );
  await settle(1);
  expect(writeText).toHaveBeenCalledWith(`${namespace ?? ""}/${name ?? ""}`);

  const third = rows()[2];
  if (!third) throw new Error("no rows");
  fireEvent.contextMenu(third);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open Details" }));
  await settle(1);
  expect(details()?.textContent).toContain(third.children[0]?.textContent);
});

test("the column chooser shows a wide column, and the kind keeps the choice", async () => {
  const backend = createMockBackend("ready");
  await podsList(backend);
  expect(screen.queryByRole("columnheader", { name: "IP" })).toBeNull();
  openMenu(screen.getByRole("button", { name: "Choose columns" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "IP" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await settle(1);
  expect(screen.getByRole("columnheader", { name: "IP" })).toBeTruthy();

  cleanup();
  await podsList(backend);
  expect(screen.getByRole("columnheader", { name: "IP" })).toBeTruthy();
});
