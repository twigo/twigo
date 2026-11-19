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
  Measure,
  ObjectBatch,
  Overview as Document,
  RequestOf,
  ShownUsage,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  Cluster,
  containerNames,
  type Pod,
} from "../../../protocol/src/mock/cluster";
import { finishedInit } from "../../../protocol/src/mock/objects";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";
import { Overview } from "./Overview";
import { OverviewStates } from "./overviewStates";
import { PageStates } from "./pageStates";

const PAGE = { pages: new PageStates(), uri: "k8s://test", object: "a" };

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
  summary: [],
  tone: null,
  fold: "open",
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

const RUNNING = (name: string): Container => ({
  ...CONTAINER(name),
  state: {
    text: "Running",
    tone: "success",
    ready: true,
    running: true,
    restarts: 0,
  },
});

const HEADER: Document["header"] = {
  owner: null,
  node: null,
  created: null,
  generated: null,
  printed: [],
  sentence: [],
  vitals: [],
};

const POD_OF = (...containers: Container[]): Document => ({
  header: HEADER,
  sections: [
    SECTION("core.pod"),
    {
      id: "core.containers",
      title: "Containers",
      summary: [],
      tone: null,
      fold: "open",
      blocks: [{ type: "containers", containers }],
    },
    SECTION("core.metadata"),
  ],
});

const LISTED = POD_OF(
  { ...RUNNING("init-config"), role: "init" },
  RUNNING("api"),
  RUNNING("proxy"),
);

function shown(
  usage: ShownUsage | undefined,
  kind = "/pods",
  first = "core.pod",
) {
  const states = new OverviewStates();
  render(
    <Overview
      {...PAGE}
      overview={{
        header: HEADER,
        sections: [SECTION(first), SECTION("core.metadata")],
      }}
      space="prod-eu"
      states={states}
      kind={kind}
      onOpen={() => undefined}
      onEvents={() => undefined}
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
      {...PAGE}
      overview={overview}
      space="prod-eu"
      states={states}
      kind={kind}
      onOpen={() => undefined}
      onEvents={() => undefined}
      usage={usage}
    />
  );
  const { rerender } = render(view(usage));
  return (next: ShownUsage | undefined) => {
    rerender(view(next));
  };
}

const usageSection = () => screen.getByRole("region", { name: "Usage" });
const containersSection = () =>
  screen.getByRole("region", { name: "Containers" });
const labels = () =>
  within(containersSection()).getAllByText(/^(CPU|Memory)$/).length;
const rowsOf = (scope: HTMLElement) =>
  [...scope.querySelectorAll("dd")].filter((value) =>
    /^(CPU|Memory)$/.test(value.previousElementSibling?.textContent ?? ""),
  );
const lines = (scope: HTMLElement) =>
  rowsOf(scope).map((value) =>
    [...(value.firstElementChild?.children ?? [])]
      .filter((part) => part.getAttribute("aria-hidden") !== "true")
      .filter(
        (part) =>
          !["meter", "progressbar"].includes(part.getAttribute("role") ?? ""),
      )
      .map((part) => part.textContent.replace(/\u200b/g, "")),
  );
const meterNames = (scope: HTMLElement) =>
  within(scope)
    .getAllByRole("meter")
    .map((meter) => meter.getAttribute("aria-label"));

