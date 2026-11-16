import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mountKube } from "../test/workbench";
import { PODS } from "./kinds";
import {
  diffUri,
  execUri,
  listUri,
  logsUri,
  objectUri,
  pfUri,
  terminalUri,
  untitledUri,
} from "./uri";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("a tab's title is cut in the middle where its end is a name or a port, and at its end where it is a kind or a number", async () => {
  const workbench = await mountKube();
  const space = "prod-eu";
  const pod = { space, gvr: PODS, namespace: "payments", name: "auth-api-1" };
  const endTells = (uri: string) =>
    workbench.editors.resolve(uri)?.titleEndTells ?? false;

  expect(endTells(objectUri(pod))).toBe(true);
  expect(endTells(logsUri(pod))).toBe(true);
  expect(
    endTells(
      execUri({
        space,
        namespace: "payments",
        pod: "auth-api-1",
        container: "app",
      }),
    ),
  ).toBe(true);
  expect(endTells(pfUri({ space, id: 1 }))).toBe(true);
  expect(endTells(diffUri({ kind: "server", editor: objectUri(pod) }))).toBe(
    true,
  );

  expect(endTells(listUri({ space, gvr: PODS }))).toBe(false);
  expect(endTells(terminalUri({ space, n: 1 }))).toBe(false);
  expect(endTells(untitledUri({ space, n: 1 }))).toBe(false);
});
