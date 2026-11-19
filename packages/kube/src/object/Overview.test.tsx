import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  Condition,
  ObjectEvent,
  Overview as Document,
  Value,
} from "@twigo/protocol";
import { Overview } from "./Overview";
import { OverviewStates } from "./overviewStates";
import { compile, matchesIn } from "./pageFilter";
import { PageStates } from "./pageStates";
import { NO_HEADER, PAGE } from "../../test/object";

afterEach(() => {
  cleanup();
});

const KEYS = 2000;

function configMap(): Document {
  return {
    header: NO_HEADER,
    sections: [
      {
        id: "core.data",
        title: "Data",
        summary: [],
        tone: null,
        fold: "open",
        blocks: [
          {
            type: "data",
            readable: true,
            entries: Array.from({ length: KEYS }, (_, index) => ({
              key: `key-${index}`,
              bytes: 12,
              binary: false,
            })),
          },
        ],
      },
    ],
  };
}

test("a ConfigMap of 2,000 keys puts in the DOM the values of the keys opened only", async () => {
  const values = vi.fn((keys: readonly string[]) =>
    Promise.resolve(keys.map((key) => `value of ${key}`)),
  );
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={configMap()}
      onOpen={() => undefined}
      values={values}
    />,
  );
  expect(
    document.querySelectorAll('button[aria-expanded="false"]'),
  ).toHaveLength(KEYS);
  expect(document.body.textContent).not.toContain("value of");
  await act(async () => {
    fireEvent.click(screen.getByText("key-1500"));
    await Promise.resolve();
  });
  expect(values).toHaveBeenCalledWith(["key-1500"]);
  expect(document.body.textContent).toContain("value of key-1500");
  expect(document.body.textContent.match(/value of/g)).toHaveLength(1);
});

test("a link opens the object it points at", () => {
  const onOpen = vi.fn();
  const target = {
    group: "apps",
    version: "v1",
    kind: "ReplicaSet",
    namespace: "payments",
    name: "web-1",
  };
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={{
        header: NO_HEADER,
        sections: [
          {
            id: "core.metadata",
            title: "Metadata",
            summary: [],
            tone: null,
            fold: "open",
            blocks: [
              {
                type: "fields",
                fields: [
                  {
                    label: "Controlled by",
                    value: { type: "link", target, text: "ReplicaSet/web-1" },
                    default: false,
                  },
                ],
              },
            ],
          },
        ],
      }}
      onOpen={onOpen}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "ReplicaSet/web-1" }));
  expect(onOpen).toHaveBeenCalledWith(target);
});

test("a section folds by its title, and stays folded for the kind's next object", () => {
  const states = new OverviewStates();
  const shown = (kind: string) =>
    render(
      <Overview
        {...PAGE}
        states={states}
        kind={kind}
        space="kind-test"
        overview={configMap()}
        onOpen={() => undefined}
      />,
    );
  shown("/configmaps");
  expect(screen.getByText("key-0")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Data" }));
  expect(screen.queryByText("key-0")).toBeNull();
  cleanup();
  shown("/configmaps");
  expect(screen.queryByText("key-0")).toBeNull();
  cleanup();
  shown("/secrets");
  expect(screen.getByText("key-0")).toBeDefined();
});

function data(readable: boolean, bytes = 3): Document {
  return {
    header: NO_HEADER,
    sections: [
      {
        id: "core.data",
        title: "Data",
        summary: [],
        tone: null,
        fold: "open",
        blocks: [
          {
            type: "data",
            readable,
            entries: [{ key: "mode", bytes, binary: false }],
          },
        ],
      },
    ],
  };
}

test("an open value is read again when the object changes", async () => {
  let current = "old";
  const values = vi.fn(() => Promise.resolve([current]));
  const { rerender } = render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={data(true)}
      onOpen={() => undefined}
      values={values}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /mode/ }));
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain("old");
  current = "newer";
  await act(async () => {
    rerender(
      <Overview
        {...PAGE}
        states={new OverviewStates()}
        kind="/pods"
        space="kind-test"
        overview={data(true, 5)}
        onOpen={() => undefined}
        values={values}
      />,
    );
    await Promise.resolve();
  });
  expect(values).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("newer");
});

