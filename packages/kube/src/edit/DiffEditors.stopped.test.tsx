import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import {
  carriesCode,
  inWorkbench,
  testWorkbench,
} from "@twigo/workbench/testing";
import { ENDS_MS } from "../../../protocol/src/mock/edits";
import { Discovery } from "../discovery";
import { diffUri } from "../uri";
import { DiffEditor } from "./DiffEditors";
import { createEdits } from "./services";

vi.mock("./DiffView", () => ({
  default: () => <div data-testid="diff" />,
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const POD = "k8s://prod-eu//v1/pods/auth/auth-api-1a4uyl1-r2bkk";
const OTHER_POD = "k8s://prod-eu//v1/pods/auth/auth-api-1a4uyl1-x";

async function stopped(uri: string, scenario: MockScenario = "objectPanicked") {
  const mock = createMockBackend(scenario);
  let opened = 0;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "object_open") opened++;
      return mock.subscribe(command, request, onMessage);
    },
  };
  const workbench = await testWorkbench(scenario, backend);
  const edits = createEdits(workbench);
  edits.copies.edit(POD, "kind: Pod\n", {
    space: "prod-eu",
    base: JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "auth-api-1a4uyl1-r2bkk", resourceVersion: "1" },
    }),
    lock: "1",
  });
  render(
    <DiffEditor uri={uri} edits={edits} discovery={new Discovery(workbench)} />,
    { wrapper: inWorkbench(workbench) },
  );
  if (scenario === "objectPanicked") await screen.findByTestId("diff");
  return {
    workbench,
    opened: () => opened,
    end: () => act(() => vi.advanceTimersByTimeAsync(ENDS_MS + 100)),
  };
}

test("a diff against the server whose object Twigo stopped says so over what it still shows, with the code, Report… and Reopen", async () => {
  const { workbench, opened, end } = await stopped(
    diffUri({ kind: "server", editor: POD }),
  );
  expect(screen.queryByText("Twigo hit an internal error.")).toBeNull();

  await end();
  expect(screen.getByTestId("diff")).toBeTruthy();
  const banner = screen
    .getByText("Twigo hit an internal error.")
    .closest<HTMLElement>("[data-tone]");
  if (!banner) throw new Error("no banner");
  expect(banner.textContent).toContain("as it was last seen");
  expect(carriesCode(banner, "internal.panic")).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Report…" }));
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(workbench.problemReport.report).toBeDefined();
  const before = opened();
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(opened()).toBeGreaterThan(before);
});

test("a comparison of two objects says which of them Twigo stopped, and no longer says it follows them", async () => {
  const { end } = await stopped(
    diffUri({ kind: "objects", space: "prod-eu", left: POD, right: OTHER_POD }),
  );
  expect(screen.getByText(/Both as they are on the server/)).toBeTruthy();

  await end();
  expect(screen.getAllByText(/Twigo hit an internal error/)).toHaveLength(2);
  expect(screen.getByText(/auth\/auth-api-1a4uyl1-r2bkk: /)).toBeTruthy();
  expect(screen.queryByText(/followed while this is open/)).toBeNull();
  expect(screen.getAllByRole("button", { name: "Reopen" })).toHaveLength(2);
});

test("a diff of an object that was stopped before its manifest came says why instead, and offers Reopen and Report…", async () => {
  const { opened } = await stopped(
    diffUri({ kind: "server", editor: POD }),
    "listPanicked",
  );
  expect(await screen.findByText("Twigo hit an internal error")).toBeTruthy();
  expect(screen.queryByTestId("diff")).toBeNull();
  expect(screen.getByRole("button", { name: "Report…" })).toBeTruthy();
  const before = opened();
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(opened()).toBeGreaterThan(before);
});

test("a comparison of objects stopped before their manifests came offers one Reopen and one Report… for both", async () => {
  await stopped(
    diffUri({ kind: "objects", space: "prod-eu", left: POD, right: OTHER_POD }),
    "listPanicked",
  );
  expect(await screen.findByText("Nothing to compare")).toBeTruthy();
  expect(screen.getAllByText(/Twigo hit an internal error/)).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Reopen" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Report…" })).toHaveLength(1);
});
