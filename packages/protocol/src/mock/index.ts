import type {
  Backend,
  MessageOf,
  PlainCommand,
  RequestOf,
  ResponseOf,
  SubscriptionCommand,
} from "../backend";
import { IpcError } from "../error";
import type {
  Column,
  KeyboardLayout,
  ListBatch,
  MetricsState,
  RowId,
  ShellEnvironment,
  ShellKind,
  ShellTarget,
  TerminalKind,
  ViewState,
} from "../generated";
import { MockAccess } from "./access";
import {
  APPROVAL_SCENARIOS,
  isApprovalScenario,
  MockApprovals,
  type ApprovalScenario,
} from "./approvals";
import { MockBus } from "./bus";
import {
  AUTH_SCENARIOS,
  isAuthScenario,
  MockAuth,
  type AuthScenario,
} from "./auth";
import { Cluster } from "./cluster";
import {
  FORWARD_SCENARIOS,
  isForwardScenario,
  MockForwards,
  type ForwardScenario,
} from "./forward";
import {
  APPLIED_LAG_MS,
  EDIT_SCENARIOS,
  isEditScenario,
  MockEdits,
  PINNED_ANSWERS,
  type EditScenario,
} from "./edits";
import { KINDS, wireRow, type MockKind, type MockRow } from "./kinds";
import { CLUSTER_STREAMS } from "../logs";
import { MockLogs } from "./logs";
import {
  isMetricsScenario,
  METRIC_COLUMNS,
  METRICS_GROUP,
  METRICS_SCENARIOS,
  metricsAt,
  MetricsJoin,
  MockMetrics,
  type MetricsScenario,
} from "./metrics";
import { MockObject } from "./objects";
import {
  isShellScenario,
  joins,
  MockShell,
  shellContainers,
  SHELL_SCENARIOS,
  type ShellScenario,
} from "./shell";
import {
  isTerminalScenario,
  keepsKubeconfig,
  MockOffers,
  type TerminalShell,
  MockTerminal,
  terminalKind,
  TERMINAL_SCENARIOS,
  type TerminalScenario,
} from "./terminal";
import { recordedSchema } from "./schemas";
import {
  CONTEXTS,
  FORBIDDEN,
  NAMESPACES,
  POD_COUNT,
  SPACES,
  VERSIONS,
} from "./fixtures";
import dvorak from "./layouts/dvorak.json";
import french from "./layouts/french.json";
import german from "./layouts/german.json";
import ukrainian from "./layouts/ukrainian.json";
import us from "./layouts/us.json";
import RESOURCES from "./resources.json";
import {
  compileQuery,
  isMetric,
  queryColumns,
  runQuery,
  type CompiledQuery,
  type QueryResult,
} from "./query";

export { FIRST_ASK_MS, NEXT_ASK_MS, WITHDRAWN_AFTER_MS } from "./approvals";
export {
  BLOCKED_AFTER_MS,
  FAILS_AFTER_MS,
  FIRST_CONNECTION_AFTER_MS,
  LIFTS_AFTER_MS,
  LOSES_POD_AFTER_MS,
  READY_AFTER_MS,
  RECONNECTS_FOR_MS,
} from "./forward";
export { OFFER_AFTER_MS } from "./terminal";
export { APPLIED_LAG_MS } from "./edits";
export { UNMARKED } from "./fixtures";
export { SCRAPE_MS } from "./metrics";

/**
 * `live` connects, syncs and then changes pods every second, and refuses
 * the lists `FORBIDDEN` names; any other value pins that state.
 */
type ListScenario = "live" | ViewState["state"];

/**
 * A list scenario, `shellTimeout`: live lists while the login shell's
 * environment timed out, `policyFile`: live lists with an admin's policy
 * file over `prod-*` that also sends `dev`'s terminal through the proxy,
 * `viewer`: live lists for a person who may only read,
 * or a pinned state of prod-eu's credentials, or what `apply_preview` answers
 * to an edit (`applyConflicts`), or an open object that changes on its own
 * (`serverChange`, `statusChange`), or one that an apply leaves late
 * (`applyLate`), or `rbacNamespaces`: live lists for a person whose
 * RoleBindings reach only the namespace `default`, so a cluster-wide list
 * and one of any other namespace are forbidden, or live lists for a shell
 * that waits, finds no shell, loses its connection or its write mode, or
 * runs one container (`shellQueued` and the like), or live lists while
 * processes ask the window to allow what they do (`approval` and the like),
 * or while a tool writes into a terminal's own kubeconfig (`terminalOffer`),
 * or while port-forwards are busy, lose their pod, fail, queue, come back
 * from an earlier run or are forbidden (`forwardBusy` and the like), or
 * while the context's Metrics API is not served, does not answer or refuses
 * the person (`metricsNone` and the like).
 */
