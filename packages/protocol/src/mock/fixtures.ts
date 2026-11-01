import type { Column, Context, Space } from "../generated";

export const SPACES: Space[] = [
  {
    id: "prod-eu",
    name: "prod-eu",
    contexts: [{ name: "prod-eu", color: "red" }],
  },
  {
    id: "staging",
    name: "staging",
    contexts: [{ name: "staging", color: "orange" }],
  },
  { id: "dev", name: "dev", contexts: [{ name: "dev", color: "green" }] },
  {
    id: "dev+qa",
    name: "dev+qa",
    contexts: [
      { name: "dev", color: "green" },
      { name: "qa", color: null },
    ],
  },
];

/** The catalog: the contexts of the spaces, plus one that has no space yet. */
export const CONTEXTS: Context[] = [
  { name: "prod-eu", color: "red" },
  { name: "staging", color: "orange" },
  { name: "dev", color: "green" },
  { name: "qa", color: null },
  { name: "kind-local", color: null },
];

/** Each context's Kubernetes version, within the releases Twigo supports (D12). */
export const VERSIONS: Readonly<Record<string, string>> = {
  "prod-eu": "v1.33.4",
  staging: "v1.35.2",
  dev: "v1.37.0",
  qa: "v1.36.1",
  "kind-local": "v1.37.0",
};

/** Pods per context; dev has none, to show the empty state. */
export const POD_COUNT: Readonly<Record<string, number>> = {
  "prod-eu": 5000,
  staging: 800,
  dev: 0,
  qa: 120,
  "kind-local": 40,
};

/** The columns kube-apiserver sends for pods (crates/twigo-cache/tests/fixtures/pods-list.json). */
export const POD_COLUMNS: readonly Column[] = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Ready", kind: "string", priority: 0 },
  { name: "Status", kind: "string", priority: 0 },
  { name: "Restarts", kind: "string", priority: 0 },
  { name: "Age", kind: "age", priority: 0 },
  { name: "IP", kind: "string", priority: 1 },
  { name: "Node", kind: "string", priority: 1 },
  { name: "Nominated Node", kind: "string", priority: 1 },
  { name: "Readiness Gates", kind: "string", priority: 1 },
];

export const NAMESPACES = [
  "payments",
  "checkout",
  "search",
  "ledger",
  "notify",
  "platform",
  "monitoring",
  "ingress-nginx",
  "auth",
  "batch",
  "default",
  "kube-system",
];

export const WORKLOADS = [
  "api",
  "worker",
  "gateway",
  "billing",
  "indexer",
  "scheduler",
  "web",
  "sync",
  "exporter",
  "controller",
];
