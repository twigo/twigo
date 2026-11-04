import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { tabsIn } from "@twigo/workbench/testing";
import { openList, settle, withScreenSize } from "../test/workbench";

withScreenSize(1400);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("l on a row opens its logs through k8s.logs.open", async () => {
  const workbench = await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/apps/v1/deployments",
  );
  const execute = vi.spyOn(workbench.commands, "execute");
  const main = screen.getAllByRole("grid")[0];
  if (!main) throw new Error("a list of deployments");
  act(() => {
    main.focus();
  });
  fireEvent.keyDown(main, { code: "KeyJ", key: "j" });
  await settle(2);
  fireEvent.keyDown(main, { code: "KeyL", key: "l" });
  await settle(4);
  expect(execute).toHaveBeenCalledWith(
    "k8s.logs.open",
    expect.anything(),
    expect.objectContaining({
      space: "prod-eu",
      gvr: { group: "apps", version: "v1", resource: "deployments" },
    }),
  );
  expect(tabsIn("panel")).toEqual([
    expect.stringMatching(/^logs:\/\/prod-eu\/apps\/v1\/deployments\//),
  ]);
});