export type MockScenario =
  | ListScenario
  | "shellTimeout"
  | "policyFile"
  | "viewer"
  | "rbacNamespaces"
  | AuthScenario
  | EditScenario
  | ShellScenario
  | ApprovalScenario
  | TerminalScenario
  | ForwardScenario
  | MetricsScenario;

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "live",
  "shellTimeout",
  "policyFile",
  "viewer",
  "rbacNamespaces",
  ...AUTH_SCENARIOS,
  ...EDIT_SCENARIOS,
  ...SHELL_SCENARIOS,
  ...APPROVAL_SCENARIOS,
  ...TERMINAL_SCENARIOS,
  ...FORWARD_SCENARIOS,
  ...METRICS_SCENARIOS,
  "queued",
  "connecting",
  "syncing",
  "ready",
  "relisting",
  "stale",
  "forbidden",
  "unauthorized",
  "error",
];

/** Keyboard layouts recorded on macOS by `cargo run -p twigo-keyboard --example record`. */
export const MOCK_LAYOUTS = [
  "us",
  "ukrainian",
  "german",
  "french",
  "dvorak",
] as const;

export type MockLayout = (typeof MOCK_LAYOUTS)[number];

const LAYOUTS: Readonly<Record<MockLayout, KeyboardLayout>> = {
  us,
  ukrainian,
  german,
  french,
  dvorak,
};

/** What twigo-env reported for a `.zshrc` of `echo "Loading nvm…"; sleep 60` (2026-11-01). */
const SHELL_TIMEOUT: ShellEnvironment = {
  state: "failed",
  shell: "/bin/zsh",
  reason: "did not answer in 10 s",
  output: "Loading nvm…\n",
};

const RETRY_MS = 1500;
const FLUSH_MS = 50;
const CHURN_MS = 1000;
const RATE_TICK_MS = 100;

/**
 * Runs the UI in a plain browser on fixtures (ARCHITECTURE 2.3): spaces,
 * pods, their nodes, Deployments and events behind a query view with the
 * same windowing and flow control as Rust, and a keyboard layout that never
 * changes.
 *
 * A live list changes pods every second, more of them where they are on
 * screen; with `changesPerSecond`, each cluster changes that many random
 * pods a second instead, counted on wall time, as the bench's churn does.
 */
