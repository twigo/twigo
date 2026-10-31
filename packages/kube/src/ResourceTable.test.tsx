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
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { PODS } from "./kinds";
import { ResourceTable } from "./ResourceTable";

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

async function show(scenario: MockScenario, space = "prod-eu") {
  render(
    <ResourceTable
      backend={createMockBackend(scenario)}
      space={space}
      gvr={PODS}
      title="Pods"
    />,
  );
  await settle();
}

const header = (name: string) => screen.getByRole("columnheader", { name });

test("rows from the window render with the server's priority-0 columns", async () => {
  await show("ready");
  expect(screen.getByText("5,000")).toBeTruthy();
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(headers).toEqual([
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "Age",
  ]);
  expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
});

test("clicking a header sorts by that column, then reverses, keeping rows on screen", async () => {
  await show("ready");
  fireEvent.click(header("Ready"));
  expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
  await settle();
  expect(header("Ready").getAttribute("aria-sort")).toBe("ascending");
  const cells = () =>
    screen
      .getAllByRole("row")
      .slice(1, 4)
      .map((row) => row.children[2]?.textContent);
  expect(cells()).toEqual(["0/1", "0/1", "0/1"]);
  fireEvent.click(header("Ready"));
  await settle();
  expect(header("Ready").getAttribute("aria-sort")).toBe("descending");
  expect(cells()).toEqual(["3/3", "3/3", "3/3"]);
});

test("a space without pods shows the empty state, not an error", async () => {
  await show("live", "dev");
  await settle(30);
  expect(screen.getByText("No pods")).toBeTruthy();
});

test.each([
  ["forbidden", "Access denied"],
  ["unauthorized", "Sign-in needed"],
  ["error", "Could not load pods"],
] as const)("%s shows its own panel with a retry", async (scenario, title) => {
  await show(scenario);
  expect(screen.getByText(title)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test.each([
  ["queued", "Waiting for a stream slot"],
  ["connecting", "Connecting…"],
  ["syncing", "Loading · 1,850"],
  ["relisting", "Relisting…"],
  ["stale", "No updates · reconnecting"],
] as const)("%s is named in the header", async (scenario, label) => {
  await show(scenario);
  expect(screen.getByText(label)).toBeTruthy();
});
