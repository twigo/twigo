import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { tabsIn } from "@twigo/workbench/testing";
import { mountKube, openList, settle, withScreenSize } from "../test/workbench";

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

test("⌘⌫ on a row asks the bus to delete it, and its dialog names the cluster", async () => {
  const workbench = await mountKube();
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(2);
  act(() => {
    workbench.editors.open("k8s-list://staging/v1/pods");
  });
  await settle();
  const run = vi.spyOn(workbench.operations, "run");
  const main = screen.getAllByRole("grid")[0];
  if (!main) throw new Error("a list of pods");
  act(() => {
    main.focus();
  });
  fireEvent.keyDown(main, { code: "KeyJ", key: "j" });
  await settle(2);
  fireEvent.keyDown(main, { code: "Backspace", key: "Backspace" });
  await settle(2);
  expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(main, {
    code: "Backspace",
    key: "Backspace",
    metaKey: true,
  });
  await settle(4);
  expect(run).toHaveBeenCalledWith(
    {
      action: "delete",
      space: "staging",
      targets: [
        expect.objectContaining({
          gvr: { group: "", version: "v1", resource: "pods" },
          namespaced: true,
        }) as unknown,
      ],
    },
    expect.objectContaining({ destructive: true }),
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toMatch(
    /^Staging.*staging.*Delete pod .+ from staging\?/,
  );
  expect(screen.getByLabelText("Type staging to confirm")).toBeTruthy();
});

/** The workbench with a list of staging open. */
async function openInStaging(scenario: "ready" | "viewer", uri: string) {
  const workbench = await mountKube(createMockBackend(scenario));
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(2);
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(30);
  return workbench;
}

/** The first grid with its first row selected and the focus. */
async function selectFirst(): Promise<HTMLElement> {
  const main = screen.getAllByRole("grid")[0];
  if (!main) throw new Error("a list");
  act(() => {
    main.focus();
  });
  fireEvent.keyDown(main, { code: "KeyJ", key: "j" });
  await settle(4);
  return main;
}

test("a person RBAC lets only read sees the writes disabled", async () => {
  for (const [scenario, allowed] of [
    ["viewer", false],
    ["ready", true],
  ] as const) {
    const workbench = await openInStaging(
      scenario,
      "k8s-list://staging/apps/v1/deployments",
    );
    const main = await selectFirst();
    const lookup = workbench.keys.lookup(main);
    for (const command of [
      "k8s.resource.delete",
      "k8s.resource.scale",
      "k8s.resource.restart",
    ]) {
      expect(workbench.commands.enabled(command, lookup), command).toBe(
        allowed,
      );
    }
    expect(workbench.commands.enabled("k8s.resource.yaml", lookup)).toBe(true);
    cleanup();
  }
});

test("⇧S asks for the replicas in quick access and scales to what is typed", async () => {
  const workbench = await openInStaging(
    "ready",
    "k8s-list://staging/apps/v1/deployments",
  );
  const run = vi
    .spyOn(workbench.operations, "run")
    .mockResolvedValue({ state: "done" });
  const main = await selectFirst();
  fireEvent.keyDown(main, { code: "KeyS", key: "S", shiftKey: true });
  await settle(2);
  const ask = workbench.quickAccess.session?.ask;
  expect(ask?.prompt).toMatch(/^Scale deployment \S+, now at \d+$/);
  expect(ask?.validate("-1")).toBe("Type a count of replicas: 0 or more");
  act(() => {
    workbench.quickAccess.setValue("7");
    workbench.quickAccess.submit();
  });
  await settle(2);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ action: "scale", space: "staging", replicas: 7 }),
    expect.objectContaining({ destructive: false }),
  );
});

test("⌘⌫ with marked rows deletes those rows", async () => {
  const workbench = await openInStaging("ready", "k8s-list://staging/v1/pods");
  const run = vi
    .spyOn(workbench.operations, "run")
    .mockResolvedValue({ state: "done" });
  const main = await selectFirst();
  fireEvent.keyDown(main, { code: "KeyX", key: "x" });
  fireEvent.keyDown(main, { code: "ArrowDown", key: "ArrowDown" });
  fireEvent.keyDown(main, { code: "KeyX", key: "x" });
  await settle(2);
  fireEvent.keyDown(main, {
    code: "Backspace",
    key: "Backspace",
    metaKey: true,
  });
  await settle(2);
  expect(run).toHaveBeenCalledOnce();
  const [request] = run.mock.calls[0] ?? [];
  expect(request).toMatchObject({ action: "delete", space: "staging" });
  expect(request?.action === "delete" && request.targets).toHaveLength(2);
});

test("a list asks for its capability keys again when the catalog lists the contexts anew", async () => {
  const workbench = await openInStaging(
    "ready",
    "k8s-list://staging/apps/v1/deployments",
  );
  const invoke = vi.spyOn(workbench.backend, "invoke");
  await selectFirst();
  const reviews = () =>
    invoke.mock.calls.filter(([command]) => command === "access_review").length;
  const before = reviews();
  const marked = workbench.backend.invoke("context_environment_set", {
    context: "staging",
    environment: "development",
  });
  await settle(4);
  await marked;
  await settle(4);
  expect(reviews()).toBeGreaterThan(before);
});