export function createMockBackend(
  scenario: MockScenario = "live",
  layout: MockLayout = "us",
  changesPerSecond?: number,
): Backend {
  const now = Date.now();
  const pinsAuth = isAuthScenario(scenario);
  const lists: ListScenario =
    scenario === "shellTimeout" ||
    scenario === "policyFile" ||
    scenario === "viewer" ||
    scenario === "rbacNamespaces" ||
    isAuthScenario(scenario) ||
    isEditScenario(scenario) ||
    isShellScenario(scenario) ||
    isApprovalScenario(scenario) ||
    isTerminalScenario(scenario) ||
    isForwardScenario(scenario) ||
    isMetricsScenario(scenario)
      ? "live"
      : scenario;
  const metrics = new MockMetrics(
    isMetricsScenario(scenario) ? scenario : undefined,
  );
  const auth = new MockAuth(pinsAuth ? scenario : undefined);
  const access = new MockAccess(scenario === "policyFile");
  const approvals = new MockApprovals(
    isApprovalScenario(scenario) ? scenario : undefined,
  );
  const offers = new MockOffers(
    isTerminalScenario(scenario) ? scenario : undefined,
  );
  // The delete of a Pod in prod-eu asks only because its lock was lifted.
  if (isApprovalScenario(scenario)) access.unlock("prod-eu");
  const resolved: ShellEnvironment =
    scenario === "shellTimeout" ? SHELL_TIMEOUT : { state: "resolved" };
  let environment = resolved;
  const environmentWatchers = new Set<(next: ShellEnvironment) => void>();
  const setEnvironment = (next: ShellEnvironment) => {
    environment = next;
    for (const watcher of environmentWatchers) watcher(next);
  };
  const clusters = new Map<string, Cluster>();
  const subscriptions = new Map<number, Subscription>();
  const spaces = [...SPACES];
  const appState = new Map<string, string>();
  const spaceState = new Map<string, Map<string, string>>();
  let nextId = 1;
  let churn: ReturnType<typeof setInterval> | undefined;

  const cluster = (context: string) => {
    let found = clusters.get(context);
    if (!found) {
      found = new Cluster(context, POD_COUNT[context] ?? 0, now);
      clusters.set(context, found);
    }
    return found;
  };

  const space = (id: string) => {
    const found = spaces.find((candidate) => candidate.id === id);
    if (!found) throw new IpcError("notFound", `no space ${id}`);
    return found;
  };

  const forwards = new MockForwards(
    isForwardScenario(scenario) ? scenario : undefined,
    {
      context: (id) =>
        spaces.find((candidate) => candidate.id === id)?.contexts[0],
      cluster,
      forbid: (context) => {
        access.lockByFile(context);
      },
      lift: (context) => {
        access.liftFile(context);
      },
      access: (context) => access.of(context),
    },
  );

  const subscription = (id: number) => {
    const found = subscriptions.get(id);
    if (!found) throw new IpcError("notFound", `no subscription ${id}`);
    return found;
  };

  const shellScenario = isShellScenario(scenario) ? scenario : undefined;
  const shells = new Map<
    number,
    { target: ShellTarget; kind: ShellKind; shell?: MockShell }
  >();
  const shellOf = (id: number) => {
    const found = shells.get(id);
    if (!found) throw new IpcError("notFound", `no session ${id}`);
    return found;
  };
  const terminals = new Map<
    number,
    {
      context: string;
      label: string;
      kind: TerminalKind;
      shell: TerminalShell;
      terminal?: MockTerminal;
    }
  >();
  const running = (id: number) => {
    const parked = terminals.get(id);
    if (parked) {
      if (!parked.terminal) {
        throw new IpcError("conflict", `session ${id} has not opened`);
      }
      return parked.terminal;
    }
    const { shell } = shellOf(id);
    if (!shell) throw new IpcError("conflict", `session ${id} has not opened`);
    return shell;
  };

  const containersOf = (context: string, namespace: string, name: string) => {
    const pod = cluster(context).pods.find(
      (candidate) =>
        candidate.namespace === namespace && candidate.name === name,
    );
    if (!pod) throw new IpcError("notFound", `pods "${name}" not found`);
    return shellContainers(pod, shellScenario);
  };

  const objects = new Map<number, MockObject>();
  const object = (id: number) => {
    const found = objects.get(id);
    if (!found) throw new IpcError("notFound", `no object subscription ${id}`);
    return found;
  };

  const objectContexts = new Map<number, string>();
  const edits = new MockEdits();
  const bus = new MockBus({
    answer: isEditScenario(scenario) ? PINNED_ANSWERS[scenario] : undefined,
    written: (context, { gvr, namespace, name }) =>
      edits.get(
        MockEdits.key(context, gvr.group, gvr.resource, namespace, name),
      ),
    resource: (apiVersion, kind) => {
      const slash = apiVersion.lastIndexOf("/");
      const group = slash < 0 ? "" : apiVersion.slice(0, slash);
      return RESOURCES.find(
        (candidate) => candidate.gvr.group === group && candidate.kind === kind,
      );
    },
    applied: (context, opened, edited) => {
      const { apiVersion, kind, metadata } = edited as {
        apiVersion?: string;
        kind?: string;
        metadata?: { name?: string; namespace?: string };
      };
      const group =
        opened?.group ?? (apiVersion ?? "").split("/").slice(0, -1).join("/");
      const known = RESOURCES.find(
        (candidate) =>
          candidate.gvr.group === group &&
          (opened
            ? candidate.gvr.resource === opened.resource
            : candidate.kind === kind),
      );
      if (!known || metadata?.name === undefined) return;
      const namespace = known.namespaced
        ? (metadata.namespace ?? "default")
        : null;
      const key = MockEdits.key(
        context,
        group,
        known.gvr.resource,
        namespace,
        metadata.name,
      );
      if (scenario === "applyLate") {
        setTimeout(() => {
          edits.put(key, edited);
        }, APPLIED_LAG_MS);
      } else {
        edits.put(key, edited);
      }
    },
    access: (context) => access.of(context),
    context: (id) => space(id).contexts[0],
    cluster,
    reveal: (id, key) => object(id).reveal(key),
    secret: (id) => {
      const context = objectContexts.get(id);
      if (context === undefined) {
        throw new IpcError("notFound", `no object subscription ${id}`);
      }
      return { context, ...object(id).names };
    },
    containers: containersOf,
    session: (target, kind) => {
      const id = nextId++;
      shells.set(id, { target, kind });
      return id;
    },
    joins: (kind) => joins(kind, shellScenario),
    changed: () => {
      for (const sub of subscriptions.values()) sub.touch();
    },
  });

  const logs = new Map<number, MockLogs>();
  const log = (id: number) => {
    const found = logs.get(id);
    if (!found) throw new IpcError("notFound", `no logs subscription ${id}`);
    return found;
  };
  /** The cluster's followed logs go to the sessions in the order they opened (ARCHITECTURE 3.2). */
  const budget = (session: MockLogs, wanted: number) => {
    let used = 0;
    for (const other of logs.values()) {
      if (other === session) break;
      used += other.streams;
    }
    return Math.max(0, Math.min(wanted, CLUSTER_STREAMS - used));
  };

  const plain: {
    [C in PlainCommand]: (request: RequestOf<C>) => ResponseOf<C>;
  } = {
    spaces_list: () => [...spaces],
    context_mode_set: ({ context, mode }) => {
      access.setMode(context, mode);
      return null;
    },
    context_environment_set: ({ context, environment }) => {
      access.setEnvironment(context, environment);
      return null;
    },
    context_unlock: (context) => {
      access.unlock(context);
      return null;
    },
    context_relock: (context) => {
      access.relock(context);
      return null;
    },
    approval_answer: (request) => approvals.answer(request),
    forward_ports: (target) => forwards.ports(target),
    forward_start: (request) => forwards.start(request),
    forward_stop: (id) => forwards.stop(id),
    forward_resume: (request) => forwards.resume(request),
    forward_remove: (id) => forwards.remove(id),
    command_plan: (request) => bus.plan(request),
    apply_preview: (request) => bus.applyPreview(request),
    command_cancel: (id) => bus.cancel(id),
    access_review: ({ checks }) =>
      checks.map(
        ({ verb }) =>
          scenario !== "viewer" || ["get", "list", "watch"].includes(verb),
      ),
    space_open: (name) => {
      if (!CONTEXTS.some((context) => context.name === name)) {
        throw new IpcError("notFound", `no source lists the context ${name}`);
      }
      const open = spaces.find(
        (candidate) =>
          candidate.contexts.length === 1 && candidate.contexts[0] === name,
      );
      if (open) return open;
      const created = { id: name, name, contexts: [name] };
      spaces.push(created);
      return created;
    },
    cluster_version: (name) => {
      const version = VERSIONS[name];
      if (!version) throw new IpcError("notFound", `no context ${name}`);
      auth.check(name);
      return { gitVersion: version };
    },
    context_sign_in: (context) => auth.signIn(context),
    context_sign_in_cancel: (context) => auth.cancel(context),
    exec_review: () => auth.review(),
    exec_trust: (digests) => auth.trust(digests),
    url_open: (url) => {
      if (!signInLink(url)) {
        throw new IpcError(
          "invalidInput",
          `Twigo opens only sign-in links: ${url}`,
        );
      }
      globalThis.open(url, "_blank", "noopener,noreferrer");
      return null;
    },
    namespaces_list: (id) => {
      space(id);
      if (lists === "forbidden") {
        throw new IpcError("forbidden", "you may not list namespaces");
      }
      return [...NAMESPACES].sort();
    },
    schema_get: ({ space: id, group, version, kind }) => {
      space(id);
      const schema = recordedSchema(group, version, kind);
      if (schema === undefined) {
        throw new IpcError(
          "notFound",
          `the cluster's OpenAPI for ${group}/${version} has no kind ${kind}`,
        );
      }
      return schema;
    },
    shell_environment_retry: () => {
      if (environment.state !== "failed") return null;
      setEnvironment({ state: "resolving" });
      setTimeout(() => {
        setEnvironment(resolved);
      }, RETRY_MS);
      return null;
    },
    state_load: () => ({
      app: Object.fromEntries(appState),
      spaces: Object.fromEntries(
        [...spaceState].map(([id, values]) => [id, Object.fromEntries(values)]),
      ),
    }),
    state_set: (entries) => {
      for (const { space: id, key, value } of entries) {
        if (id !== null) space(id);
        try {
          JSON.parse(value);
        } catch {
          throw new IpcError("invalidInput", `the value of ${key} is not JSON`);
        }
      }
      for (const { space: id, key, value } of entries) {
        if (id === null) {
          appState.set(key, value);
          continue;
        }
        let values = spaceState.get(id);
        if (!values) {
          values = new Map();
          spaceState.set(id, values);
        }
        values.set(key, value);
      }
      return null;
    },
    list_set_window: ({ id, start, end, metrics: reads }) => {
      subscription(id).setWindow(start, end, reads);
      return null;
    },
    list_ack: ({ id, seq }) => {
      subscription(id).ack(seq);
      return null;
    },
    object_set_parts: ({ id, parts }) => {
      object(id).setParts(parts);
      return null;
    },
    object_ack: ({ id }) => {
      object(id);
      return null;
    },
    object_values: ({ id, keys }) => object(id).values(keys),
    shell_containers: ({ space: id, namespace, pod }) => {
      const [context] = space(id).contexts;
      if (context === undefined) {
        throw new IpcError("notFound", `space ${id} has no context`);
      }
      return containersOf(context, namespace, pod);
    },
    shell_input: ({ id, data }) => {
      running(id).input(data);
      return null;
    },
    shell_resize: ({ id, cols, rows }) => {
      running(id).resize(cols, rows);
      return null;
    },
    shell_ack: ({ id, bytes }) => {
      running(id).ack(bytes);
      return null;
    },
    shell_close: (id) => {
      const parked = terminals.get(id);
      if (parked) {
        parked.terminal?.close();
        terminals.delete(id);
        return null;
      }
      shellOf(id).shell?.close();
      shells.delete(id);
      return null;
    },
    terminal_create: ({ context, label }) => {
      const kind = terminalKind(
        context,
        access.of(context),
        scenario === "policyFile",
      );
      const id = nextId++;
      const shell = scenario === "terminalShell" ? "sh" : "zsh";
      terminals.set(id, { context, label, kind, shell });
      return { id, kind, shell, kubeconfigKept: keepsKubeconfig(shell) };
    },
    kubeconfig_offer_answer: (request) => offers.answer(request),
    logs_set_source: ({ id, source }) => {
      log(id).setSource(source);
      return null;
    },
    logs_set_view: ({ id, view }) => {
      log(id).setView(view);
      return null;
    },
    logs_set_window: ({ id, window }) => {
      log(id).setWindow(window);
      return null;
    },
    logs_ack: ({ id, seq }) => {
      log(id).ack(seq);
      return null;
    },
    logs_download: ({ id }) => {
      log(id);
      return `~/Downloads/logs-${String(id)}.log`;
    },
    logs_close: (id) => {
      log(id).close();
      logs.delete(id);
      return null;
    },
    object_close: (id) => {
      object(id).close();
      objects.delete(id);
      objectContexts.delete(id);
      return null;
    },
    list_unsubscribe: (id) => {
      subscription(id).close();
      subscriptions.delete(id);
      if (subscriptions.size === 0) {
        clearInterval(churn);
        churn = undefined;
      }
      return null;
    },
  };

  const demoChurn = () =>
    setInterval(() => {
      for (const [context, target] of clusters) {
        const focus = [...subscriptions.values()].flatMap((sub) =>
          sub.windowIds(context),
        );
        target.churn(Math.ceil(target.pods.length / 500), focus, Date.now());
      }
      for (const sub of subscriptions.values()) sub.touch();
    }, CHURN_MS);

  const steadyChurn = (rate: number) => {
    const started = Date.now();
    let applied = 0;
    return setInterval(() => {
      const due = Math.floor(((Date.now() - started) * rate) / 1000) - applied;
      if (due <= 0) return;
      applied += due;
      for (const target of clusters.values()) target.change(due);
      for (const sub of subscriptions.values()) sub.touch();
    }, RATE_TICK_MS);
  };

  const streams: {
    [C in SubscriptionCommand]: (
      request: RequestOf<C>,
      onMessage: (message: MessageOf<C>) => void,
    ) => ResponseOf<C>;
  } = {
    list_subscribe: (query, onMessage) => {
      const [context] = space(query.space).contexts;
      if (context === undefined) {
        throw new IpcError("notFound", `space ${query.space} has no context`);
      }
      const { group, version, resource } = query.gvr;
      const kind = KINDS[`${group}/${version}/${resource}`];
      if (!kind) {
        throw new IpcError(
          "notFound",
          `the mock backend serves only pods, nodes, deployments, jobs and events, not ${resource}`,
        );
      }
      const selected = parseFields(query.fieldSelector, kind);
      const served = queryColumns(kind.columns, query);
      const join =
        kind.metrics && metrics.served
          ? new MetricsJoin(
              metrics,
              metricsAt(served),
              context,
              query.namespaces,
            )
          : undefined;
      const columns = join
        ? [
            ...served.slice(0, join.at),
            ...METRIC_COLUMNS,
            ...served.slice(join.at),
          ]
        : served;
      const compiled = compileQuery(query, columns);
      const id = nextId++;
      const forbidden: ViewState = {
        state: "forbidden",
        verb: "list",
        resource,
      };
      const state: Exclude<ListScenario, "forbidden"> | ViewState =
        typeof selected === "string"
          ? {
              state: "error",
              error: { kind: "invalidInput", message: selected },
            }
          : lists === "forbidden" ||
              (lists === "live" && FORBIDDEN[context]?.includes(resource)) ||
              (scenario === "rbacNamespaces" &&
                !(
                  query.namespaced &&
                  query.namespaces.length > 0 &&
                  query.namespaces.every((name) => name === "default")
                ))
            ? forbidden
            : lists;
      subscriptions.set(
        id,
        new Subscription(
          compiled,
          typeof selected === "string" ? () => true : selected,
          columns,
          kind,
          cluster(context),
          state,
          onMessage,
          join,
        ),
      );
      if (lists === "live" && churn === undefined) {
        churn =
          changesPerSecond === undefined
            ? demoChurn()
            : steadyChurn(changesPerSecond);
      }
      return id;
    },
    object_open: ({ object: query, parts }, onMessage) => {
      space(query.space);
      const id = nextId++;
      const [context] = space(query.space).contexts;
      if (context !== undefined) objectContexts.set(id, context);
      objects.set(
        id,
        new MockObject(
          query,
          parts,
          context === undefined ? undefined : cluster(context),
          onMessage,
          metrics,
          context === undefined
            ? undefined
            : {
                edits,
                key: MockEdits.key(
                  context,
                  query.gvr.group,
                  query.gvr.resource,
                  query.namespace,
                  query.name,
                ),
                ...(scenario === "serverChange" && {
                  change: "server" as const,
                }),
                ...(scenario === "statusChange" && {
                  change: "status" as const,
                }),
              },
        ),
      );
      return id;
    },
    logs_open: ({ target, source, view }, onMessage) => {
      const [context] = space(target.space).contexts;
      const id = nextId++;
      logs.set(
        id,
        new MockLogs(
          target,
          source,
          view,
          context === undefined ? undefined : cluster(context),
          budget,
          onMessage,
        ),
      );
      return id;
    },
    shell_open: (open, onMessage) => {
      const parked = terminals.get(open.id);
      if (parked) {
        if (parked.terminal) {
          throw new IpcError("conflict", `session ${open.id} opened already`);
        }
        parked.terminal = new MockTerminal(
          {
            id: open.id,
            context: parked.context,
            kind: parked.kind,
            shell: parked.shell,
            deleteContext: (name) => offers.deleteContext(open.id, name),
          },
          onMessage,
        );
        offers.opened(
          {
            terminal: parked.label,
            session: open.id,
            context: parked.context,
          },
          parked.kind,
        );
        return null;
      }
      const found = shellOf(open.id);
      if (found.shell) {
        throw new IpcError("conflict", `session ${open.id} opened already`);
      }
      const [context] = space(found.target.space).contexts;
      found.shell = new MockShell(
        found.target,
        found.kind,
        open,
        shellScenario,
        () => {
          if (context !== undefined) access.setMode(context, "read-only");
        },
        onMessage,
      );
      return null;
    },
    approvals_watch: (_request, onMessage) => approvals.watch(onMessage),
    forwards_watch: (_request, onMessage) => forwards.watch(onMessage),
    kubeconfig_offers_watch: (_request, onMessage) => offers.watch(onMessage),
    command_execute: (request, onMessage) => bus.execute(request, onMessage),
    contexts_watch: (_request, onMessage) => access.watch(onMessage),
    resources_watch: (id, onMessage) => {
      space(id);
      const send = () => {
        onMessage({
          state: "ready",
          cluster: `mock://${id}`,
          resources: metrics.served
            ? RESOURCES
            : RESOURCES.filter(({ gvr }) => gvr.group !== METRICS_GROUP),
        });
      };
      send();
      metrics.watch(send);
      return null;
    },
    context_auth_watch: (context, onMessage) => auth.watch(context, onMessage),
    keyboard_layout_watch: () => LAYOUTS[layout],
    shell_environment_watch: (_request, onMessage) => {
      environmentWatchers.add(onMessage);
      return environment;
    },
  };

  return {
    invoke<C extends PlainCommand>(command: C, request: RequestOf<C>) {
      return settle(() => plain[command](request));
    },
    subscribe<C extends SubscriptionCommand>(
      command: C,
      request: RequestOf<C>,
      onMessage: (message: MessageOf<C>) => void,
    ) {
      return settle(() => streams[command](request, onMessage));
    },
  };
}

