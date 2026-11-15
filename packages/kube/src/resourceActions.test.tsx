import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AccessQuery } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { notify } from "@twigo/ui";
import type { Lookup } from "@twigo/workbench";
import { tabsIn } from "@twigo/workbench/testing";
import { mountKube, openList, settle, withScreenSize } from "../test/workbench";
import { canShell } from "./exec/kinds";
import { canForward } from "./forward/kinds";
import { logsKind } from "./logs/entries";

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

test("s on a pod's row opens its shell through k8s.shell.open, and means nothing on a deployment's", async () => {
  const pods = await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/v1/pods",
  );
  const execute = vi.spyOn(pods.commands, "execute");
  const grid = screen.getAllByRole("grid")[0];
  if (!grid) throw new Error("a list of pods");
  act(() => {
    grid.focus();
  });
  fireEvent.keyDown(grid, { code: "KeyJ", key: "j" });
  await settle(2);
  fireEvent.keyDown(grid, { code: "KeyS", key: "s" });
  await settle(4);
  expect(execute).toHaveBeenCalledWith(
    "k8s.shell.open",
    expect.anything(),
    expect.objectContaining({
      space: "prod-eu",
      gvr: { group: "", version: "v1", resource: "pods" },
      kind: "shell",
    }),
  );
  cleanup();

  const deployments = await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/apps/v1/deployments",
  );
  const other = vi.spyOn(deployments.commands, "execute");
  const list = screen.getAllByRole("grid")[0];
  if (!list) throw new Error("a list of deployments");
  act(() => {
    list.focus();
  });
  fireEvent.keyDown(list, { code: "KeyJ", key: "j" });
  await settle(2);
  fireEvent.keyDown(list, { code: "KeyS", key: "s" });
  await settle(4);
  expect(
    other.mock.calls.filter(([command]) => command.startsWith("k8s.shell.")),
  ).toEqual([]);
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
    expect.objectContaining({ icon: expect.anything() as unknown }),
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toMatch(
    /^Staging.*staging.*Delete pod .+ from staging\?/,
  );
  expect(screen.getByLabelText("Type staging to confirm")).toBeTruthy();
});

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
    expect.objectContaining({ icon: expect.anything() as unknown }),
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
  expect(workbench.keys.lookup(main)("listMarked")).toBe(false);

  run.mockResolvedValueOnce({ state: "cancelled" });
  fireEvent.keyDown(main, { code: "KeyX", key: "x" });
  await settle(2);
  fireEvent.keyDown(main, {
    code: "Backspace",
    key: "Backspace",
    metaKey: true,
  });
  await settle(2);
  expect(workbench.keys.lookup(main)("listMarked")).toBe(true);

  run.mockResolvedValueOnce({ state: "failed" });
  fireEvent.keyDown(main, {
    code: "Backspace",
    key: "Backspace",
    metaKey: true,
  });
  await settle(2);
  expect(workbench.keys.lookup(main)("listMarked")).toBe(true);

  run.mockResolvedValueOnce({ state: "stopped" });
  fireEvent.keyDown(main, {
    code: "Backspace",
    key: "Backspace",
    metaKey: true,
  });
  await settle(2);
  expect(workbench.keys.lookup(main)("listMarked")).toBe(false);
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

test("a Job that ended offers neither Suspend nor Resume", async () => {
  const workbench = await openInStaging(
    "ready",
    "k8s-list://staging/batch/v1/jobs",
  );
  const job = (state: Record<string, boolean>) => (key: string) =>
    ({
      "resource.group": "batch",
      "resource.kind": "Job",
      "resource.capability.patch": true,
      "resource.selected": true,
      ...state,
    })[key];
  const enabled = (state: Record<string, boolean>) => [
    workbench.commands.enabled("k8s.resource.suspend", job(state)),
    workbench.commands.enabled("k8s.resource.resume", job(state)),
  ];
  expect(enabled({ "resource.suspended": false })).toEqual([true, false]);
  expect(enabled({ "resource.suspended": true })).toEqual([false, true]);
  expect(
    enabled({ "resource.suspended": false, "resource.ended": true }),
  ).toEqual([false, false]);
  expect(
    enabled({ "resource.suspended": true, "resource.ended": true }),
  ).toEqual([false, false]);
});

