import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { openList, withScreenSize } from "../../test/workbench";

withScreenSize();

beforeEach(() => {
  history.replaceState(null, "", "/?variant=status:code");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  vi.useRealTimers();
});

test("status:code says an error by its code, and the tooltip still has the message", async () => {
  await openList(createMockBackend("error"));
  const bar = within(screen.getByRole("contentinfo"));
  const entry = bar.getByText("server.invalid").closest("[title]");
  expect(entry?.getAttribute("title")).toContain(
    "field label not supported: spec.containers",
  );
});