/** Rust's `sign_in_url` rule: https, or http to localhost or 127.0.0.1, without a user part; WHATWG's URL parser may read an unusual link otherwise than Rust's. */
function signInLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  return (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
  );
}

/** Answers asynchronously, as IPC does. */
function settle<T>(run: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(run());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, 0);
  });
}

const PINNED: Readonly<
  Record<Exclude<ListScenario, "live" | "forbidden">, ViewState>
> = {
  queued: { state: "queued" },
  connecting: { state: "connecting" },
  syncing: { state: "syncing", loaded: 1850 },
  ready: { state: "ready" },
  relisting: { state: "relisting" },
  stale: { state: "stale" },
  unauthorized: { state: "unauthorized" },
  error: {
    state: "error",
    error: {
      kind: "unavailable",
      message: "dial tcp 10.0.0.1:6443: connect: connection refused",
    },
  },
};

/** States in which a view shows rows. */
const SHOWS_ROWS = new Set<ViewState["state"]>(["ready", "relisting", "stale"]);

/** States in which Rust knows the server's columns: from a list's first page on. */
const KNOWS_COLUMNS = new Set<ViewState["state"]>([
  "syncing",
  "ready",
  "relisting",
  "stale",
]);

const NO_COLUMNS: readonly Column[] = [];

