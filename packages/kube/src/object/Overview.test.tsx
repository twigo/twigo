import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Overview as Document } from "@twigo/protocol";
import { Overview } from "./Overview";

afterEach(() => {
  cleanup();
});

const KEYS = 2000;

function configMap(): Document {
  return {
    sections: [
      {
        id: "core.data",
        title: "Data",
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
      space="kind-test"
      overview={configMap()}
      onOpen={() => undefined}
      values={values}
    />,
  );
  expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(KEYS);
  expect(document.body.textContent).not.toContain("value of");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /key-1500/ }));
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
      space="kind-test"
      overview={{
        sections: [
          {
            id: "core.metadata",
            title: "Metadata",
            blocks: [
              {
                type: "fields",
                fields: [
                  {
                    label: "Controlled by",
                    value: { type: "link", target, text: "ReplicaSet/web-1" },
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

test("a section folds by its title", () => {
  render(
    <Overview
      space="kind-test"
      overview={configMap()}
      onOpen={() => undefined}
    />,
  );
  expect(screen.getByText("key-0")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Data" }));
  expect(screen.queryByText("key-0")).toBeNull();
});

function data(readable: boolean, bytes = 3): Document {
  return {
    sections: [
      {
        id: "core.data",
        title: "Data",
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
      space="kind-test"
      overview={{
        sections: [
          {
            id: "core.events",
            title: "Events",
            blocks: [
              {
                type: "events",
                events: [],
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

test("a multiline value keeps its lines", () => {
  render(
    <Overview
      space="kind-test"
      overview={{
        sections: [
          {
            id: "core.spec",
            title: "Spec",
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
      space="kind-test"
      overview={{
        sections: [
          {
            id: "core.conditions",
            title: "Conditions",
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
                  },
                  {
                    type: "PodScheduled",
                    status: "True",
                    tone: "success",
                    reason: null,
                    message: null,
                    lastTransition: AT,
                    lastHeartbeat: null,
                  },
                  {
                    type: "DisruptionTarget",
                    status: "True",
                    tone: "warning",
                    reason: "EvictionByEvictionAPI",
                    message: null,
                    lastTransition: AT,
                    lastHeartbeat: null,
                  },
                  {
                    type: "Initialized",
                    status: "False",
                    tone: "danger",
                    reason: null,
                    message: null,
                    lastTransition: AT,
                    lastHeartbeat: null,
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
    [...document.querySelectorAll("p")].map((reason) => reason.textContent),
  ).toEqual([
    "Ready · ContainersNotReadycontainers with unready status: [api]",
    "DisruptionTarget · EvictionByEvictionAPI",
  ]);
});
