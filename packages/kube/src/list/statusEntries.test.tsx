import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore, Workbench, WorkbenchView } from "@twigo/workbench";
import { openList, settle, withScreenSize } from "../../test/workbench";
import { cellTone } from "../columns";
import { PODS } from "../kinds";
import { registerKube } from "../register";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("the cluster's version comes once its credential does", async () => {
  const backend = createMockBackend("untrusted");
  const workbench = new Workbench(
    backend,
    "mac",
    { id: "us", keys: {} },
    await StateStore.load(backend, () => undefined),
  );
  registerKube(workbench);
  await act(() =>
    Promise.all([workbench.catalog.watch(), workbench.spaces.load()]),
  );
  await act(() => workbench.credentials.start());
  render(<WorkbenchView workbench={workbench} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.queryByText("v1.33.4")).toBeNull();

  const { auth } = workbench.credentials;
  if (auth.state !== "untrusted") throw new Error(auth.state);
  await act(() => workbench.credentials.trust(auth.plugin.digest));
  await act(() => vi.advanceTimersByTimeAsync(7000));
  expect(await screen.findByText("v1.33.4")).toBeTruthy();
});

const entry = (text: string) => screen.getByText(text).closest("[title]");

test("while connected only the version shows", async () => {
  await openList();
  expect(entry("v1.33.4")?.getAttribute("title")).toBe(
    "Connected · Kubernetes v1.33.4",
  );
  expect(screen.queryByText("Connected")).toBeNull();
});

test.each([
  ["queued", "Waiting for a stream slot", "Waiting"],
  ["connecting", "Connecting…", "Connecting"],
  ["syncing", "Loading · 1,850", "Syncing"],
  ["stale", "No updates · reconnecting", "Reconnecting"],
  ["relisting", "v1.33.4", "Connected"],
  ["forbidden", "Forbidden", "Forbidden"],
  ["unauthorized", "Unauthorized", "Unauthorized"],
  ["error", "Unreachable", "Unreachable"],
] as const)(
  "a %s list's cluster entry reads %s",
  async (scenario, text, connection) => {
    await openList(createMockBackend(scenario));
    expect(entry(text)?.getAttribute("title")).toBe(
      `${connection} · Kubernetes v1.33.4`,
    );
  },
);

test("the status bar counts the active list's rows", async () => {
  await openList();
  expect(screen.getByText("5,000 pods")).toBeTruthy();
});

const statusOf = (row: HTMLElement) =>
  row.querySelector('[data-column="Status"]')?.textContent ?? "";
const pressed = () =>
  screen
    .getAllByRole("button", { pressed: true })
    .map((button) => button.textContent);

test.each([
  ["failing", "error", "Failing"],
  ["pending", "warn", "Pending"],
] as const)(
  "the %s count is an entry whose click shows only those rows",
  async (name, tone, title) => {
    await openList();
    const count = screen.getByRole("button", {
      name: new RegExp(`^[\\d,]+ ${name}$`),
    });
    fireEvent.click(count);
    await settle();
    expect(pressed()).toEqual([expect.stringMatching(`^${title}`)]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.filter((row) => cellTone(PODS, "Status", statusOf(row)) !== tone),
    ).toEqual([]);
    expect(
      screen.getByText(
        new RegExp(`^${count.textContent.split(" ")[0] ?? ""} pods$`),
      ),
    ).toBeTruthy();
  },
);