test("the delete of marked rows asks for those rows, not the selected one", async () => {
  const workbench = await openInStaging("ready", "k8s-list://staging/v1/pods");
  const original = workbench.backend.invoke.bind(workbench.backend);
  const asked: AccessQuery[] = [];
  let refused: string | null = null;
  vi.spyOn(workbench.backend, "invoke").mockImplementation(
    (command: string, request: unknown) => {
      if (command !== "access_review")
        return original(command as never, request as never);
      const query = request as AccessQuery;
      asked.push(query);
      return Promise.resolve(
        query.checks.map(
          (check) => !(check.verb === "delete" && check.name === refused),
        ),
      );
    },
  );
  const main = await selectFirst();
  const first = asked
    .flatMap((query) => query.checks)
    .find((check) => check.verb === "delete" && check.name !== null)?.name;
  expect(first).toEqual(expect.any(String));
  refused = first ?? null;
  fireEvent.keyDown(main, { code: "KeyX", key: "x" });
  fireEvent.keyDown(main, { code: "ArrowDown", key: "ArrowDown" });
  await settle(4);
  const lookup = workbench.keys.lookup(main);
  expect(workbench.commands.enabled("k8s.resource.deleteMarked", lookup)).toBe(
    false,
  );
  expect(workbench.commands.enabled("k8s.resource.delete", lookup)).toBe(true);
});

test("a row moved onto from one whose delete was refused may be deleted while its own review is out", async () => {
  const workbench = await openInStaging("ready", "k8s-list://staging/v1/pods");
  const original = workbench.backend.invoke.bind(workbench.backend);
  let refused: string | null = null;
  let held = false;
  vi.spyOn(workbench.backend, "invoke").mockImplementation(
    (command: string, request: unknown) => {
      if (command !== "access_review") {
        return original(command as never, request as never);
      }
      const query = request as AccessQuery;
      if (held) return new Promise(() => undefined);
      return Promise.resolve(
        query.checks.map((check) => {
          if (check.verb === "delete" && check.name !== null)
            refused ??= check.name;
          return !(check.verb === "delete" && check.name === refused);
        }),
      );
    },
  );
  const main = await selectFirst();
  await settle(4);
  const lookup = () => workbench.keys.lookup(main);
  expect(workbench.commands.enabled("k8s.resource.delete", lookup())).toBe(
    false,
  );
  held = true;
  fireEvent.keyDown(main, { code: "ArrowDown", key: "ArrowDown" });
  await settle(4);
  expect(workbench.commands.enabled("k8s.resource.delete", lookup())).toBe(
    true,
  );
});

test("marked rows marked again after their marks were cleared are asked about again", async () => {
  const workbench = await openInStaging("ready", "k8s-list://staging/v1/pods");
  const invoke = vi.spyOn(workbench.backend, "invoke");
  const main = await selectFirst();
  const marked = () =>
    invoke.mock.calls.filter(
      ([command, request]) =>
        command === "access_review" &&
        (request as AccessQuery).checks.length === 1 &&
        (request as AccessQuery).checks[0]?.verb === "delete",
    ).length;
  fireEvent.keyDown(main, { code: "KeyX", key: "x" });
  await settle(4);
  const once = marked();
  expect(once).toBeGreaterThan(0);
  fireEvent.keyDown(main, { code: "Escape", key: "Escape" });
  await settle(4);
  fireEvent.keyDown(main, { code: "KeyX", key: "x" });
  await settle(4);
  expect(marked()).toBeGreaterThan(once);
});

