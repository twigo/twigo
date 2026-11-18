import { expect, test } from "vitest";
import type {
  Container,
  Field,
  Overview,
  Section,
  TreeNode,
} from "@twigo/protocol";
import {
  compile,
  containerGroup,
  describeMatches,
  matchesIn,
  treeGroup,
  viewOf,
} from "./pageFilter";

const text = (value: string) => ({ type: "text" as const, text: value });
const field = (label: string, value: string, byDefault = false): Field => ({
  label,
  value: text(value),
  default: byDefault,
});

const POD: Section = {
  id: "core.pod",
  title: "Pod",
  summary: [],
  tone: null,
  fold: "open",
  blocks: [
    {
      type: "fields",
      fields: [
        field("Node", "worker-3"),
        field("Priority", "0", true),
        field("Restart policy", "Always", true),
        field("Service account", "default", true),
      ],
    },
  ],
};

const container: Container = {
  name: "api",
  role: "regular",
  image: "registry.example/api:1.2",
  state: null,
  ports: ["8080/TCP (http)"],
  fields: [field("Requests", "cpu 50m")],
  details: [field("Command", "serve")],
  env: [field("DB_HOST", "db.internal")],
  mounts: [field("/data", "volume data")],
};

const CONTAINERS: Section = {
  id: "core.containers",
  title: "Containers",
  summary: [],
  tone: null,
  fold: "open",
  blocks: [{ type: "containers", containers: [container] }],
};

const filterOf = (source: string) => {
  const { filter } = compile(source);
  if (!filter) throw new Error(`no filter for ${source}`);
  return filter;
};

test("without a filter the default fields hide, and show once revealed", () => {
  const hidden = viewOf(POD, null, false);
  expect(hidden.defaults).toBe(3);
  expect(hidden.folds).toBe(true);
  expect(hidden.blocks).toEqual([
    { type: "fields", fields: [field("Node", "worker-3")] },
  ]);
  const shown = viewOf(POD, null, true);
  expect(shown.blocks).toEqual(POD.blocks);
  expect(shown.defaults).toBe(3);
});

test("a section of nothing but defaults leaves no empty block, and a section without any offers no link", () => {
  const only: Section = {
    ...POD,
    blocks: [{ type: "fields", fields: [field("Priority", "0", true)] }],
  };
  expect(viewOf(only, null, false).blocks).toEqual([]);
  expect(viewOf(CONTAINERS, null, false).folds).toBe(false);
});

test("a match in the rows keeps those rows only, and finds a hidden default", () => {
  const view = viewOf(POD, filterOf("restart"), false);
  expect(view.blocks).toEqual([
    {
      type: "fields",
      fields: [field("Restart policy", "Always", true)],
    },
  ]);
  expect(view.matches).toBe(1);
  expect(view.folds).toBe(false);
});

test("a value matches as well as a label, in any case", () => {
  const view = viewOf(POD, filterOf("WORKER"), false);
  expect(view.matches).toBe(1);
  expect(view.blocks).toEqual([
    { type: "fields", fields: [field("Node", "worker-3")] },
  ]);
});

test("a section whose title matches stays whole, its defaults hidden as before", () => {
  const view = viewOf(POD, filterOf("pod"), false);
  expect(view.matches).toBe(1);
  expect(view.blocks).toEqual([
    { type: "fields", fields: [field("Node", "worker-3")] },
  ]);
  expect(view.folds).toBe(true);
});

test("a section with no match has none, and a negation keeps the rows that lack the text", () => {
  expect(viewOf(POD, filterOf("zzz"), false).matches).toBe(0);
  const view = viewOf(POD, filterOf("!zzz"), false);
  expect(view.matches).toBe(4);
  expect(view.blocks).toEqual(POD.blocks);
  const rest = viewOf(POD, filterOf("!worker"), false);
  expect(rest.matches).toBe(3);
  expect(rest.blocks).toEqual([
    {
      type: "fields",
      fields:
        POD.blocks[0]?.type === "fields" ? POD.blocks[0].fields.slice(1) : [],
    },
  ]);
});

