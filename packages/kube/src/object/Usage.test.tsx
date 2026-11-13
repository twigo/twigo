import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Backend,
  Measure,
  Overview as Document,
  RequestOf,
  Usage,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { Cluster } from "../../../protocol/src/mock/cluster";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";
import { Overview } from "./Overview";
import { OverviewStates } from "./overviewStates";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MI = 1024 * 1024;

function measure(rest: Partial<Measure>): Measure {
  return { used: null, request: null, limit: null, allocatable: null, ...rest };
}

const NOTHING = measure({});

const POD: Usage = {
  state: "ready",
  sampled: "2026-11-13T10:00:00Z",
  cpu: measure({ used: 120_000_000, request: 100_000_000 }),
  memory: measure({ used: 90 * MI, request: 64 * MI, limit: 128 * MI }),
  containers: [
    {
      name: "api",
      cpu: measure({
        used: 100_000_000,
        request: 100_000_000,
        limit: 400_000_000,
      }),
      memory: measure({ used: 60 * MI, request: 64 * MI, limit: 128 * MI }),
    },
    {
      name: "proxy",
      cpu: measure({ used: 20_000_000, request: 16_000_000 }),
      memory: measure({ used: 30 * MI, limit: 32 * MI }),
    },
  ],
};

const NODE: Usage = {
  state: "ready",
  sampled: "2026-11-13T10:00:00Z",
  cpu: measure({ used: 7_421_000_000, allocatable: 16_000_000_000 }),
  memory: measure({ used: 15_000 * MI, allocatable: 16_000 * MI }),
  containers: [],
};

const TITLES: Readonly<Record<string, string>> = {
  "core.diagnostics": "Diagnostics",
  "core.pod": "Pod",
  "core.node": "Node",
  "core.metadata": "Metadata",
};

const SECTION = (id: string): Document["sections"][number] => ({
  id,
  title: TITLES[id] ?? id,
  blocks: [],
});

function shown(usage: Usage | undefined, kind = "/pods", first = "core.pod") {
  const states = new OverviewStates();
  render(
    <Overview
      overview={{ sections: [SECTION(first), SECTION("core.metadata")] }}
      space="prod-eu"
      states={states}
      kind={kind}
      onOpen={() => undefined}
      usage={usage}
    />,
  );
  return states;
}

const usageSection = () => screen.getByRole("region", { name: "Usage" });
test("a pod's usage is a section of its own with its total and each container against request and limit", () => {
  shown(POD);
  const section = usageSection();
  expect(within(section).getByText("Pod")).toBeTruthy();
  expect(within(section).getByText("api")).toBeTruthy();
  expect(within(section).getByText("proxy")).toBeTruthy();
  const total = within(section).getAllByRole("meter");
  expect(total.map((meter) => meter.getAttribute("aria-label"))).toEqual([
    "CPU of Pod",
    "Memory of Pod",
    "CPU of api",
    "Memory of api",
    "CPU of proxy",
    "Memory of proxy",
  ]);
  expect(section.textContent).toContain("120m · no limit · request 100m");
  expect(section.textContent).toContain("90Mi · limit 128Mi · request 64Mi");
  expect(section.textContent).toContain("100m · limit 400m · request 100m");
  expect(section.textContent).toContain("20m · no limit · request 16m");
  expect(
    screen
      .queryByRole("meter", { name: "CPU of proxy" })
      ?.getAttribute("aria-valuemax"),
  ).toBe("25000000");
});

test("a node's usage is held against what it can allocate, with kubectl's percent", () => {
  shown(NODE, "/nodes", "core.node");
  const section = usageSection();
  expect(within(section).queryByText("Pod")).toBeNull();
  expect(section.textContent).toContain("7421m of 16000m");
  expect(section.textContent).toContain("46%");
  expect(section.textContent).toContain("15000Mi of 16000Mi");
  expect(section.textContent).toContain("93%");
});

test("what nears its limit or passes it is a warning or an error in its meter and its words", () => {
  shown({
    ...POD,
    containers: [
      {
        name: "near",
        cpu: measure({ used: 10_000_000, limit: 100_000_000 }),
        memory: measure({ used: 92 * MI, limit: 100 * MI }),
      },
      {
        name: "over",
        cpu: measure({ used: 130_000_000, limit: 100_000_000 }),
        memory: measure({ used: 10 * MI, limit: 100 * MI }),
      },
    ],
  });
  const fill = (name: string) =>
    screen.getByRole("meter", { name }).querySelector("span > span")?.className;
  expect(fill("Memory of near")).toContain("bg-warn");
  expect(fill("CPU of over")).toContain("bg-error");
  expect(fill("CPU of near")).not.toMatch(/bg-(warn|error)/);
  expect(usageSection().textContent).toContain("92%");
  expect(usageSection().textContent).toContain("130%");
});