function rowOf(
  resource: string,
  kind: string,
  state: Record<string, boolean> = {},
): Lookup {
  const [group = "", plural = resource] = resource.includes("/")
    ? resource.split("/")
    : ["", resource];
  const gvr = { group, version: "v1", resource: plural };
  const values: Record<string, string | boolean> = {
    "resource.selected": true,
    "resource.group": group,
    "resource.kind": kind,
    "resource.logs": logsKind(gvr) !== undefined,
    "resource.shell": canShell(gvr),
    "resource.forward": canForward(gvr),
    "resource.scalable": [
      "deployments",
      "statefulsets",
      "replicasets",
    ].includes(plural),
    ...state,
  };
  return (key) =>
    key in values
      ? values[key]
      : key.startsWith("resource.capability.") || key.startsWith("capability.");
}

test("each kind pins its verbs in their order, and the rest go into More with Delete last in its own group, in the error tone", async () => {
  const workbench = await mountKube();
  const pins = (row: Lookup) =>
    workbench
      .actions("resource/details", row)
      .flat()
      .filter((action) => action.pinned)
      .map((action) => action.label);
  const kinds: [Lookup, string[]][] = [
    [rowOf("pods", "Pod"), ["Logs", "Shell", "Forward"]],
    [rowOf("apps/deployments", "Deployment"), ["Logs", "Restart", "Scale…"]],
    [rowOf("apps/statefulsets", "StatefulSet"), ["Logs", "Restart", "Scale…"]],
    [rowOf("apps/daemonsets", "DaemonSet"), ["Logs", "Restart"]],
    [rowOf("batch/cronjobs", "CronJob"), ["Trigger", "Suspend"]],
    [
      rowOf("batch/cronjobs", "CronJob", { "resource.suspended": true }),
      ["Trigger", "Resume"],
    ],
    [rowOf("nodes", "Node"), ["Cordon", "Drain"]],
    [
      rowOf("nodes", "Node", { "resource.cordoned": true }),
      ["Uncordon", "Drain"],
    ],
    [rowOf("services", "Service"), ["Forward"]],
    [rowOf("apps/replicasets", "ReplicaSet"), ["Forward"]],
    [rowOf("batch/jobs", "Job"), []],
    [rowOf("configmaps", "ConfigMap"), []],
  ];
  for (const [row, pinned] of kinds) {
    expect(pins(row)).toEqual(pinned);
    const groups = workbench.actions("resource/details", row);
    const last = groups[groups.length - 1];
    expect(last?.map(({ label, danger }) => ({ label, danger }))).toEqual([
      { label: "Delete", danger: true },
    ]);
    expect(
      groups
        .flat()
        .filter(({ id }) =>
          ["k8s.resource.yaml", "k8s.resource.openEditor"].includes(id),
        ),
    ).toEqual([]);
  }
});

test("a pinned write RBAC refuses stays in its place, disabled, saying why, and the context menu leaves it out", async () => {
  const workbench = await mountKube();
  const refused = rowOf("apps/deployments", "Deployment", {
    "resource.capability.patch": false,
    "resource.capability.patch/scale": false,
    "resource.capability.delete": false,
  });
  const shown = workbench
    .actions("resource/details", refused)
    .flat()
    .map(({ label, pinned, disabled, reason }) => ({
      label,
      pinned: pinned === true,
      disabled,
      reason,
    }));
  expect(shown.filter(({ pinned }) => pinned)).toEqual([
    { label: "Logs", pinned: true, disabled: false, reason: undefined },
    {
      label: "Restart",
      pinned: true,
      disabled: true,
      reason: "You may not restart it",
    },
    {
      label: "Scale…",
      pinned: true,
      disabled: true,
      reason: "You may not scale it",
    },
  ]);
  expect(shown[shown.length - 1]).toEqual({
    label: "Delete",
    pinned: false,
    disabled: true,
    reason: "You may not delete it",
  });
  expect(
    workbench
      .actions("resource/context", refused)
      .flat()
      .map(({ label }) => label)
      .filter((label) => ["Restart", "Scale…", "Delete"].includes(label)),
  ).toEqual([]);
});