test("a value that cannot be read says why", async () => {
  const values = vi.fn(() =>
    Promise.reject(new Error("the object is not open yet")),
  );
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={data(true)}
      onOpen={() => undefined}
      values={values}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /mode/ }));
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain("the object is not open yet");
});

test("a Secret's keys do not open", () => {
  const values = vi.fn(() => Promise.resolve([null]));
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={data(false)}
      onOpen={() => undefined}
      values={values}
    />,
  );
  expect(screen.queryByRole("button", { name: /mode/ })).toBeNull();
  expect(screen.getByText("mode")).toBeDefined();
});

test("events that cannot be listed say why instead of none", () => {
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={{
        header: NO_HEADER,
        sections: [
          {
            id: "core.events",
            title: "Events",
            summary: [],
            tone: null,
            fold: "open",
            blocks: [
              {
                type: "events",
                events: [],
                listed: false,
                unavailable: "You may not list events.events.k8s.io.",
              },
            ],
          },
        ],
      }}
      onOpen={() => undefined}
    />,
  );
  expect(document.body.textContent).toContain("You may not list");
  expect(document.body.textContent).not.toContain("No events");
});

function eventsPage(events: ObjectEvent[]): Document {
  return {
    header: NO_HEADER,
    sections: [
      {
        id: "core.events",
        title: "Events",
        summary: [],
        tone: null,
        fold: "open",
        blocks: [{ type: "events", events, listed: true, unavailable: null }],
      },
    ],
  };
}

const NOTE = (reason: string, type: ObjectEvent["type"]): ObjectEvent => ({
  type,
  reason,
  message: `${reason} happened`,
  source: "kubelet",
  count: 1,
  first: null,
  last: "2026-11-02T21:04:52Z",
  fieldPath: null,
});

test("the Overview lists an object's three newest events, its warnings first, and points to the Events view for the rest", () => {
  const onEvents = vi.fn();
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={eventsPage([
        NOTE("Started", "Normal"),
        NOTE("Created", "Normal"),
        NOTE("BackOff", "Warning"),
        NOTE("Pulled", "Normal"),
        NOTE("Scheduled", "Normal"),
      ])}
      onOpen={() => undefined}
      onEvents={onEvents}
    />,
  );
  const section = screen.getByRole("region", { name: "Events" });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => /^[A-Za-z]+/.exec(item.textContent)?.[0]),
  ).toEqual(["BackOff", "Started", "Created"]);
  fireEvent.click(
    within(section).getByRole("button", { name: "All 5 events" }),
  );
  expect(onEvents).toHaveBeenCalledTimes(1);
});

test("under the page's filter the events section lists every event the filter keeps and links to nothing, and the count agrees", () => {
  const pages = new PageStates();
  pages.setText(PAGE.uri, "kubelet");
  const overview = eventsPage([
    NOTE("Started", "Normal"),
    NOTE("Created", "Normal"),
    { ...NOTE("Scheduled", "Normal"), source: "scheduler" },
    NOTE("BackOff", "Warning"),
    NOTE("Pulled", "Normal"),
  ]);
  const { filter } = compile("kubelet");
  if (!filter) throw new Error("a filter");
  render(
    <Overview
      {...PAGE}
      pages={pages}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={overview}
      onOpen={() => undefined}
    />,
  );
  const section = screen.getByRole("region", { name: "Events" });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => /^[A-Za-z]+/.exec(item.textContent)?.[0]),
  ).toEqual(["BackOff", "Started", "Created", "Pulled"]);
  expect(within(section).queryByRole("button", { name: /^All / })).toBeNull();
  expect(matchesIn(overview, filter, false).matches).toBe(4);
});