const proxy: Container = {
  ...container,
  name: "proxy",
  image: "registry.example/proxy:2",
  ports: [],
  fields: [field("Requests", "cpu 10m")],
  details: [],
  env: [field("UPSTREAM", "api.internal")],
  mounts: [field("/etc/pod", "volume pod-info")],
};

const SIDECARS: Section = {
  ...CONTAINERS,
  blocks: [{ type: "containers", containers: [container, proxy] }],
};

const METADATA: Section = {
  id: "core.metadata",
  title: "Metadata",
  summary: [],
  tone: null,
  fold: "folded",
  blocks: [
    {
      type: "fields",
      fields: [field("Namespace", "payments"), field("Owner", "api-team")],
    },
  ],
};

const PAGE: Overview = {
  header: {
    owner: null,
    node: null,
    created: null,
    printed: [],
    sentence: [],
    vitals: [],
  },
  sections: [POD, SIDECARS, METADATA],
};

test("a negation drops a section whose title has the text, and the rows of a container whose name or image has it", () => {
  const filter = filterOf("!pod");
  expect(viewOf(POD, filter, false)).toEqual(
    expect.objectContaining({ matches: 0, blocks: [] }),
  );
  const view = viewOf(SIDECARS, filter, false);
  expect(view.matches).toBe(4 + 2);
  expect(matchesIn(PAGE, filter, false)).toEqual({ matches: 8, sections: 2 });
  const [first] = view.blocks;
  expect(
    first?.type === "containers" ? first.containers[1]?.mounts : [],
  ).toEqual([]);
});

test("a negation drops a container that has the text and the rows that have it, and keeps the others", () => {
  const filter = filterOf("!api");
  const view = viewOf(SIDECARS, filter, false);
  const [block] = view.blocks;
  expect(
    block?.type === "containers" ? block.containers.map((c) => c.name) : [],
  ).toEqual(["proxy"]);
  expect(view.matches).toBe(2);
  expect(viewOf(METADATA, filter, false).matches).toBe(1);
  expect(viewOf(POD, filter, false).matches).toBe(4);
  expect(matchesIn(PAGE, filter, false)).toEqual({ matches: 7, sections: 3 });
});

test("a negation of the section's title drops it, and one that the title lacks leaves an embedded list", () => {
  const pods: Section = {
    id: "core.pods",
    title: "Pods",
    summary: [],
    tone: null,
    fold: "open",
    blocks: [
      {
        type: "list",
        gvr: { group: "", version: "v1", resource: "pods" },
        kind: "Pod",
        namespaced: true,
        namespace: null,
        fieldSelector: null,
        owners: null,
      },
    ],
  };
  expect(viewOf(pods, filterOf("!pod"), false).matches).toBe(0);
  expect(viewOf(pods, filterOf("!api"), false).matches).toBe(1);
});

test("a container that matches by its name or image stays whole, else it keeps the rows of its groups that match", () => {
  const byName = viewOf(CONTAINERS, filterOf("api:1"), false);
  expect(byName.blocks).toEqual(CONTAINERS.blocks);
  expect(byName.matches).toBe(1);
  const byEnv = viewOf(CONTAINERS, filterOf("db_host"), false);
  expect(byEnv.matches).toBe(1);
  expect(byEnv.blocks).toEqual([
    {
      type: "containers",
      containers: [
        {
          ...container,
          fields: [],
          details: [],
          env: container.env,
          mounts: [],
        },
      ],
    },
  ]);
  expect(viewOf(CONTAINERS, filterOf("8080"), false).matches).toBe(1);
});

