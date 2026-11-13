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
  Container,
  Discovered,
  Measure,
  Overview as Document,
  RequestOf,
  ShownUsage,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { Cluster, type Pod } from "../../../protocol/src/mock/cluster";
import RESOURCES from "../../../protocol/src/mock/resources.json";
import { finishedInit } from "../../../protocol/src/mock/objects";
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

const POD: ShownUsage = {
  state: "ready",
  waiting: false,
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

const NODE: ShownUsage = {
  state: "ready",
  waiting: false,
  sampled: "2026-11-13T10:00:00Z",
  cpu: measure({ used: 7_421_000_000, allocatable: 16_000_000_000 }),
  memory: measure({ used: 15_000 * MI, allocatable: 16_000 * MI }),
  containers: [],
};

const WAITING_POD: ShownUsage = {
  state: "ready",
  waiting: true,
  sampled: null,
  cpu: NOTHING,
  memory: NOTHING,
  containers: [
    {
      name: "api",
      cpu: measure({ request: 100_000_000, limit: 400_000_000 }),
      memory: measure({ request: 64 * MI, limit: 128 * MI }),
    },
  ],
};

const WAITING_NODE: ShownUsage = {
  ...NODE,
  waiting: true,
  sampled: null,
  cpu: measure({ allocatable: 16_000_000_000 }),
  memory: measure({ allocatable: 16_000 * MI }),
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

const CONTAINER = (name: string): Container => ({
  name,
  role: "regular",
  image: "registry/app:1",
  state: null,
  ports: [],
  fields: [],
  details: [],
  env: [],
  mounts: [],
});

const LISTED: Document = {
  sections: [
    SECTION("core.pod"),
    {
      id: "core.containers",
      title: "Containers",
      blocks: [
        {
          type: "containers",
          containers: [
            { ...CONTAINER("init-config"), role: "init" },
            CONTAINER("api"),
            CONTAINER("proxy"),
          ],
        },
      ],
    },
    SECTION("core.metadata"),
  ],
};

function shown(
  usage: ShownUsage | undefined,
  kind = "/pods",
  first = "core.pod",
) {
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

function listed(
  usage: ShownUsage | undefined,
  kind = "/pods",
  overview: Document = LISTED,
) {
  const states = new OverviewStates();
  const view = (usage: ShownUsage | undefined) => (
    <Overview
      overview={overview}
      space="prod-eu"
      states={states}
      kind={kind}
      onOpen={() => undefined}
      usage={usage}
    />
  );
  const { rerender } = render(view(usage));
  return (next: ShownUsage | undefined) => {
    rerender(view(next));
  };
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

test("a meter says its figures in the printed units against what it is held to, and the tone in words", () => {
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
        memory: measure({ used: 10 * MI, request: 64 * MI }),
      },
    ],
  });
  const spoken = (name: string) =>
    screen.getByRole("meter", { name }).getAttribute("aria-valuetext");
  expect(spoken("CPU of near")).toBe("10m of 100m limit, 10%");
  expect(spoken("Memory of near")).toBe("92Mi of 100Mi limit, 92%, warning");
  expect(spoken("CPU of over")).toBe("130m of 100m limit, 130%, error");
  expect(spoken("Memory of over")).toBe("10Mi of 64Mi request, 15%");
  const section = usageSection();
  expect(within(section).getAllByRole("img", { name: "Warning" })).toHaveLength(
    1,
  );
  expect(within(section).getAllByRole("img", { name: "Error" })).toHaveLength(
    1,
  );
});