/** The batcher of one subscription: one unacknowledged batch at a time, the latest state wins. */
class Subscription {
  #query: CompiledQuery;
  readonly #fields: FieldSelector;
  readonly #kind: MockKind;
  readonly #key: string;
  readonly #cluster: Cluster;
  #columns: Column[];
  #join: MetricsJoin | undefined;
  readonly #onMessage: (batch: ListBatch) => void;
  readonly #timers: ReturnType<typeof setTimeout>[] = [];
  #status: ViewState;
  /** Undefined until the webview sets one: nothing goes before it, as in Rust. */
  #window: [number, number] | undefined;
  /** The window moved since the last flush. */
  #moved = false;
  #seq = 0;
  #acked = 0;
  #dirty = true;
  #base: { version: number; rows: MockRow[] } | undefined;
  #cache:
    { base: object; samples: number; result: QueryResult<MockRow> } | undefined;
  #scrape = -1;
  #sentRows = false;
  #sent: {
    total: number;
    start: number;
    ids: readonly RowId[];
    /** What each row of the window was sent as. */
    rows: ReadonlyMap<RowId, string>;
    status: string;
    counts: string;
    groups: string;
    layout: readonly Column[];
    metrics: MetricsState | null;
  } = {
    total: -1,
    start: 0,
    ids: [],
    rows: new Map(),
    status: "",
    counts: "",
    groups: "null",
    layout: NO_COLUMNS,
    metrics: null,
  };

  constructor(
    query: CompiledQuery,
    fields: FieldSelector,
    columns: Column[],
    kind: MockKind,
    cluster: Cluster,
    scenario: Exclude<ListScenario, "forbidden"> | ViewState,
    onMessage: (batch: ListBatch) => void,
    join?: MetricsJoin,
  ) {
    this.#join = join;
    join?.listen(() => {
      this.touch();
      this.#flushSoon();
    });
    this.#query = query;
    this.#fields = fields;
    this.#kind = kind;
    this.#key = JSON.stringify(query.query.gvr);
    this.#cluster = cluster;
    this.#columns = columns;
    this.#onMessage = onMessage;
    if (typeof scenario !== "string") {
      this.#status = scenario;
    } else if (scenario === "live" && cluster.synced.has(this.#key)) {
      this.#status = { state: "ready" };
    } else if (scenario === "live") {
      this.#status = { state: "connecting" };
      const total = kind.rows(cluster, false).length;
      [0.25, 0.6, 0.9].forEach((share, step) => {
        this.#later(300 + step * 250, {
          state: "syncing",
          loaded: Math.round(total * share),
        });
      });
      this.#later(1100, { state: "ready" }, () => {
        cluster.synced.add(this.#key);
      });
    } else {
      this.#status = PINNED[scenario];
    }
    this.#timers.push(
      setInterval(() => {
        this.#flush();
      }, FLUSH_MS),
    );
  }

  /**
   * Flushes at once rather than on the next tick, or with the ack of the
   * batch in flight, as Rust's batcher does (ARCHITECTURE 3.5).
   */
  setWindow(start: number, end: number, metrics: boolean): void {
    this.#window = [start, end];
    this.#join?.reads(metrics);
    this.#moved = true;
    this.touch();
    this.#flushSoon();
  }

  ack(seq: number): void {
    if (seq !== this.#seq) return;
    this.#acked = seq;
    if (this.#moved) this.#flushSoon();
  }

  #flushSoon(): void {
    this.#timers.push(
      setTimeout(() => {
        this.#flush();
      }, 0),
    );
  }

  touch(): void {
    this.#dirty = true;
  }

  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#join?.close();
  }

  /** The ids of this subscription's window that live in `context`. */
  windowIds(context: string): RowId[] {
    return this.#sent.ids.filter((id) => id.startsWith(`${context}/`));
  }

  #later(ms: number, status: ViewState, then?: () => void): void {
    this.#timers.push(
      setTimeout(() => {
        this.#status = status;
        this.touch();
        then?.();
      }, ms),
    );
  }

  #rows(): QueryResult<MockRow> {
    if (!SHOWS_ROWS.has(this.#status.state)) {
      const knows = KNOWS_COLUMNS.has(this.#status.state);
      return {
        rows: [],
        readable: [],
        counts: this.#query.query.countBy === null ? null : [],
        groups: this.#query.group === null || !knows ? null : [],
      };
    }
    const { version } = this.#cluster;
    if (this.#base?.version !== version) {
      const withNamespace = this.#columns.some((c) => c.name === "Namespace");
      const rows = this.#kind
        .rows(this.#cluster, withNamespace)
        .filter((row) => this.#fields(row.fields))
        .map((row) =>
          this.#join ? { ...row, cells: this.#join.pad(row.cells) } : row,
        );
      this.#base = { version, rows };
    }
    const { rows } = this.#base;
    const join = this.#query.sort?.metric ? this.#join : undefined;
    join?.poll(rows, true);
    const samples = join?.version ?? 0;
    if (this.#cache?.base !== rows || this.#cache.samples !== samples) {
      this.#cache = {
        base: rows,
        samples,
        result: runQuery(
          join ? rows.map((row) => join.fill(row)) : rows,
          this.#query,
        ),
      };
    }
    return this.#cache.result;
  }

  /** The context stopped serving the API: the columns go with it, as Rust's layout is built anew. */
  #withdrawMetrics(): void {
    this.#join?.close();
    this.#join = undefined;
    this.#columns = this.#columns.filter((column) => !isMetric(column));
    this.#query = compileQuery(this.#query.query, this.#columns);
    this.#base = undefined;
    this.#cache = undefined;
    this.#dirty = true;
  }

  #flush(): void {
    if (this.#join && !this.#join.served) this.#withdrawMetrics();
    const scrape = this.#join?.scrape;
    if (scrape !== this.#scrape) {
      this.#scrape = scrape ?? -1;
      this.#dirty = true;
    }
    if (!this.#window || !this.#dirty || this.#seq !== this.#acked) return;
    this.#dirty = false;
    this.#moved = false;
    const { rows, readable, counts, groups } = this.#rows();
    const join = this.#join;
    // Rust holds the first rows of a list sorted by a metric until the
    // scopes it reads have answered, so the order is the values' order.
    if (!this.#sentRows && this.#query.sort?.metric && join?.waiting) {
      this.#dirty = true;
      return;
    }
    const total = rows.length;
    const [start, end] = this.#window;
    let visible = readable.slice(start, end);
    if (join && !this.#query.sort?.metric) {
      join.poll(visible, false);
      visible = visible.map((row) => join.fill(row));
    }
    const ids = visible.map((row) => row.id);
    const sent = new Map(
      visible.map((row) => [row.id, JSON.stringify(wireRow(row))]),
    );
    const status = JSON.stringify(this.#status);
    const countsJson = JSON.stringify(counts);
    const countsChanged = countsJson !== this.#sent.counts;
    const groupsJson = JSON.stringify(groups);
    const groupsChanged = groupsJson !== this.#sent.groups;
    const first = this.#seq === 0;
    const knows = KNOWS_COLUMNS.has(this.#status.state);
    const layout = knows ? this.#columns : NO_COLUMNS;
    const columnsChanged = first || layout !== this.#sent.layout;
    const metrics = knows ? (join?.state ?? null) : null;
    const metricsChanged = metrics !== null && metrics !== this.#sent.metrics;
    const windowChanged =
      first ||
      start !== this.#sent.start ||
      ids.length !== this.#sent.ids.length ||
      ids.some((id, i) => id !== this.#sent.ids[i]);
    const upserts = visible.filter(
      (row) => this.#sent.rows.get(row.id) !== sent.get(row.id),
    );
    if (
      !windowChanged &&
      upserts.length === 0 &&
      status === this.#sent.status &&
      !countsChanged &&
      !groupsChanged &&
      !columnsChanged &&
      !metricsChanged &&
      total === this.#sent.total
    ) {
      return;
    }
    this.#sent = {
      total,
      start,
      ids,
      rows: sent,
      status,
      counts: countsJson,
      groups: groupsJson,
      layout,
      metrics: metrics ?? this.#sent.metrics,
    };
    this.#seq++;
    this.#sentRows ||= ids.length > 0;
    this.#onMessage({
      seq: this.#seq,
      total,
      columns: columnsChanged ? [...layout] : null,
      window: windowChanged ? { start, ids } : null,
      upserts: upserts.map(wireRow),
      status: this.#status,
      counts: counts && (first || countsChanged) ? counts : null,
      groups: groupsChanged ? (groups ?? []) : null,
      metrics: metricsChanged ? metrics : null,
    });
  }
}

/** Whether a row's fields pass a field selector. */
type FieldSelector = (fields: Readonly<Record<string, string>>) => boolean;

/**
 * A field selector as the API server reads one (apimachinery v0.37.1
 * `fields.ParseSelector`): terms joined by commas, empty ones skipped,
 * sorted, each `field=value`, `field==value` or `field!=value`, all of
 * them parsed before any field is converted, an old name as conversion
 * renames it; a field the kind cannot be selected by is the message the
 * server refuses it with, which Rust shows as the list's error.
 */
function parseFields(
  selector: string | null,
  kind: MockKind,
): FieldSelector | string {
  const parts = (selector ?? "").split(",").filter((part) => part !== "");
  parts.sort();
  const parsed = [];
  for (const part of parts) {
    const match = /^([^!=]+)(!=|==|=)(.*)$/.exec(part);
    if (!match)
      return `invalid selector: '${selector ?? ""}'; can't understand '${part}'`;
    const [, label = "", operator, value = ""] = match;
    parsed.push({ label, value, negated: operator === "!=" });
  }
  const terms: { field: string; value: string; negated: boolean }[] = [];
  for (const { label, value, negated } of parsed) {
    const field = kind.aliases?.[label] ?? label;
    if (!kind.fields.includes(field))
      return `field label not supported: ${label}`;
    terms.push({ field, value, negated });
  }
  return (fields) =>
    terms.every(
      ({ field, value, negated }) => (fields[field] === value) !== negated,
    );
}
