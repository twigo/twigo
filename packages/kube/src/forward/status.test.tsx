import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createMockBackend,
  LOSES_POD_AFTER_MS,
  READY_AFTER_MS,
  RECONNECTS_FOR_MS,
  type MockScenario,
} from "@twigo/protocol/mock";
import { mountKube, settle, withScreenSize } from "../../test/workbench";

withScreenSize(1400);

const SERVICES = { group: "", version: "v1", resource: "services" };
const target = (space: string, name: string) => ({
  space,
  gvr: SERVICES,
  namespace: "payments",
  name,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function mounted(scenario: MockScenario = "live") {
  const backend = createMockBackend(scenario);
  const workbench = await mountKube(backend);
  return { workbench, backend };
}

const entry = () =>
  document.querySelector<HTMLElement>('button[title^="Port forwards:"]');
const tooltip = () => entry()?.getAttribute("title");
const warns = (button: HTMLElement | null) =>
  button?.querySelector('span[class*="var(--warn)"]') != null;

test("with no forward running the status bar has no entry", async () => {
  await mounted();
  expect(entry()).toBeNull();
  expect(screen.queryByText(/\d+ forwards?$/)).toBeNull();
});

test("one entry counts the space's running forwards, a stopped one not, a failed one still, and names them", async () => {
  await mounted("forwardRestored");
  const button = entry();
  expect(button?.textContent).toBe("2 forwards");
  expect(button?.getAttribute("title")).toBe(
    "Port forwards: payments-api:http → 8081, payments-legacy:http → 8082 (failed)",
  );
  expect(
    document.querySelectorAll('button[title^="Port forwards:"]'),
  ).toHaveLength(1);
});

test("the entry warns while a forward fails, and not once nothing does", async () => {
  const { backend } = await mounted("forwardRestored");
  expect(warns(entry())).toBe(true);
  await act(() => backend.invoke("forward_remove", 3));
  await settle(4);
  expect(entry()?.textContent).toBe("1 forward");
  expect(warns(entry())).toBe(false);
});

test("a forward that reconnects makes the entry warn for as long as it waits", async () => {
  const { backend } = await mounted("forwardReconnecting");
  await act(() =>
    backend.invoke("forward_start", {
      target: target("prod-eu", "payments-api"),
      port: 80,
      local: null,
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(READY_AFTER_MS + 100));
  expect(entry()?.textContent).toBe("1 forward");
  expect(warns(entry())).toBe(false);
  expect(tooltip()).toBe("Port forwards: payments-api:http → 8080");

  await act(() => vi.advanceTimersByTimeAsync(LOSES_POD_AFTER_MS));
  expect(warns(entry())).toBe(true);
  expect(tooltip()).toBe(
    "Port forwards: payments-api:http → 8080 (reconnecting)",
  );

  await act(() => vi.advanceTimersByTimeAsync(RECONNECTS_FOR_MS));
  expect(warns(entry())).toBe(false);
});

test("the forwards of other spaces are not counted", async () => {
  const { backend } = await mounted();
  await act(() => backend.invoke("space_open", "qa"));
  await act(() =>
    backend.invoke("forward_start", {
      target: target("qa", "payments-api"),
      port: 80,
      local: null,
    }),
  );
  await settle(4);
  expect(entry()).toBeNull();
});

test("a click on the entry shows the Port forwards in the side bar", async () => {
  const { workbench } = await mounted("forwardRestored");
  expect(screen.queryByRole("grid", { name: "Port forwards" })).toBeNull();
  const button = entry();
  if (!button) throw new Error("no entry");
  fireEvent.click(button);
  await settle(6);
  screen.getByRole("grid", { name: "Port forwards" });
  expect(workbench.spaces.state("prod-eu").parts.sidebar.container).toBe(
    "kube.forwards",
  );
});

test("stopping the last running forward takes the entry away", async () => {
  const { backend } = await mounted("forwardRestored");
  await act(() => backend.invoke("forward_stop", 1));
  await act(() => backend.invoke("forward_stop", 3));
  await settle(4);
  expect(entry()).toBeNull();
});
