import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type {
  Container,
  Field,
  Overview as Document,
  Section,
  TreeNode,
} from "@twigo/protocol";
import { Overview } from "./Overview";
import { OverviewStates } from "./overviewStates";
import { PageStates } from "./pageStates";

afterEach(() => {
  cleanup();
});

const URI = "k8s://editor";

const field = (label: string, value: string, byDefault = false): Field => ({
  label,
  value: { type: "text", text: value },
  default: byDefault,
});

function section(
  id: string,
  title: string,
  fold: Section["fold"],
  fields: Field[],
  summary = "",
): Section {
  return {
    id,
    title,
    summary: summary ? [{ type: "text", text: summary }] : [],
    tone: null,
    fold,
    blocks: [{ type: "fields", fields }],
  };
}

function doc(
  overrides: Partial<Record<string, Section["fold"]>> = {},
): Document {
  return {
    header: {
      owner: null,
      node: null,
      created: null,
      printed: [],
      sentence: [],
      vitals: [],
    },
    sections: [
      section(
        "core.pod",
        "Pod",
        overrides["core.pod"] ?? "open",
        [
          field("Node", "worker-3"),
          field("Priority", "0", true),
          field("Restart policy", "Always", true),
          field("DNS policy", "ClusterFirst", true),
        ],
        "Running",
      ),
      section(
        "core.conditions",
        "Conditions",
        overrides["core.conditions"] ?? "folded",
        [field("Ready", "True")],
        "1 of 1 true",
      ),
      section(
        "core.metadata",
        "Metadata",
        overrides["core.metadata"] ?? "folded",
        [field("Namespace", "payments"), field("UID", "restart-1")],
        "2 labels",
      ),
    ],
  };
}

function shown(
  overview: Document,
  {
    states = new OverviewStates(),
    pages = new PageStates(),
    object = "payments/web-1",
    space = "prod-eu",
  } = {},
) {
  const view = render(
    <Overview
      overview={overview}
      space={space}
      states={states}
      pages={pages}
      uri={URI}
      kind="/pods"
      object={object}
      onOpen={() => undefined}
    />,
  );
  return { states, pages, view };
}

const header = (title: string) =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });
const opened = (title: string) =>
  header(title).getAttribute("aria-expanded") === "true";

test("a section opens as its fold says, and says what it holds while it is folded", () => {
  shown(doc());
  expect(opened("Pod")).toBe(true);
  expect(opened("Conditions")).toBe(false);
  expect(header("Conditions").textContent).toContain("1 of 1 true");
  expect(screen.queryByText("True")).toBeNull();
});

test("what the person chose is kept for the kind: a folded section stays open for its next object", () => {
  const states = new OverviewStates();
  const first = shown(doc(), { states });
  fireEvent.click(header("Conditions"));
  fireEvent.click(header("Pod"));
  expect(opened("Conditions")).toBe(true);
  expect(opened("Pod")).toBe(false);
  first.view.unmount();
  shown(doc(), { states, object: "payments/web-2" });
  expect(opened("Conditions")).toBe(true);
  expect(opened("Pod")).toBe(false);
});

test("a fold the person chose is open or folded, not a change of a fold that differs between objects", () => {
  const states = new OverviewStates();
  const first = shown(doc({ "core.conditions": "open" }), { states });
  expect(opened("Conditions")).toBe(true);
  fireEvent.click(header("Conditions"));
  first.view.unmount();
  const second = shown(doc({ "core.conditions": "folded" }), {
    states,
    object: "payments/web-2",
  });
  expect(opened("Conditions")).toBe(false);
  fireEvent.click(header("Metadata"));
  second.view.unmount();
  shown(doc({ "core.metadata": "open" }), {
    states,
    object: "payments/web-3",
  });
  expect(opened("Metadata")).toBe(true);
  expect(opened("Conditions")).toBe(false);
});

