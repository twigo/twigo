import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { openList, settle, withScreenSize } from "../../test/workbench";
import { partsLine } from "./statusEntries";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("wait:inline, the default: a list that cannot connect says why in the status bar and over its skeleton", async () => {
  await openList(createMockBackend("connectRefused"));
  await act(() => vi.advanceTimersByTimeAsync(100));
  const bar = within(screen.getByRole("contentinfo")).getByText(
    "Connecting · connection refused",
  );
  const line = within(screen.getByRole("grid")).getByText(
    "Connecting · connection refused",
  );
  expect(bar.closest("[title]")?.getAttribute("title")).toBe(
    [
      "Connecting · Kubernetes v1.33.4",
      "The server refused the connection: Connection refused (os error 61)",
      "connect.refused",
    ].join("\n"),
  );
  expect(line.getAttribute("role")).toBe("status");
  expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(1);
});

test("wait:inline: a list that lost its connection keeps its rows and says why beside the word", async () => {
  await openList(createMockBackend("connectLost"));
  await settle(4);
  expect(
    screen.getByText("No updates · reconnecting · connection lost"),
  ).toBeTruthy();
  expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
});

test("wait:inline: a list that waits with no cause says only that it does", async () => {
  await openList(createMockBackend("connecting"));
  expect(
    within(screen.getByRole("contentinfo")).getByText("Connecting…"),
  ).toBeTruthy();
  expect(within(screen.getByRole("grid")).queryByRole("status")).toBeNull();
});

test("a part that cannot connect names its cause in the parts' tooltip, whichever variant", () => {
  const cause = {
    code: "connect.certificate",
    kind: "unavailable",
    message: "The server's certificate is not trusted",
  } as const;
  const line = partsLine({
    count: 2,
    unready: [
      {
        part: { kind: "namespace", name: "team-a" },
        state: { state: "connecting", cause },
        shown: false,
      },
    ],
    omitted: 0,
  });
  expect(line?.tooltip).toBe("team-a: connecting · certificate not trusted");

  const broken = partsLine({
    count: 2,
    unready: [
      {
        part: { kind: "namespace", name: "team-c" },
        state: {
          state: "stale",
          cause: { ...cause, code: "connect.lost", message: "lost" },
        },
        shown: false,
      },
    ],
    omitted: 0,
  });
  expect(broken?.tooltip).toBe("team-c: connecting · connection lost");
});