test("conditions, events, findings, keys, tables and trees keep their matching rows", () => {
  const section: Section = {
    id: "mixed",
    title: "Mixed",
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
            reason: "NotReady",
            message: "kubelet stopped",
            lastTransition: null,
            lastHeartbeat: null,
            explained: false,
          },
          {
            type: "Initialized",
            status: "True",
            tone: "success",
            reason: null,
            message: null,
            lastTransition: null,
            lastHeartbeat: null,
            explained: false,
          },
        ],
      },
      {
        type: "events",
        listed: true,
        unavailable: null,
        events: [
          {
            type: "Warning",
            reason: "BackOff",
            message: "restarting failed container",
            source: "kubelet",
            count: 5,
            first: null,
            last: null,
            fieldPath: null,
          },
          {
            type: "Normal",
            reason: "Pulled",
            message: "image present",
            source: "kubelet",
            count: 1,
            first: null,
            last: null,
            fieldPath: null,
          },
        ],
      },
      {
        type: "diagnostics",
        findings: [
          {
            tone: "danger",
            title: "Container api keeps crashing",
            detail: [text("Exited with code 1")],
            message: null,
            logs: null,
          },
        ],
      },
      {
        type: "data",
        readable: true,
        entries: [
          { key: "tls.crt", bytes: 3, binary: false },
          { key: "ca.crt", bytes: 3, binary: false },
        ],
      },
      {
        type: "table",
        columns: ["Name", "Type"],
        rows: [
          [text("data"), text("PersistentVolumeClaim")],
          [text("token"), text("Projected")],
        ],
      },
      {
        type: "tree",
        nodes: [
          {
            key: "spec",
            label: "Spec",
            value: {
              type: "map",
              entries: [
                {
                  key: "host",
                  label: "Host",
                  value: { type: "scalar", text: "example.org" },
                },
                {
                  key: "path",
                  label: "Path",
                  value: { type: "scalar", text: "/" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const count = (source: string) => viewOf(section, filterOf(source), false);
  expect(count("kubelet stopped").matches).toBe(1);
  expect(count("backoff").matches).toBe(1);
  expect(count("crashing").matches).toBe(1);
  expect(count("ca.crt").matches).toBe(1);
  expect(count("projected").matches).toBe(1);
  expect(count("example.org").matches).toBe(1);
  const tree = count("example.org").blocks[0];
  expect(tree).toEqual({
    type: "tree",
    nodes: [
      {
        key: "spec",
        label: "Spec",
        value: {
          type: "map",
          entries: [
            {
              key: "host",
              label: "Host",
              value: { type: "scalar", text: "example.org" },
            },
          ],
        },
      },
    ],
  });
});

test("an embedded list is found by its section's title only", () => {
  const section: Section = {
    id: "core.pods",
    title: "Pods",
    summary: [],
    tone: null,
    fold: "open",
    blocks: [
      {
        type: "list",
        gvr: { group: "", version: "v1", resource: "pods" },
        kind: "Pod",
        namespaced: true,
        namespace: null,
        fieldSelector: null,
        owners: null,
      },
    ],
  };
  expect(viewOf(section, filterOf("pods"), false).matches).toBe(1);
  expect(viewOf(section, filterOf("nginx"), false).matches).toBe(0);
});

test("a page counts its matching rows and the sections that hold them, the usage section by its title", () => {
  const overview: Overview = {
    header: {
      owner: null,
      node: null,
      created: null,
      printed: [],
      sentence: [],
      vitals: [],
    },
    sections: [POD, CONTAINERS],
  };
  expect(matchesIn(overview, filterOf("o"), false)).toEqual({
    matches:
      viewOf(POD, filterOf("o"), false).matches +
      viewOf(CONTAINERS, filterOf("o"), false).matches,
    sections: 2,
  });
  expect(matchesIn(overview, filterOf("db_host"), false)).toEqual({
    matches: 1,
    sections: 1,
  });
  expect(matchesIn(overview, filterOf("usage"), true)).toEqual({
    matches: 1,
    sections: 1,
  });
  expect(matchesIn(overview, filterOf("usage"), false)).toEqual({
    matches: 0,
    sections: 0,
  });
});

test("the count reads as a sentence", () => {
  expect(describeMatches(3, 2)).toBe("3 matches in 2 sections");
  expect(describeMatches(1, 1)).toBe("1 match in 1 section");
  expect(describeMatches(0, 0)).toBe("No matches");
  expect(describeMatches(3, 2, true)).toBe("3 in 2");
  expect(describeMatches(0, 0, true)).toBe("none");
});

test("text that keeps everything compiles to no filter, and an unclosed regex is plain text", () => {
  expect(compile("")).toEqual({ filter: null, invalid: false });
  expect(compile("!")).toEqual({ filter: null, invalid: false });
  expect(compile("/web-[").invalid).toBe(false);
  expect(compile("/web-[/")).toEqual({ filter: null, invalid: true });
});

const scalar = (key: string, value: string): TreeNode => ({
  key,
  label: key,
  value: { type: "scalar", text: value },
});

const map = (key: string, entries: TreeNode[]): TreeNode => ({
  key,
  label: key,
  value: { type: "map", entries },
});

const TREE: Section = {
  id: "core.spec",
  title: "Spec",
  summary: [],
  tone: null,
  fold: "open",
  blocks: [
    {
      type: "tree",
      nodes: [
        map("labels", [scalar("app", "api"), scalar("tier", "web")]),
        map("annotations", []),
        map("template", [map("spec", [scalar("host", "example.org")])]),
      ],
    },
  ],
};

const keys = (view: ReturnType<typeof viewOf>) => {
  const [block] = view.blocks;
  return block?.type === "tree"
    ? block.nodes.map(({ key, value }) => ({
        key,
        rows:
          value.type === "map" ? value.entries.map((entry) => entry.key) : [],
      }))
    : [];
};

test("a negation that the text is absent from keeps every group of a tree, an empty one too", () => {
  const view = viewOf(TREE, filterOf("!zzz"), false);
  expect(keys(view)).toEqual([
    { key: "labels", rows: ["app", "tier"] },
    { key: "annotations", rows: [] },
    { key: "template", rows: ["spec"] },
  ]);
  expect(view.matches).toBe(4);
});

test("a negation drops the row of a tree that has the text and the group that is named for it, and keeps the rest", () => {
  const row = viewOf(TREE, filterOf("!api"), false);
  expect(keys(row)).toEqual([
    { key: "labels", rows: ["tier"] },
    { key: "annotations", rows: [] },
    { key: "template", rows: ["spec"] },
  ]);
  expect(row.matches).toBe(3);
  const empty = viewOf(TREE, filterOf("!annotations"), false);
  expect(keys(empty).map(({ key }) => key)).toEqual(["labels", "template"]);
  const named = viewOf(TREE, filterOf("!labels"), false);
  expect(keys(named).map(({ key }) => key)).toEqual([
    "annotations",
    "template",
  ]);
  expect(named.matches).toBe(2);
});

test("a group draws open only where the filter narrowed its rows: not one kept whole by its name or its section's title, and under a negation only one it took rows from", () => {
  const narrowed = (source: string) => [
    ...viewOf(TREE, filterOf(source), false).narrowed,
  ];
  expect(narrowed("example.org")).toEqual([
    treeGroup(["template", "spec"]),
    treeGroup(["template"]),
  ]);
  expect(narrowed("labels")).toEqual([]);
  expect(narrowed("spec")).toEqual([]);
  expect(narrowed("!zzz")).toEqual([]);
  expect(narrowed("!api")).toEqual([treeGroup(["labels"])]);
  expect(narrowed("!host")).toEqual([]);
  expect([...viewOf(TREE, null, false).narrowed]).toEqual([]);
});

test("a container's groups draw open only where the filter narrowed their rows: not for a container kept whole by its name, and under a negation only for one it took rows from", () => {
  const two: Container = {
    ...container,
    env: [field("DB_HOST", "db.internal"), field("LOG", "info")],
  };
  const section: Section = {
    ...CONTAINERS,
    blocks: [{ type: "containers", containers: [two] }],
  };
  const narrowed = (source: string, of = section) => [
    ...viewOf(of, filterOf(source), false).narrowed,
  ];
  const env = containerGroup("api", "Environment");
  expect(narrowed("db_host")).toEqual([env]);
  expect(narrowed("api:1")).toEqual([]);
  expect(narrowed("!zzz")).toEqual([]);
  expect(narrowed("!db_host")).toEqual([env]);
  expect(narrowed("containers")).toEqual([]);
});