test("a finding opens over a fold the person kept, and the person can still fold it while it is shown", () => {
  const states = new OverviewStates();
  const first = shown(doc(), { states });
  fireEvent.click(header("Pod"));
  expect(opened("Pod")).toBe(false);
  first.view.unmount();
  const finding = shown(doc({ "core.pod": "finding" }), { states });
  expect(opened("Pod")).toBe(true);
  fireEvent.click(header("Pod"));
  expect(opened("Pod")).toBe(false);
  finding.view.unmount();
  const other = shown(doc({ "core.pod": "finding" }), {
    states,
    object: "payments/web-2",
  });
  expect(opened("Pod")).toBe(true);
  other.view.unmount();
  shown(doc({ "core.pod": "finding" }), { states, space: "staging" });
  expect(opened("Pod")).toBe(true);
});

test("Alt-click folds every section, then opens every section", () => {
  shown(doc());
  fireEvent.click(header("Pod"), { altKey: true });
  expect(["Pod", "Conditions", "Metadata"].map(opened)).toEqual([
    false,
    false,
    false,
  ]);
  fireEvent.click(header("Pod"), { altKey: true });
  expect(["Pod", "Conditions", "Metadata"].map(opened)).toEqual([
    true,
    true,
    true,
  ]);
});

test("default fields hide behind their count, show with a tag, and the choice is kept for the kind", () => {
  const states = new OverviewStates();
  const first = shown(doc(), { states });
  expect(screen.getByText("Node")).toBeTruthy();
  expect(screen.queryByText("Priority")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "3 defaults" }));
  expect(screen.getByText("Priority")).toBeTruthy();
  expect(screen.getAllByText("default")).toHaveLength(3);
  expect(screen.getByText("ClusterFirst").parentElement?.className).toContain(
    "text-support",
  );
  first.view.unmount();
  shown(doc(), { states, object: "payments/web-2" });
  expect(screen.getByText("Priority")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide defaults" }));
  expect(screen.queryByText("Priority")).toBeNull();
  expect(screen.getByRole("button", { name: "3 defaults" })).toBeTruthy();
});

test("a section without a default offers no link", () => {
  shown(doc());
  fireEvent.click(header("Metadata"));
  expect(
    within(screen.getByRole("region", { name: "Metadata" })).queryByRole(
      "button",
      { name: /default/ },
    ),
  ).toBeNull();
});

test("the filter opens the sections that match, hides the others and the rows that do not, and finds a hidden default", () => {
  const { pages } = shown(doc());
  act(() => {
    pages.setText(URI, "restart");
  });
  expect(screen.queryByRole("region", { name: "Conditions" })).toBeNull();
  expect(opened("Pod")).toBe(true);
  expect(opened("Metadata")).toBe(true);
  expect(screen.getByText("Restart policy")).toBeTruthy();
  expect(screen.getByText("restart-1")).toBeTruthy();
  expect(screen.queryByText("Node")).toBeNull();
  expect(screen.queryByText("Namespace")).toBeNull();
  expect(screen.queryByRole("button", { name: /defaults/ })).toBeNull();
});

test("clearing the text brings back the folds from before, and no match says so in the page", () => {
  const { pages } = shown(doc());
  act(() => {
    pages.setText(URI, "restart");
  });
  expect(opened("Metadata")).toBe(true);
  act(() => {
    pages.setText(URI, "");
  });
  expect(opened("Metadata")).toBe(false);
  expect(opened("Pod")).toBe(true);
  expect(screen.getByRole("region", { name: "Conditions" })).toBeTruthy();
  act(() => {
    pages.setText(URI, "zzz");
  });
  expect(screen.queryByRole("region")).toBeNull();
  expect(screen.getByText(/Nothing here matches/)).toBeTruthy();
});

test("a section the person folds while the filter holds text opens again with the next text, and the kind's folds stay as they were", () => {
  const { pages, states } = shown(doc());
  act(() => {
    pages.setText(URI, "restart");
  });
  fireEvent.click(header("Metadata"));
  expect(opened("Metadata")).toBe(false);
  act(() => {
    pages.setText(URI, "restart-");
  });
  expect(opened("Metadata")).toBe(true);
  act(() => {
    pages.setText(URI, "");
  });
  expect(
    states.section("/pods", "payments/web-1", "core.metadata", "folded"),
  ).toBe(false);
});