test("a node's meter says what it can allocate", () => {
  shown(NODE, "/nodes", "core.node");
  expect(
    screen
      .getByRole("meter", { name: "Memory" })
      .getAttribute("aria-valuetext"),
  ).toBe("15000Mi of 16000Mi allocatable, 93%, warning");
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

test("a usage that waits draws the rows it names, whatever the Overview lists, with empty meters that say loading and no figure, and the answer fills them", () => {
  const answer = listed(WAITING_POD, "/pods");
  const section = usageSection();
  const headings = () =>
    within(usageSection())
      .getAllByText(/^(Pod|api|proxy|init-config)$/)
      .map((heading) => heading.textContent);
  expect(headings()).toEqual(["Pod", "api"]);
  const empty = within(section).getAllByRole("progressbar");
  expect(empty.map((meter) => meter.getAttribute("aria-label"))).toEqual([
    "CPU of Pod",
    "Memory of Pod",
    "CPU of api",
    "Memory of api",
  ]);
  for (const meter of empty) {
    expect(meter.getAttribute("aria-valuetext")).toBe("Loading");
  }
  expect(within(section).queryAllByRole("meter")).toHaveLength(0);
  expect(section.textContent).not.toMatch(/\d|No data yet|%/);
  const labels = () =>
    within(usageSection()).getAllByText(/^(CPU|Memory)$/).length;
  expect(labels()).toBe(4);

  answer({ ...POD, containers: POD.containers.slice(0, 1) });
  expect(headings()).toEqual(["Pod", "api"]);
  expect(labels()).toBe(4);
  expect(within(usageSection()).getAllByRole("meter")).toHaveLength(4);
  expect(within(usageSection()).queryAllByRole("progressbar")).toHaveLength(0);
});

test("a node's usage that waits is its pair of empty meters", () => {
  listed(WAITING_NODE, "/nodes", {
    sections: [SECTION("core.node"), SECTION("core.metadata")],
  });
  const section = usageSection();
  expect(
    within(section)
      .getAllByRole("progressbar")
      .map((meter) => meter.getAttribute("aria-label")),
  ).toEqual(["CPU", "Memory"]);
  expect(within(section).queryByText("Pod")).toBeNull();
});

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

  const pod = (pick: (candidate: Pod) => boolean, outside?: string) => {
    const found = new Cluster("prod-eu", 5000, Date.now()).pods.find(
      (candidate) =>
        Date.now() - candidate.created > 120_000 &&
        candidate.namespace !== outside &&
        pick(candidate),
    );
    if (!found) throw new Error("no such pod in the mock");
    return `k8s://prod-eu//v1/pods/${found.namespace}/${found.name}`;
  };
  const running = (outside?: string) =>
    pod(
      (candidate) =>
        candidate.status === "Running" && candidate.containers === 2,
      outside,
    );
  const namespaceOf = (uri: string) => uri.split("/")[6];

  const drawn = () => {
    const section = screen.queryByRole("region", { name: "Usage" });
    if (!section) return "none";
    if (within(section).queryAllByRole("progressbar").length > 0)
      return "empty";
    if (within(section).queryAllByRole("meter").length > 0) return "figures";
    return "sentence";
  };

  const frame = () => ({
    overview: screen.queryByRole("region", { name: "Metadata" }) !== null,
    state: drawn(),
    rows: [
      ...document.querySelectorAll('[role="progressbar"], [role="meter"]'),
    ].map((meter) => meter.getAttribute("aria-label")),
  });

  async function frames(ms = 1500, step = 5) {
    const seen = [frame()];
    for (let at = 0; at < ms; at += step) {
      await act(() => vi.advanceTimersByTimeAsync(step));
      const now = frame();
      const last = seen[seen.length - 1];
      if (
        last?.state !== now.state ||
        last.overview !== now.overview ||
        last.rows.join() !== now.rows.join()
      ) {
        seen.push(now);
      }
    }
    return seen;
  }

  async function trail(ms = 1500, step = 5) {
    const states: string[] = [];
    for (const { state } of await frames(ms, step)) {
      if (states[states.length - 1] !== state) states.push(state);
    }
    return states;
  }

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

  test("a pod's Usage section goes, as if none had come, once the context stops serving the Metrics API", async () => {
    const backend = createMockBackend("metricsRemoved");
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open(running());
    });
    await settle();
    expect(within(usageSection()).getAllByRole("meter")).toHaveLength(6);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await settle();
    expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
    expect(screen.getByRole("region", { name: "Containers" })).toBeTruthy();
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

  test("a pod's Usage section is in the Overview's first paint, with empty meters, and the figures fill it", async () => {
    const workbench = await mountKube(createMockBackend("ready"));
    act(() => {
      workbench.editors.open(running());
    });
    const seen = await frames();
    expect(seen.find(({ overview }) => overview)?.state).toBe("empty");
    expect(
      seen.filter(({ overview }) => overview).map(({ state }) => state),
    ).toEqual(["empty", "figures"]);
    expect(within(usageSection()).getAllByRole("meter")).toHaveLength(6);
  });

  test.each([
    [
      "a pod with a finished init container",
      (candidate: Pod) =>
        candidate.status === "Running" &&
        candidate.containers === 2 &&
        finishedInit(candidate),
      ["Pod", "api", "istio-proxy"],
    ],
    [
      "a crash-looping pod at Ready 1/2",
      (candidate: Pod) =>
        candidate.status === "CrashLoopBackOff" &&
        candidate.containers === 2 &&
        candidate.ready === 1,
      ["Pod", "api"],
    ],
  ])(
    "%s: the empty meters stand for the containers the answer lists, and the answer moves no row",
    async (_, pick, names) => {
      const workbench = await mountKube(createMockBackend("ready"));
      act(() => {
        workbench.editors.open(pod(pick));
      });
      const seen = (await frames()).filter(({ overview }) => overview);
      expect(seen.map(({ state }) => state)).toEqual(["empty", "figures"]);
      const rows = names.flatMap((name) => [
        `CPU of ${name}`,
        `Memory of ${name}`,
      ]);
      expect(seen.map((one) => one.rows)).toEqual([rows, rows]);
    },
  );

  test("the details beside a list draw the waiting section too, when no list reads the pod's namespace", async () => {
    const backend = createMockBackend("ready");
    const workbench = await mountKube(backend);
    workbench.state.set(null, "list//pods", {
      columns: { CPU: false, Memory: false },
      widths: {},
    });
    act(() => {
      workbench.editors.open("k8s-list://prod-eu/v1/pods");
    });
    await settle();
    const running = screen
      .getAllByRole("row")
      .slice(1)
      .find(
        (row) =>
          row.querySelector('[data-column="Status"]')?.textContent ===
          "Running",
      );
    fireEvent.click(running ?? document.body);
    const seen = await frames();
    expect(
      seen.filter(({ overview }) => overview).map(({ state }) => state),
    ).toEqual(["empty", "figures"]);
  });

  test("a node's Usage section is in the Overview's first paint with its pair of empty meters", async () => {
    const workbench = await mountKube(createMockBackend("ready"));
    act(() => {
      workbench.editors.open("k8s://prod-eu//v1/nodes/prod-eu-node-1");
    });
    const seen = (await frames()).filter(({ overview }) => overview);
    expect(seen.map(({ state }) => state)).toEqual(["empty", "figures"]);
    expect(seen[0]?.rows).toEqual(["CPU", "Memory"]);
    expect(within(usageSection()).getAllByRole("meter")).toHaveLength(2);
  });

  test("where the API refuses, the first pod's section waits with empty meters until it says so, and the next pod of the space says it at once", async () => {
    const workbench = await mountKube(createMockBackend("metricsForbidden"));
    const first = running();
    act(() => {
      workbench.editors.open(first);
    });
    expect((await trail()).filter((state) => state !== "none")).toEqual([
      "empty",
      "sentence",
    ]);
    act(() => {
      workbench.editors.open(running(namespaceOf(first)));
    });
    const next = await trail();
    expect(next).not.toContain("empty");
    expect(next[next.length - 1]).toBe("sentence");
  });

  test("a new discovery of the space forgets the refusal, so the next pod waits with empty meters again", async () => {
    const backend = createMockBackend("metricsForbidden");
    const subscribe = vi.spyOn(backend, "subscribe");
    const workbench = await mountKube(backend);
    const first = running();
    act(() => {
      workbench.editors.open(first);
    });
    await trail();
    const watch = subscribe.mock.calls.find(
      ([command]) => command === "resources_watch",
    ) as unknown as [string, string, (message: Discovered) => void] | undefined;
    act(() => {
      watch?.[2]({
        state: "ready",
        cluster: `mock://${watch[1]}`,
        resources: RESOURCES,
      });
    });
    act(() => {
      workbench.editors.open(running(namespaceOf(first)));
    });
    expect((await trail()).filter((state) => state !== "none")).toEqual([
      "empty",
      "sentence",
    ]);
  });

  test("where the API is stale, every pod's Overview has the sentence in its first paint, and no empty meters stand for it", async () => {
    const workbench = await mountKube(createMockBackend("metricsDown"));
    const first = running();
    for (const uri of [first, running(namespaceOf(first))]) {
      act(() => {
        workbench.editors.open(uri);
      });
      const seen = await frames();
      expect(
        seen.filter(({ overview }) => overview).map(({ state }) => state),
      ).toEqual(["sentence"]);
    }
  });

  test("a context that serves no Metrics API stands nothing in place", async () => {
    const workbench = await mountKube(createMockBackend("metricsNone"));
    act(() => {
      workbench.editors.open(running());
    });
    expect(await trail()).toEqual(["none"]);
  });

  test("once the API is gone, no section stands in place for the open pod or for the next", async () => {
    const workbench = await mountKube(createMockBackend("metricsRemoved"));
    const first = running();
    act(() => {
      workbench.editors.open(first);
    });
    await trail();
    expect(drawn()).toBe("figures");
    expect(await trail(20_000, 50)).toEqual(["figures", "none"]);
    act(() => {
      workbench.editors.open(running(namespaceOf(first)));
    });
    expect(await trail()).toEqual(["none"]);
  });
});