test("a pod without a sample says no data yet, never zero", () => {
  shown({
    ...POD,
    sampled: null,
    cpu: NOTHING,
    memory: NOTHING,
    containers: [],
  });
  const section = usageSection();
  expect(within(section).getAllByText("No data yet")).toHaveLength(2);
  expect(within(section).queryAllByRole("meter")).toHaveLength(0);
  expect(section.textContent).not.toMatch(/\b0(m|Mi)\b/);
});

test.each([
  ["unavailable", /metrics-server does not answer/],
  ["forbidden", /may not read metrics/],
] as const)(
  "a Metrics API that is %s says so in place and draws no figure",
  (state, words) => {
    shown({
      ...POD,
      state,
      sampled: null,
      cpu: NOTHING,
      memory: NOTHING,
      containers: [],
    });
    const section = usageSection();
    expect(section.textContent).toMatch(words);
    expect(within(section).queryAllByRole("meter")).toHaveLength(0);
    expect(within(section).queryByText("No data yet")).toBeNull();
  },
);

test("the section follows the Diagnostics, else comes first, and without a usage there is none", () => {
  const order = () =>
    screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
  shown(POD, "/pods", "core.diagnostics");
  expect(order()).toEqual(["Diagnostics", "Usage", "Metadata"]);
  cleanup();
  shown(POD);
  expect(order()).toEqual(["Usage", "Pod", "Metadata"]);
  cleanup();
  shown(undefined);
  expect(order()).toEqual(["Pod", "Metadata"]);
});

test("the section folds, and the kind remembers it", () => {
  const states = shown(POD);
  expect(states.open("/pods", "core.usage", true)).toBe(true);
  fireEvent.click(
    within(usageSection()).getByRole("button", { name: /Usage/ }),
  );
  expect(states.open("/pods", "core.usage", true)).toBe(false);
  expect(within(usageSection()).queryAllByRole("meter")).toHaveLength(0);
});

describe("an open object", () => {
  withScreenSize(1000);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function spied(backend: Backend) {
    const subscribe = vi.spyOn(backend, "subscribe");
    const invoke = vi.spyOn(backend, "invoke");
    return () => {
      const opened = subscribe.mock.calls.filter(
        ([command]) => command === "object_open",
      );
      const parts = invoke.mock.calls.filter(
        ([command]) => command === "object_set_parts",
      );
      const last =
        parts.length > 0
          ? (parts[parts.length - 1]?.[1] as RequestOf<"object_set_parts">)
              .parts
          : (opened[opened.length - 1]?.[1] as RequestOf<"object_open">).parts;
      return last.usage;
    };
  }

  const running = () => {
    const pod = new Cluster("prod-eu", 5000, Date.now()).pods.find(
      (candidate) =>
        candidate.status === "Running" &&
        candidate.containers === 2 &&
        Date.now() - candidate.created > 120_000,
    );
    if (!pod) throw new Error("no such pod in the mock");
    return `k8s://prod-eu//v1/pods/${pod.namespace}/${pod.name}`;
  };

  test("an open pod's Overview shows its usage while the document is visible, and the part follows the tab", async () => {
    const backend = createMockBackend("ready");
    const usage = spied(backend);
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open(running());
    });
    await settle();
    expect(usage()).toBe(true);
    expect(within(usageSection()).getAllByRole("meter")).toHaveLength(6);

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(1);
    expect(usage()).toBe(false);
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(1);
    expect(usage()).toBe(true);

    fireEvent.click(screen.getByText("YAML"));
    await settle();
    expect(usage()).toBe(false);
  });

  test("an open pod behind another tab asks for no usage, and asks again once shown", async () => {
    const backend = createMockBackend("ready");
    const usage = spied(backend);
    const workbench = await mountKube(backend);
    const pod = running();
    act(() => {
      workbench.editors.open(pod);
    });
    await settle();
    expect(usage()).toBe(true);
    act(() => {
      workbench.editors.open("k8s-list://prod-eu/apps/v1/deployments");
    });
    await settle();
    expect(usage()).toBe(false);
    act(() => {
      workbench.editors.activate(pod);
    });
    await settle();
    expect(usage()).toBe(true);
  });

  test("the details beside a list show a pod's usage in their Overview", async () => {
    const backend = createMockBackend("ready");
    await openList(backend);
    fireEvent.click(screen.getAllByRole("row")[1] ?? document.body);
    await settle();
    const aside = screen.getByRole("complementary", { name: "Pod details" });
    expect(within(aside).getByRole("region", { name: "Usage" })).toBeTruthy();
  });

  test("an object that has no usage never asks for one", async () => {
    const backend = createMockBackend("ready");
    const usage = spied(backend);
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open("k8s://prod-eu//v1/configmaps/auth/settings");
    });
    await settle();
    expect(usage()).toBe(false);
  });

  test("a context without the Metrics API shows no section", async () => {
    const backend = createMockBackend("metricsNone");
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open(running());
    });
    await settle(30);
    expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
    expect(screen.getByRole("region", { name: "Containers" })).toBeTruthy();
  });
});
