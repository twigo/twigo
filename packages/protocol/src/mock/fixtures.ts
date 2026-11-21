import type {
  Column,
  Context,
  ContextAccess,
  Environment,
  Mode,
  Space,
} from "../generated";

export const SPACES: Space[] = [
  { id: "prod-eu", name: "prod-eu", contexts: ["prod-eu"] },
  { id: "staging", name: "staging", contexts: ["staging"] },
  { id: "dev", name: "dev", contexts: ["dev"] },
];

/** A context nobody marked: guarded until the person says what it is. */
export const UNMARKED: ContextAccess = {
  mode: "guarded",
  source: { kind: "unmarked" },
  environment: null,
  unlockedUntil: null,
};

/** The contexts whose kubeconfig says `twigo.readOnly: true`. */
export const KUBECONFIG_READ_ONLY: ReadonlySet<string> = new Set(["analytics"]);

/** The modes the person chose before the app started. */
export const CHOSEN: Readonly<Record<string, Mode>> = {
  analytics: "read-write",
};

/**
 * The types the contexts' kubeconfigs say, where they lock: Production and
 * Staging. A kubeconfig that says Development or Local locks nothing and
 * marks nothing, so such a context is unmarked until the person marks it.
 */
export const KUBECONFIG_TYPES: Readonly<
  Record<string, Extract<Environment, "production" | "staging">>
> = {
  "prod-eu": "production",
  staging: "staging",
};

/** The types the person marked before the app started. */
export const MARKED: Readonly<Record<string, Environment>> = {
  dev: "development",
  "kind-local": "local",
};

/** The spaces of the `protection` scenario: a context nobody marked, and one whose kubeconfig's lock the person set aside. */
export const PROTECTION_SPACES: Space[] = [
  { id: "qa", name: "qa", contexts: ["qa"] },
  { id: "analytics", name: "analytics", contexts: ["analytics"] },
];

/** The catalog: the contexts of the spaces, plus three that have none yet, from two files. */
export const CONTEXTS: Context[] = [
  {
    name: "prod-eu",
    color: "red",
    source: "~/.kube/config",
    server: "https://4f2a9c1e7b.gr7.eu-west-1.eks.amazonaws.com",
    namespace: null,
    access: {
      mode: "read-only",
      source: { kind: "environment", environment: "production" },
      environment: "production",
      unlockedUntil: null,
    },
  },
  {
    name: "staging",
    color: "orange",
    source: "~/.kube/config",
    server: "https://9d3e1b7c0a.yl4.eu-west-1.eks.amazonaws.com",
    namespace: null,
    access: {
      mode: "guarded",
      source: { kind: "environment", environment: "staging" },
      environment: "staging",
      unlockedUntil: null,
    },
  },
  {
    name: "dev",
    color: "green",
    source: "~/.kube/config",
    server: "https://34.141.62.18",
    namespace: null,
    access: {
      mode: "read-write",
      source: { kind: "environment", environment: "development" },
      environment: "development",
      unlockedUntil: null,
    },
  },
  {
    name: "qa",
    color: null,
    source: "~/.kube/config",
    server: "https://qa.internal:6443",
    namespace: null,
    access: UNMARKED,
  },
  {
    name: "analytics",
    color: null,
    source: "~/.kube/config",
    server: "https://analytics.internal:6443",
    namespace: "batch",
    access: {
      mode: "read-write",
      source: {
        kind: "user",
        overrides: { mode: "read-only", source: { kind: "kubeconfig" } },
      },
      environment: null,
      unlockedUntil: null,
    },
  },
  {
    name: "kind-local",
    color: null,
    source: "~/.kube/kind.yaml",
    server: "https://127.0.0.1:52144",
    namespace: null,
    access: {
      mode: "read-write",
      source: { kind: "environment", environment: "local" },
      environment: "local",
      unlockedUntil: null,
    },
  },
];

/** Each context's Kubernetes version, within the releases Twigo supports (D12). */
export const VERSIONS: Readonly<Record<string, string>> = {
  "prod-eu": "v1.33.4",
  staging: "v1.35.2",
  dev: "v1.37.0",
  qa: "v1.36.1",
  analytics: "v1.36.1",
  "kind-local": "v1.37.0",
};

