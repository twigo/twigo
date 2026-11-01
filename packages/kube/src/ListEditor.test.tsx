import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
import { registerKube } from "./register";

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

async function podsList() {
  const workbench = new Workbench(createMockBackend("ready"), "mac", {
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