test("Enter in the field moves the focus to the first section with a match", () => {
  const { pages } = shown(doc());
  act(() => {
    pages.setText(URI, "restart");
    pages.goToMatch(URI);
  });
  expect(document.activeElement).toBe(header("Pod"));
  expect(pages.wantsMatch(URI)).toBe(false);
});

const scalar = (key: string, text: string): TreeNode => ({
  key,
  label: key,
  value: { type: "scalar", text },
});

const group = (key: string, entries: TreeNode[]): TreeNode => ({
  key,
  label: key,
  value: { type: "map", entries },
});

const nested: Document = {
  header: {
    owner: null,
    node: null,
    created: null,
    printed: [],
    sentence: [],
    vitals: [],
  },
  sections: [
    {
      id: "core.containers",
      title: "Containers",
      summary: [],
      tone: null,
      fold: "open",
      blocks: [
        {
          type: "containers",
          containers: [
            {
              name: "api",
              role: "regular",
              image: "registry.example/api:1",
              state: null,
              ports: [],
              fields: [],
              details: [],
              env: [field("POD_IP", "10.0.0.7"), field("LOG", "info")],
              mounts: [],
            } satisfies Container,
          ],
        },
      ],
    },
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
            group("template", [
              group("spec", [group("hostAliases", [scalar("ip", "10.0.0.9")])]),
            ]),
          ],
        },
      ],
    },
  ],
};

const groupButton = (name: RegExp) => screen.getByRole("button", { name });

test("a group that kept rows draws open while the filter holds text, and the person's choice for it lasts only with that text, never in the kind's folds", () => {
  const { pages, states } = shown(nested);
  expect(screen.queryByText("POD_IP")).toBeNull();
  expect(screen.queryByText("10.0.0.9")).toBeNull();
  act(() => {
    pages.setText(URI, "10.0.0");
  });
  expect(screen.getByText("10.0.0.9")).toBeTruthy();
  fireEvent.click(groupButton(/^hostAliases/));
  expect(screen.queryByText("10.0.0.9")).toBeNull();
  act(() => {
    pages.setText(URI, "10.0.0.");
  });
  expect(screen.getByText("10.0.0.9")).toBeTruthy();
  act(() => {
    pages.setText(URI, "pod_ip");
  });
  expect(screen.getByText("POD_IP")).toBeTruthy();
  expect(screen.queryByText("LOG")).toBeNull();
  expect(groupButton(/^Environment/).getAttribute("aria-expanded")).toBe(
    "true",
  );
  fireEvent.click(groupButton(/^Environment/));
  expect(groupButton(/^Environment/).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(screen.queryByText("POD_IP")).toBeNull();
  expect(states.open("/pods", "containers/api/Environment", false)).toBe(false);
  fireEvent.click(groupButton(/^Environment/));
  expect(screen.getByText("POD_IP")).toBeTruthy();
  fireEvent.click(groupButton(/^Environment/));
  act(() => {
    pages.setText(URI, "pod_i");
  });
  expect(screen.getByText("POD_IP")).toBeTruthy();
  act(() => {
    pages.setText(URI, "");
  });
  expect(screen.queryByText("POD_IP")).toBeNull();
  expect(states.open("/pods", "containers/api/Environment", false)).toBe(false);
});

test("a group kept whole by its section's title, a container's name or its own name, or by a negation that took nothing from it, keeps its fold", () => {
  const { pages } = shown(nested);
  const folded = () =>
    screen.queryByText("POD_IP") === null &&
    screen.queryByText("10.0.0.9") === null;
  for (const text of [
    "spec",
    "containers",
    "registry.example",
    "hostaliases",
    "!zzz",
  ]) {
    act(() => {
      pages.setText(URI, text);
    });
    expect(folded(), `${text} leaves a group folded or its rows hidden`).toBe(
      true,
    );
  }
  act(() => {
    pages.setText(URI, "!log");
  });
  expect(screen.getByText("POD_IP")).toBeTruthy();
  expect(screen.queryByText("LOG")).toBeNull();
});