test("a write the context's mode holds, clicked in the details' row, reaches the gate, whose refusal offers the unlock, and runs no further", async () => {
  const error = vi.spyOn(notify, "error");
  const workbench = await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/apps/v1/deployments",
  );
  const invoke = vi.spyOn(workbench.backend, "invoke");
  const subscribe = vi.spyOn(workbench.backend, "subscribe");
  const row = screen.getAllByRole("row")[1];
  fireEvent.click(row ?? document.body);
  await settle(4);
  const restart = within(
    screen.getByRole("toolbar", { name: "Deployment actions" }),
  ).getByRole("button", { name: "Restart" });
  expect(restart.getAttribute("aria-disabled")).toBeNull();
  act(() => {
    restart.focus();
  });
  expect(screen.getByRole("tooltip").textContent).toContain(
    "prod-eu is read-only",
  );
  fireEvent.click(restart);
  await settle(4);
  expect(invoke).toHaveBeenCalledWith(
    "command_plan",
    expect.objectContaining({ action: "restart", space: "prod-eu" }),
  );
  expect(
    subscribe.mock.calls.filter(([command]) => command === "command_execute"),
  ).toEqual([]);
  const [message, options] =
    error.mock.calls[error.mock.calls.length - 1] ?? [];
  expect(message).toMatch(/^prod-eu is read-only/);
  expect(options?.action?.label).toBe("Unlock for 15 minutes");
});

const hoverIcons = (row: HTMLElement) =>
  within(row)
    .queryAllByRole("button")
    .filter(
      (button) =>
        !["Row actions", "Mark row"].includes(
          button.getAttribute("aria-label") ?? "",
        ),
    );

function twoOfANamespace(): [HTMLElement, HTMLElement] {
  const rows = screen.getAllByRole("row").slice(1);
  const namespaceOf = (row: HTMLElement) =>
    row.querySelector('[data-column="Namespace"]')?.textContent;
  for (const row of rows) {
    const other = rows.find(
      (candidate) =>
        candidate !== row && namespaceOf(candidate) === namespaceOf(row),
    );
    if (other) return [row, other];
  }
  throw new Error("no two rows of one namespace");
}

test("a hovered row asks RBAC for itself: its refused verb draws enabled until the answer, then disabled with the reason, does not run, and a row of its namespace draws disabled at once", async () => {
  const workbench = await openInStaging(
    "ready",
    "k8s-list://staging/apps/v1/deployments",
  );
  const original = workbench.backend.invoke.bind(workbench.backend);
  const held: (() => void)[] = [];
  const asked: AccessQuery[] = [];
  const invoke = vi
    .spyOn(workbench.backend, "invoke")
    .mockImplementation((command: string, request: unknown) => {
      if (command !== "access_review")
        return original(command as never, request as never);
      const query = request as AccessQuery;
      asked.push(query);
      return new Promise((resolve) => {
        held.push(() => {
          resolve(query.checks.map((check) => check.verb !== "patch"));
        });
      });
    });
  const [first, second] = twoOfANamespace();
  const nameOf = (row: HTMLElement) =>
    row.querySelector('[data-column="Name"]')?.textContent;
  const restart = (row: HTMLElement) =>
    within(row).getByRole("button", { name: "Restart" });

  fireEvent.pointerEnter(first);
  await settle(2);
  expect(
    hoverIcons(first).map((icon) => icon.getAttribute("aria-label")),
  ).toEqual(["Logs", "Restart"]);
  expect(restart(first).getAttribute("aria-disabled")).toBeNull();
  expect(asked[asked.length - 1]?.checks).toContainEqual(
    expect.objectContaining({ verb: "patch", name: nameOf(first) }),
  );
  for (const answer of held.splice(0)) answer();
  await settle(1);
  expect(restart(first).getAttribute("aria-disabled")).toBe("true");
  act(() => {
    restart(first).focus();
  });
  expect(screen.getByRole("tooltip").textContent).toContain(
    "You may not restart it",
  );
  fireEvent.click(restart(first));
  await settle(4);
  expect(
    invoke.mock.calls.filter(([command]) => command === "command_plan"),
  ).toEqual([]);

  fireEvent.pointerLeave(first);
  fireEvent.pointerEnter(second);
  await settle(2);
  expect(held).toHaveLength(1);
  expect(restart(second).getAttribute("aria-disabled")).toBe("true");
});