test("each container draws its own CPU and Memory against request and limit, and a pod has no usage section", () => {
  listed(POD);
  expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
  const section = containersSection();
  expect(meterNames(section)).toEqual([
    "CPU of api",
    "Memory of api",
    "CPU of proxy",
    "Memory of proxy",
  ]);
  expect(within(section).queryByText("Pod")).toBeNull();
  expect(lines(section)).toEqual([
    ["No data yet"],
    ["No data yet"],
    ["100m", "25%"],
    ["60Mi", "46%"],
    ["20m", "125%"],
    ["30Mi", "93%"],
  ]);
  expect(
    within(section)
      .getByRole("meter", { name: "CPU of proxy" })
      .getAttribute("aria-valuemax"),
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

const NEAR = {
  name: "near",
  cpu: measure({ used: 10_000_000, limit: 100_000_000 }),
  memory: measure({ used: 92 * MI, limit: 100 * MI }),
};

const NEAR_AND_OVER: ShownUsage = {
  ...POD,
  containers: [
    NEAR,
    {
      name: "over",
      cpu: measure({ used: 130_000_000, limit: 100_000_000 }),
      memory: measure({ used: 10 * MI, limit: 100 * MI }),
    },
  ],
};

test("what nears its limit or passes it is a warning or an error in its meter and its words", () => {
  listed(NEAR_AND_OVER, "/pods", POD_OF(RUNNING("near"), RUNNING("over")));
  const fill = (name: string) =>
    screen.getByRole("meter", { name }).querySelector("span > span")?.className;
  expect(fill("Memory of near")).toContain("bg-warn");
  expect(fill("CPU of over")).toContain("bg-error");
  expect(fill("CPU of near")).not.toMatch(/bg-(warn|error)/);
  expect(containersSection().textContent).toContain("92%");
  expect(containersSection().textContent).toContain("130%");
});

test("a meter says its figures in the printed units against what it is held to, and the tone in words", () => {
  listed(
    {
      ...NEAR_AND_OVER,
      containers: [
        NEAR,
        {
          name: "over",
          cpu: measure({ used: 130_000_000, limit: 100_000_000 }),
          memory: measure({ used: 10 * MI, request: 64 * MI }),
        },
      ],
    },
    "/pods",
    POD_OF(RUNNING("near"), RUNNING("over")),
  );
  const spoken = (name: string) =>
    screen.getByRole("meter", { name }).getAttribute("aria-valuetext");
  expect(spoken("CPU of near")).toBe("10m of 100m limit, 10%");
  expect(spoken("Memory of near")).toBe("92Mi of 100Mi limit, 92%, warning");
  expect(spoken("CPU of over")).toBe("130m of 100m limit, 130%, error");
  expect(spoken("Memory of over")).toBe("10Mi of 64Mi request, 15%");
  const section = containersSection();
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

test("a container without a sample says no data yet, never zero", () => {
  listed(
    {
      ...POD,
      containers: [{ name: "api", cpu: NOTHING, memory: NOTHING }],
    },
    "/pods",
    POD_OF(RUNNING("api")),
  );
  const section = containersSection();
  expect(within(section).getAllByText("No data yet")).toHaveLength(2);
  expect(within(section).queryAllByRole("meter")).toHaveLength(0);
  expect(section.textContent).not.toMatch(/\b0(m|Mi)\b/);
});

test("a running container that a ready answer does not name says no data yet, as does one that a partial answer leaves out, and a container that does not run draws nothing", () => {
  const answer = listed(
    { ...POD, sampled: null, cpu: NOTHING, memory: NOTHING, containers: [] },
    "/pods",
    POD_OF(RUNNING("api"), CONTAINER("done"), RUNNING("proxy")),
  );
  expect(within(containersSection()).getAllByText("No data yet")).toHaveLength(
    4,
  );
  expect(within(containersSection()).queryAllByRole("meter")).toHaveLength(0);
  expect(labels()).toBe(4);

  answer({ ...POD, containers: POD.containers.slice(0, 1) });
  expect(meterNames(containersSection())).toEqual([
    "CPU of api",
    "Memory of api",
  ]);
  expect(within(containersSection()).getAllByText("No data yet")).toHaveLength(
    2,
  );
  expect(labels()).toBe(4);
});

test.each([
  ["unavailable", /metrics-server does not answer/],
  ["forbidden", /may not read metrics/],
] as const)(
  "a Metrics API that is %s says so once in the containers' section and draws no figure",
  (state, words) => {
    listed(
      {
        ...POD,
        state,
        sampled: null,
        cpu: NOTHING,
        memory: NOTHING,
        containers: [],
      },
      "/pods",
      POD_OF(RUNNING("api"), RUNNING("proxy")),
    );
    const section = containersSection();
    expect(section.textContent.match(words)).toHaveLength(1);
    expect(within(section).queryAllByRole("meter")).toHaveLength(0);
    expect(within(section).queryByText("No data yet")).toBeNull();
  },
);

test("a pod whose containers run none says nothing of a Metrics API that does not answer", () => {
  listed(
    { ...POD, state: "unavailable", containers: [] },
    "/pods",
    POD_OF(CONTAINER("api")),
  );
  expect(containersSection().textContent).not.toMatch(/metrics-server/);
});

test("a node's Metrics API that is unavailable says so in its section", () => {
  shown(
    { ...NODE, state: "unavailable", containers: [] },
    "/nodes",
    "core.node",
  );
  expect(usageSection().textContent).toMatch(/metrics-server does not answer/);
  expect(within(usageSection()).queryAllByRole("meter")).toHaveLength(0);
});

test("a usage that waits draws the rows of every running container, with an empty meter where it carries a request or a limit and none where it carries neither, and the answer fills the same rows", () => {
  const answer = listed(WAITING_POD, "/pods");
  const section = containersSection();
  const empty = within(section).getAllByRole("progressbar");
  expect(empty.map((meter) => meter.getAttribute("aria-label"))).toEqual([
    "CPU of api",
    "Memory of api",
  ]);
  for (const meter of empty) {
    expect(meter.getAttribute("aria-valuetext")).toBe("Loading");
  }
  expect(within(section).queryAllByRole("meter")).toHaveLength(0);
  expect(lines(section)).toEqual(Array.from({ length: 6 }, () => [""]));
  expect(labels()).toBe(6);

  answer({ ...POD, containers: POD.containers.slice(0, 1) });
  expect(labels()).toBe(6);
  expect(within(containersSection()).getAllByRole("meter")).toHaveLength(2);
  expect(
    within(containersSection()).queryAllByRole("progressbar"),
  ).toHaveLength(0);
  expect(within(containersSection()).getAllByText("No data yet")).toHaveLength(
    4,
  );
});

const REQUESTED = measure({ used: 20_000_000, request: 16_000_000 });
const BARE = measure({ used: 20_000_000 });

test.each<[string, ShownUsage, string[], string]>([
  ["waits with a limit", WAITING_POD, [""], "progressbar"],
  [
    "waits with neither request nor limit",
    {
      ...WAITING_POD,
      containers: [{ name: "api", cpu: NOTHING, memory: NOTHING }],
    },
    [""],
    "none",
  ],
  ["has a limit and a request", POD, ["100m", "25%"], "meter"],
  [
    "has a request only",
    {
      ...POD,
      containers: [{ name: "api", cpu: REQUESTED, memory: REQUESTED }],
    },
    ["20m", "125%"],
    "meter",
  ],
  [
    "has neither",
    { ...POD, containers: [{ name: "api", cpu: BARE, memory: BARE }] },
    ["20m"],
    "none",
  ],
  [
    "has no sample",
    {
      ...POD,
      containers: [{ name: "api", cpu: NOTHING, memory: NOTHING }],
    },
    ["No data yet"],
    "none",
  ],
])(
  "a container's row is one line whatever it says, led by text so that its label keeps its place: it %s",
  (_, usage, cpu, meter) => {
    listed(usage, "/pods", POD_OF(RUNNING("api")));
    const section = containersSection();
    const rows = rowsOf(section);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.children).toHaveLength(1);
      const first = row.firstElementChild?.firstElementChild;
      expect(first?.textContent).toBe("\u200b");
      expect(first?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(lines(section)[0]).toEqual(cpu);
    expect(
      within(section).queryAllByRole(meter === "none" ? "meter" : meter),
    ).toHaveLength(meter === "none" ? 0 : 2);
    if (meter === "none") {
      expect(within(section).queryAllByRole("progressbar")).toHaveLength(0);
    }
  },
);

const CAPPED: ShownUsage = {
  ...POD,
  containers: [
    {
      name: "api",
      cpu: measure({ used: 9_999_000_000, request: 100_000_000 }),
      memory: measure({ used: 1023 * MI, request: MI }),
    },
  ],
};

test("a share of 10,000 % or more reads >9999% with the exact share in its tooltip, and 9,999 % is drawn whole", () => {
  listed(CAPPED, "/pods", POD_OF(RUNNING("api")));
  const section = containersSection();
  expect(lines(section)).toEqual([
    ["9999m", "9999%"],
    ["1023Mi", ">9999%"],
  ]);
  expect(
    rowsOf(section).map((row) =>
      row.querySelector("[title]")?.getAttribute("title"),
    ),
  ).toEqual(["of request", "102300% of request"]);
});

const sized = (room: number, widest: number) =>
  vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("w-max") ? widest : room;
    });

test("a capped share still holds its exact share in its tooltip where the part has room to say its base in words", () => {
  sized(300, 230);
  listed(CAPPED, "/pods", POD_OF(RUNNING("api")));
  const section = containersSection();
  expect(lines(section)).toEqual([
    ["9999m", "9999%of request"],
    ["1023Mi", ">9999%of request"],
  ]);
  expect(
    rowsOf(section).map((row) =>
      row.querySelector("[title]")?.getAttribute("title"),
    ),
  ).toEqual([undefined, "102300% of request"]);
});

test("a share says its base in words where the part has room for its widest row with 16 px to spare, once for every row, and by its tooltip where it has not", () => {
  const share = () => lines(containersSection())[2]?.[1];
  const tip = () =>
    rowsOf(containersSection())[2]
      ?.querySelector("[title]")
      ?.getAttribute("title");
  const width = sized(300, 230);
  const answer = listed(POD, "/pods");
  expect(share()).toBe("25%of limit");
  expect(tip()).toBeUndefined();
  for (const [room, said] of [
    [245, true],
    [231, true],
    [229, false],
    [245, false],
    [246, true],
  ] as const) {
    width.mockRestore();
    sized(room, 230);
    answer({ ...POD });
    expect(share(), String(room)).toBe(said ? "25%of limit" : "25%");
    expect(tip(), String(room)).toBe(said ? undefined : "of limit");
  }
  vi.restoreAllMocks();
});

test("a node's usage that waits is its pair of empty meters", () => {
  listed(WAITING_NODE, "/nodes", {
    header: HEADER,
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

test("a node's section follows the Diagnostics, else comes first, a pod has none, and without a usage there is none", () => {
  const order = () =>
    screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
  shown(NODE, "/nodes", "core.diagnostics");
  expect(order()).toEqual(["Diagnostics", "Usage", "Metadata"]);
  cleanup();
  shown(NODE, "/nodes", "core.node");
  expect(order()).toEqual(["Usage", "Node", "Metadata"]);
  cleanup();
  shown(POD, "/pods", "core.diagnostics");
  expect(order()).toEqual(["Diagnostics", "Metadata"]);
  cleanup();
  shown(undefined, "/nodes", "core.node");
  expect(order()).toEqual(["Node", "Metadata"]);
});

test("a node's section folds, and the kind remembers it", () => {
  const states = shown(NODE, "/nodes", "core.node");
  const open = () => states.section("/nodes", "", "core.usage", "open");
  expect(open()).toBe(true);
  fireEvent.click(
    within(usageSection()).getByRole("button", { name: /Usage/ }),
  );
  expect(open()).toBe(false);
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

  interface Where {
    readonly outside?: string;
    readonly inside?: string;
    readonly not?: string;
  }
  const pod = (pick: (candidate: Pod) => boolean, where: Where = {}) => {
    const found = new Cluster("prod-eu", 5000, Date.now()).pods.find(
      (candidate) =>
        Date.now() - candidate.created > 120_000 &&
        candidate.namespace !== where.outside &&
        (where.inside === undefined || candidate.namespace === where.inside) &&
        `k8s://prod-eu//v1/pods/${candidate.namespace}/${candidate.name}` !==
          where.not &&
        pick(candidate),
    );
    if (!found) throw new Error("no such pod in the mock");
    return `k8s://prod-eu//v1/pods/${found.namespace}/${found.name}`;
  };
  const running = (where?: Where) =>
    pod(
      (candidate) =>
        candidate.status === "Running" && candidate.containers === 2,
      where,
    );
  const namespaceOf = (uri: string) => uri.split("/")[6];

  const region = (name: string) =>
    document.querySelector(`section[aria-label="${name}"]`);

  const usageArea = () => region("Usage") ?? region("Containers");

  const drawnMeters = (
    scope: Element | null | undefined,
    role: "meter" | "progressbar",
  ) =>
    [...(scope?.querySelectorAll(`[role="${role}"]`) ?? [])].filter(
      (meter) => meter.closest("[aria-hidden]") === null,
    );

  const drawn = () => {
    const usage = usageArea();
    if (!usage) return "none";
    if (drawnMeters(usage, "progressbar").length > 0) return "empty";
    if (drawnMeters(usage, "meter").length > 0) return "figures";
    return /metrics-server does not answer|may not read metrics/.test(
      usage.textContent,
    )
      ? "sentence"
      : "none";
  };

  const frame = () => ({
    overview: region("Metadata") !== null,
    state: drawn(),
    rows: [
      ...drawnMeters(usageArea(), "progressbar"),
      ...drawnMeters(usageArea(), "meter"),
    ]
      .sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
      )
      .map((meter) => meter.getAttribute("aria-label")),
  });

  async function frames(ms = 600, step = 10) {
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

  async function trail(ms = 600, step = 10) {
    const states: string[] = [];
    for (const { state } of await frames(ms, step)) {
      if (states[states.length - 1] !== state) states.push(state);
    }
    return states;
  }

  test("an open pod's Overview shows its usage while the document is visible, and no other view asks for it", async () => {
    const backend = createMockBackend("ready");
    const usage = spied(backend);
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open(running());
    });
    await settle();
    expect(usage()).toBe(true);
    expect(meterNames(containersSection())).toHaveLength(4);

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

    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    await settle();
    expect(usage()).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await settle();
    expect(usage()).toBe(true);
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
    expect(within(aside).queryByRole("region", { name: "Usage" })).toBeNull();
    expect(
      aside.querySelector(
        'section[aria-label="Containers"] [role="meter"], section[aria-label="Containers"] [role="progressbar"]',
      ),
    ).not.toBeNull();
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

  test("a pod's containers lose their meters, as if none had come, once the context stops serving the Metrics API", async () => {
    const backend = createMockBackend("metricsRemoved");
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open(running());
    });
    await settle();
    expect(meterNames(containersSection())).toHaveLength(4);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await settle();
    expect(within(containersSection()).queryAllByRole("meter")).toHaveLength(0);
    expect(containersSection().textContent).not.toMatch(/metrics-server/);
  });

  test("a context without the Metrics API draws no meters", async () => {
    const backend = createMockBackend("metricsNone");
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open(running());
    });
    await settle(30);
    expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
    expect(within(containersSection()).queryAllByRole("meter")).toHaveLength(0);
  });

  test("a pod's containers have their empty meters in the Overview's first paint, and the figures fill them", async () => {
    const workbench = await mountKube(createMockBackend("ready"));
    act(() => {
      workbench.editors.open(running());
    });
    const seen = await frames();
    expect(seen.find(({ overview }) => overview)?.state).toBe("empty");
    expect(
      seen.filter(({ overview }) => overview).map(({ state }) => state),
    ).toEqual(["empty", "figures"]);
    expect(meterNames(containersSection())).toHaveLength(4);
  });

  test.each([
    [
      "a pod with a finished init container",
      (candidate: Pod) =>
        candidate.status === "Running" &&
        candidate.containers === 2 &&
        finishedInit(candidate),
      2,
      2,
      2,
    ],
    [
      "a crash-looping pod at Ready 1/2, whose second container the mock's card runs and its usage does not name",
      (candidate: Pod) =>
        candidate.status === "CrashLoopBackOff" &&
        candidate.containers === 2 &&
        candidate.ready === 1,
      2,
      1,
      1,
    ],
  ])(
    "%s: a container's rows stand for it from the first paint, with an empty meter where the usage names it, and the answer moves no row",
    async (_, pick, alive, waiting, answered) => {
      const workbench = await mountKube(createMockBackend("ready"));
      const uri = pod(pick);
      const [namespace, name] = uri.split("/").slice(-2);
      const found = new Cluster("prod-eu", 5000, Date.now()).pods.find(
        (candidate) =>
          candidate.namespace === namespace && candidate.name === name,
      );
      if (!found) throw new Error("no such pod in the mock");
      act(() => {
        workbench.editors.open(uri);
      });
      const seen = (await frames()).filter(({ overview }) => overview);
      expect(seen.map(({ state }) => state)).toEqual(["empty", "figures"]);
      const meters = (count: number) =>
        containerNames(found, count).flatMap((name) => [
          `CPU of ${name}`,
          `Memory of ${name}`,
        ]);
      expect(seen.map((one) => one.rows)).toEqual([
        meters(waiting),
        meters(answered),
      ]);
      expect(labels()).toBe(alive * 2);
      expect(
        within(containersSection()).queryAllByText("No data yet"),
      ).toHaveLength((alive - answered) * 2);
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

  test.each([
    ["a pod", () => running()],
    ["a node", () => "k8s://prod-eu//v1/nodes/prod-eu-node-1"],
  ])(
    "%s's figures stay while its tab returns and while the document shows again, until the answer replaces them",
    async (_, uri) => {
      const workbench = await mountKube(createMockBackend("ready"));
      const open = uri();
      act(() => {
        workbench.editors.open(open);
      });
      await trail();
      expect(drawn()).toBe("figures");
      act(() => {
        workbench.editors.open("k8s-list://prod-eu/apps/v1/deployments");
      });
      await settle();
      act(() => {
        workbench.editors.activate(open);
      });
      expect((await trail()).filter((state) => state !== "none")).toEqual([
        "figures",
      ]);

      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle(2);
      hidden.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect((await trail()).filter((state) => state !== "none")).toEqual([
        "figures",
      ]);
    },
    20_000,
  );

  test("where the API refuses, the first pod's section waits with empty meters until it says so, and the next pod of its namespace says it at once, as one of another namespace waits", async () => {
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
      workbench.editors.open(
        running({ inside: namespaceOf(first), not: first }),
      );
    });
    expect((await trail()).filter((state) => state !== "none")).toEqual([
      "sentence",
    ]);
    act(() => {
      workbench.editors.open(running({ outside: namespaceOf(first) }));
    });
    expect((await trail()).filter((state) => state !== "none")).toEqual([
      "empty",
      "sentence",
    ]);
  });

  test("a refusal outlives the space being shown again: the next pod of its namespace says it at once", async () => {
    const workbench = await mountKube(createMockBackend("metricsForbidden"));
    const first = running();
    act(() => {
      workbench.editors.open(first);
    });
    await trail();
    act(() => {
      workbench.editors.close(first);
    });
    await trail(100);
    act(() => {
      workbench.spaces.select("staging");
    });
    await trail(200);
    act(() => {
      workbench.spaces.select("prod-eu");
    });
    await trail(200);
    act(() => {
      workbench.editors.open(
        running({ inside: namespaceOf(first), not: first }),
      );
    });
    expect((await trail()).filter((state) => state !== "none")).toEqual([
      "sentence",
    ]);
  });

  test("a node the person may not read the metrics of says nothing of a pod whose metrics they may", async () => {
    const mock = createMockBackend("ready");
    const backend: Backend = {
      invoke: (command, request) => mock.invoke(command, request),
      subscribe: (command, request, onMessage) => {
        const nodes =
          command === "object_open" &&
          (request as RequestOf<"object_open">).object.gvr.resource === "nodes";
        return mock.subscribe(command, request, (message) => {
          const batch = message as ObjectBatch;
          const { usage } = batch;
          onMessage(
            nodes && usage && !usage.waiting
              ? { ...batch, usage: { ...usage, state: "forbidden" } }
              : message,
          );
        });
      },
    };
    const workbench = await mountKube(backend);
    act(() => {
      workbench.editors.open("k8s://prod-eu//v1/nodes/prod-eu-node-1");
    });
    expect((await trail()).filter((state) => state !== "none")).toEqual([
      "empty",
      "sentence",
    ]);
    act(() => {
      workbench.editors.open(running());
    });
    expect((await trail()).filter((state) => state !== "none")).toEqual([
      "empty",
      "figures",
    ]);
  });

  test("where the API is stale, every pod's Overview has the sentence in its first paint, and no empty meters stand for it", async () => {
    const workbench = await mountKube(createMockBackend("metricsDown"));
    const first = running();
    for (const uri of [first, running({ outside: namespaceOf(first) })]) {
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
    expect(await trail(20_000, 250)).toEqual(["figures", "none"]);
    act(() => {
      workbench.editors.open(running({ outside: namespaceOf(first) }));
    });
    expect(await trail()).toEqual(["none"]);
  });
});