test("a filter that matches the events section's title keeps it whole: the newest three and the link to all of them", () => {
  const pages = new PageStates();
  pages.setText(PAGE.uri, "Events");
  render(
    <Overview
      {...PAGE}
      pages={pages}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={eventsPage([
        NOTE("Started", "Normal"),
        NOTE("Created", "Normal"),
        NOTE("BackOff", "Warning"),
        NOTE("Pulled", "Normal"),
        NOTE("Scheduled", "Normal"),
      ])}
      onOpen={() => undefined}
    />,
  );
  const section = screen.getByRole("region", { name: "Events" });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => /^[A-Za-z]+/.exec(item.textContent)?.[0]),
  ).toEqual(["BackOff", "Started", "Created"]);
  expect(
    within(section).getByRole("button", { name: "All 5 events" }),
  ).toBeDefined();
});

test("three events or fewer are all there is, and none points to the Events view", () => {
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={eventsPage([
        NOTE("Started", "Normal"),
        NOTE("Created", "Normal"),
        NOTE("Scheduled", "Normal"),
      ])}
      onOpen={() => undefined}
      onEvents={() => undefined}
    />,
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /^All / })).toBeNull();
});

test("a multiline value keeps its lines", () => {
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={{
        header: NO_HEADER,
        sections: [
          {
            id: "core.spec",
            title: "Spec",
            summary: [],
            tone: null,
            fold: "open",
            blocks: [
              {
                type: "tree",
                nodes: [
                  {
                    key: "statusTemplate",
                    label: "Status template",
                    value: {
                      type: "scalar",
                      text: "phase: Running\nready: true",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }}
      onOpen={() => undefined}
    />,
  );
  const value = screen.getByText(/phase: Running/);
  expect(value.textContent).toBe("phase: Running\nready: true");
  expect(value.className).toContain("whitespace-pre-wrap");
});

const AT = "2026-11-02T21:04:52Z";

test("conditions read as chips with a mark in their tone, and the wrong ones say why below them", () => {
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={{
        header: NO_HEADER,
        sections: [
          {
            id: "core.conditions",
            title: "Conditions",
            summary: [],
            tone: null,
            fold: "open",
            blocks: [
              {
                type: "conditions",
                conditions: [
                  {
                    type: "Ready",
                    status: "False",
                    tone: "danger",
                    reason: "ContainersNotReady",
                    message: "containers with unready status: [api]",
                    lastTransition: AT,
                    lastHeartbeat: null,
                    explained: false,
                  },
                  {
                    type: "PodScheduled",
                    status: "True",
                    tone: "success",
                    reason: null,
                    message: null,
                    lastTransition: AT,
                    lastHeartbeat: null,
                    explained: false,
                  },
                  {
                    type: "DisruptionTarget",
                    status: "True",
                    tone: "warning",
                    reason: "EvictionByEvictionAPI",
                    message: null,
                    lastTransition: AT,
                    lastHeartbeat: null,
                    explained: false,
                  },
                  {
                    type: "Initialized",
                    status: "False",
                    tone: "danger",
                    reason: null,
                    message: null,
                    lastTransition: AT,
                    lastHeartbeat: null,
                    explained: false,
                  },
                ],
              },
            ],
          },
        ],
      }}
      onOpen={() => undefined}
    />,
  );
  const chips = screen.getAllByRole("listitem");
  expect(
    chips.map((chip) => [
      chip.getAttribute("title"),
      chip.querySelector("svg")?.getAttribute("aria-label"),
      chip
        .querySelector("svg")
        ?.getAttribute("class")
        ?.match(/text-[\w-]+/)?.[0],
    ]),
  ).toEqual([
    [
      "Ready: False\nContainersNotReady\ncontainers with unready status: [api]",
      "False",
      "text-error",
    ],
    ["PodScheduled: True", "True", "text-ok"],
    [
      "DisruptionTarget: True\nEvictionByEvictionAPI",
      "True",
      "text-warn-foreground",
    ],
    ["Initialized: False", "False", "text-error"],
  ]);
  expect(chips.map((chip) => chip.textContent.split(/\d/)[0])).toEqual([
    "Ready",
    "PodScheduled",
    "DisruptionTarget",
    "Initialized",
  ]);
  expect(
    [...document.querySelectorAll("p:not([aria-live])")].map(
      (reason) => reason.textContent,
    ),
  ).toEqual([
    "Ready · ContainersNotReady",
    "containers with unready status: [api]",
    "DisruptionTarget · EvictionByEvictionAPI",
  ]);
});

function condition(type: string, rest: Partial<Condition> = {}): Condition {
  return {
    type,
    status: "False",
    tone: "danger",
    reason: "ContainersNotReady",
    message: "containers with unready status: [api]",
    lastTransition: AT,
    lastHeartbeat: null,
    explained: false,
    ...rest,
  };
}

function conditionLines(conditions: Condition[]) {
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={{
        header: NO_HEADER,
        sections: [
          {
            id: "core.conditions",
            title: "Conditions",
            summary: [],
            tone: null,
            fold: "open",
            blocks: [{ type: "conditions", conditions }],
          },
        ],
      }}
      onOpen={() => undefined}
    />,
  );
  return [...document.querySelectorAll("p:not([aria-live])")].map(
    (line) => line.textContent,
  );
}

test("two wrong conditions that say the same share one line, and one the Diagnostics explain has none", () => {
  expect(
    conditionLines([
      condition("Ready"),
      condition("ContainersReady"),
      condition("PodScheduled", {
        reason: "Unschedulable",
        message: "0/3 nodes are available",
        explained: true,
      }),
    ]),
  ).toEqual([
    "Ready, ContainersReady · ContainersNotReady",
    "containers with unready status: [api]",
  ]);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

test("a Secret's value reaches the DOM only through a Reveal, and leaves it on Hide", async () => {
  const reveal = vi.fn((key: string) =>
    Promise.resolve(
      key === "mode" ? { value: "hunter2", binary: false } : undefined,
    ),
  );
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/secrets"
      space="kind-test"
      overview={data(false)}
      onOpen={() => undefined}
      reveal={reveal}
    />,
  );
  expect(document.body.textContent).not.toContain("hunter2");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reveal mode" }));
    await Promise.resolve();
  });
  expect(reveal).toHaveBeenCalledWith("mode");
  expect(document.body.textContent).toContain("hunter2");
  fireEvent.click(screen.getByRole("button", { name: "Hide mode" }));
  expect(document.body.textContent).not.toContain("hunter2");
});

test("a Reveal the person does not confirm shows nothing", async () => {
  const reveal = vi.fn(() => Promise.resolve(undefined));
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/secrets"
      space="kind-test"
      overview={data(false)}
      onOpen={() => undefined}
      reveal={reveal}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reveal mode" }));
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Reveal mode" })).toBeTruthy();
  expect(document.querySelector("pre")).toBeNull();
});

test("a value revealed for one Secret is not shown for the next one's key of that name", async () => {
  const first = vi.fn(() =>
    Promise.resolve({ value: "hunter2", binary: false }),
  );
  const next = vi.fn(() => Promise.resolve(undefined));
  const shown = (reveal: typeof first | typeof next) => (
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/secrets"
      space="kind-test"
      overview={data(false)}
      onOpen={() => undefined}
      reveal={reveal}
    />
  );
  const { rerender } = render(shown(first));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reveal mode" }));
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain("hunter2");
  rerender(shown(next));
  expect(document.body.textContent).not.toContain("hunter2");
  expect(screen.getByRole("button", { name: "Reveal mode" })).toBeTruthy();
  rerender(shown(first));
  expect(document.body.textContent).not.toContain("hunter2");
});

test("an answer that comes after the row moved to another Secret is dropped", async () => {
  let answer: (value: { value: string; binary: boolean }) => void = () =>
    undefined;
  const slow = vi.fn(
    () =>
      new Promise<{ value: string; binary: boolean }>((resolve) => {
        answer = resolve;
      }),
  );
  const next = vi.fn(() => Promise.resolve(undefined));
  const shown = (reveal: typeof slow | typeof next) => (
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/secrets"
      space="kind-test"
      overview={data(false)}
      onOpen={() => undefined}
      reveal={reveal}
    />
  );
  const { rerender } = render(shown(slow));
  fireEvent.click(screen.getByRole("button", { name: "Reveal mode" }));
  rerender(shown(next));
  await act(async () => {
    answer({ value: "hunter2", binary: false });
    await Promise.resolve();
  });
  expect(document.body.textContent).not.toContain("hunter2");
  rerender(shown(slow));
  expect(document.body.textContent).not.toContain("hunter2");
});

function fields(...rows: [string, Value][]): Document {
  return {
    header: NO_HEADER,
    sections: [
      {
        id: "core.pod",
        title: "Pod",
        summary: [],
        tone: null,
        fold: "open",
        blocks: [
          {
            type: "fields",
            fields: rows.map(([label, value]) => ({
              label,
              value,
              default: false,
            })),
          },
        ],
      },
    ],
  };
}

test("a long value stacks under its label and a short one stays beside it, each row with a copy icon that gives what the rule says", () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const image = "docker.io/kindest/local-path-helper:v20260131-7181c60a";
  const at = "2026-11-03T12:13:01Z";
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={fields(
        ["Image", { type: "code", text: image }],
        ["Phase", { type: "text", text: "Running" }],
        ["Started", { type: "time", at }],
        ["Pod IP", { type: "text", text: "" }],
      )}
      onOpen={() => undefined}
    />,
  );
  const labelOf = (name: string) => {
    const label = screen.getByText(name).closest("dt");
    if (!label) throw new Error(`no label ${name}`);
    return label;
  };
  expect(
    within(labelOf("Image")).getByRole("button", {
      name: "Copy value of Image",
    }),
  ).toBeTruthy();
  expect(within(labelOf("Phase")).queryByRole("button")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Copy value of Phase" }).closest("dd"),
  ).not.toBeNull();
  expect(
    screen.queryByRole("button", { name: "Copy value of Pod IP" }),
  ).toBeNull();
  for (const name of ["Image", "Started"]) {
    fireEvent.click(
      screen.getByRole("button", { name: `Copy value of ${name}` }),
    );
  }
  expect(writeText.mock.calls).toEqual([[image], [at]]);
});

test("Tab through the property rows stops at a section's toggle and at what a row holds, and at no copy icon", () => {
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={fields(
        ["Image", { type: "code", text: "docker.io/kindest/helper:v1" }],
        [
          "Owner",
          {
            type: "link",
            target: {
              group: "apps",
              version: "v1",
              kind: "ReplicaSet",
              namespace: "payments",
              name: "web-1",
            },
            text: "web-1",
          },
        ],
      )}
      onOpen={() => undefined}
    />,
  );
  expect(
    screen.getAllByRole("button", { name: /^Copy value of / }),
  ).toHaveLength(2);
  const stops = [
    ...document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex]",
    ),
  ]
    .filter((element) => element.tabIndex >= 0)
    .map(
      (element) => element.getAttribute("aria-label") ?? element.textContent,
    );
  expect(stops).toEqual(["Pod", "web-1"]);
});

test("a default that stacks keeps its support role and its tag, and its copy icon gives the value alone", () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const text = "a default long enough to stack under its label, past the forty";
  const page: Document = fields();
  const [section] = page.sections;
  if (!section) throw new Error("no section");
  render(
    <Overview
      {...PAGE}
      states={new OverviewStates()}
      kind="/pods"
      space="kind-test"
      overview={{
        ...page,
        sections: [
          {
            ...section,
            blocks: [
              {
                type: "fields",
                fields: [
                  {
                    label: "Policy",
                    value: { type: "text", text },
                    default: true,
                  },
                ],
              },
            ],
          },
        ],
      }}
      onOpen={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "1 default" }));
  const label = screen.getByText("Policy").closest("dt");
  const value = screen.getByText(text);
  expect(label?.querySelector("button")).not.toBeNull();
  expect(value.parentElement?.className).toContain("text-support");
  expect(value.parentElement?.textContent).toBe(`${text}default`);
  fireEvent.click(screen.getByRole("button", { name: "Copy value of Policy" }));
  expect(writeText).toHaveBeenCalledWith(text);
});