/**
 * The lists each context's credentials may not read in the live scenario:
 * prod-eu's read-only role may not list nodes, as roles bound in one
 * namespace never may.
 */
export const FORBIDDEN: Readonly<Record<string, readonly string[]>> = {
  "prod-eu": ["nodes"],
};

/** Pods per context; dev has none, to show the empty state. */
export const POD_COUNT: Readonly<Record<string, number>> = {
  "prod-eu": 5000,
  staging: 800,
  dev: 0,
  qa: 120,
  analytics: 60,
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

/** The columns kube-apiserver sends for nodes (crates/twigo-cache/tests/fixtures/nodes-list.json). */
export const NODE_COLUMNS: readonly Column[] = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Status", kind: "string", priority: 0 },
  { name: "Roles", kind: "string", priority: 0 },
  { name: "Age", kind: "age", priority: 0 },
  { name: "Version", kind: "string", priority: 0 },
  { name: "Internal-IP", kind: "string", priority: 1 },
  { name: "External-IP", kind: "string", priority: 1 },
  { name: "OS-Image", kind: "string", priority: 1 },
  { name: "Kernel-Version", kind: "string", priority: 1 },
  { name: "Container-Runtime", kind: "string", priority: 1 },
];

/**
 * The columns kube-apiserver sends for Deployments
 * (crates/twigo-cache/tests/fixtures/deployments-list.json): Up-to-date and
 * Available are declared strings and sent as integers.
 */
export const DEPLOYMENT_COLUMNS: readonly Column[] = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Ready", kind: "string", priority: 0 },
  { name: "Up-to-date", kind: "string", priority: 0 },
  { name: "Available", kind: "string", priority: 0 },
  { name: "Age", kind: "age", priority: 0 },
  { name: "Containers", kind: "string", priority: 1 },
  { name: "Images", kind: "string", priority: 1 },
  { name: "Selector", kind: "string", priority: 1 },
];

/** The columns kube-apiserver sends for Jobs (printers.go in kubernetes v1.37.1). */
export const JOB_COLUMNS: readonly Column[] = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Status", kind: "string", priority: 0 },
  { name: "Completions", kind: "string", priority: 0 },
  { name: "Duration", kind: "string", priority: 0 },
  { name: "Age", kind: "age", priority: 0 },
  { name: "Containers", kind: "string", priority: 1 },
  { name: "Images", kind: "string", priority: 1 },
  { name: "Selector", kind: "string", priority: 1 },
];

/** The columns kube-apiserver sends for CronJobs (crates/twigo-cache/tests/fixtures/cronjobs-list.json). */
export const CRONJOB_COLUMNS: readonly Column[] = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Schedule", kind: "string", priority: 0 },
  { name: "Timezone", kind: "string", priority: 0 },
  { name: "Suspend", kind: "boolean", priority: 0 },
  { name: "Active", kind: "integer", priority: 0 },
  { name: "Last Schedule", kind: "string", priority: 0 },
  { name: "Age", kind: "age", priority: 0 },
  { name: "Containers", kind: "string", priority: 1 },
  { name: "Images", kind: "string", priority: 1 },
  { name: "Selector", kind: "string", priority: 1 },
];

/**
 * The columns kube-apiserver sends for core events
 * (crates/twigo-cache/tests/fixtures/events-list.json): no Age, Name last
 * and wide only, Count declared a string and sent as an integer.
 */
export const EVENT_COLUMNS: readonly Column[] = [
  { name: "Last Seen", kind: "string", priority: 0 },
  { name: "Type", kind: "string", priority: 0 },
  { name: "Reason", kind: "string", priority: 0 },
  { name: "Object", kind: "string", priority: 0 },
  { name: "Subobject", kind: "string", priority: 1 },
  { name: "Source", kind: "string", priority: 1 },
  { name: "Message", kind: "string", priority: 0 },
  { name: "First Seen", kind: "string", priority: 1 },
  { name: "Count", kind: "string", priority: 1 },
  { name: "Name", kind: "string", priority: 1 },
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
