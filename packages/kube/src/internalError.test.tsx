import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, LogBatch, ViewState } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { mountKube, settle, withScreenSize } from "../test/workbench";
import { ViewStatus } from "./ViewStatus";
import { ending } from "./xterm/words";

vi.mock("./edit/YamlEditor", () => ({ default: () => <div /> }));

withScreenSize(1000);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const PANICKED = {
  code: "internal.panic",
  kind: "internal",
  message: "Twigo stopped this list on an internal error",
} as const;

const STOPPED: ViewState = { state: "error", error: PANICKED };

test("a list that Twigo's own code stopped says so in one wording, offers Reopen where it can open again, and Report… opens the report", async () => {
  const workbench = await testWorkbench();
  const reopen = vi.fn();
  render(<ViewStatus status={STOPPED} what="pods" onRetry={reopen} />, {
    wrapper: inWorkbench(workbench),
  });
  expect(screen.getByText("Twigo hit an internal error")).toBeTruthy();
  expect(screen.getByText("This view stopped.")).toBeTruthy();
  expect(screen.queryByText("Could not load pods")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  expect(reopen).toHaveBeenCalledOnce();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Report…" }));
    await Promise.resolve();
  });
  expect(workbench.problemReport.report).toBeDefined();
});

test("a view that failed for any other reason keeps its words, its Retry and no Report…", async () => {
  const workbench = await testWorkbench();
  render(
    <ViewStatus
      status={{
        state: "error",
        error: { ...PANICKED, code: "server.invalid", kind: "invalidInput" },
      }}
      what="pods"
      onRetry={() => undefined}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(screen.getByText("Could not load pods")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Report…" })).toBeNull();
});

test("an object page that Twigo stopped is opened again by Reopen, which subscribes anew", async () => {
  const mock = createMockBackend("listPanicked");
  let opened = 0;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "object_open") opened++;
      return mock.subscribe(command, request, onMessage);
    },
  };
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(
      "k8s://prod-eu/apps/v1/deployments/payments/payments-api",
    );
  });
  await settle(12);
  expect(screen.getByText("Twigo hit an internal error")).toBeTruthy();
  const before = opened;
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await settle(12);
  expect(opened).toBeGreaterThan(before);
  expect(screen.getByText("Twigo hit an internal error")).toBeTruthy();
});

test("a session that Twigo stopped ends in the scrollback with the one wording", () => {
  const { title } = ending({
    reason: "failed",
    error: {
      code: "internal.panic",
      kind: "internal",
      message: "Twigo stopped this shell on an internal error",
    },
  });
  expect(title).toBe("Twigo hit an internal error and this shell stopped.");
});

test("the logs of a container that Twigo stopped say so over the lines, with Report…", async () => {
  const mock = createMockBackend("ready");
  const stopped = (batch: LogBatch): LogBatch => ({
    ...batch,
    pods:
      batch.pods?.map((pod) => ({
        ...pod,
        containers: pod.containers.map((container) => ({
          ...container,
          stream: { state: "error" as const, error: PANICKED },
        })),
      })) ?? null,
  });
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (
      command: string,
      request: never,
      onMessage: (batch: LogBatch) => void,
    ) =>
      mock.subscribe(command as "logs_open", request, (batch) => {
        onMessage(command === "logs_open" ? stopped(batch) : batch);
      }),
  };
  const workbench = await mountKube(backend);
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("qa");
  });
  await act(() =>
    workbench.commands.execute("k8s.logs.open", workbench.keys.lookup(null), {
      space: "qa",
      gvr: { group: "", version: "v1", resource: "pods" },
      namespace: "auth",
      name: "auth-api-1p2si70-e9vxn",
    }),
  );
  await settle(12);
  expect(screen.getByText("Twigo hit an internal error:")).toBeTruthy();
  expect(document.body.textContent).toContain("stopped.");
  expect(screen.getByRole("button", { name: "Report…" })).toBeTruthy();
});
