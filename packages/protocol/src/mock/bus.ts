import { IpcError } from "../error";
import type {
  Affected,
  ApplyPreviewed,
  ApplyRequest,
  Blocked,
  ContextAccess,
  Execute,
  Friction,
  ModeSource,
  ObjectRef,
  OperationEvent,
  Plan,
  PlanId,
  PlanRequest,
  RequestClass,
  Resource,
  ResourceRef,
  ShellContainers,
  ShellKind,
  ShellTarget,
} from "../generated";
import { masked } from "./edits";
import {
  cordoned,
  deploymentOf,
  type Cluster,
  type CronJob,
  type Job,
  type Pod,
} from "./cluster";

/** How long a toast counts down before a pod its controller replaces is deleted, as in Rust. */
const COUNTDOWN_SECONDS = 5;
/** How long a deleted pod takes to go, as its grace period would hold it. */
const GRACE_MS = 1500;
/** How long an action's undo lasts after it ends, as `UNDO_FOR` in Rust. */
const UNDO_MS = 30_000;
/** How long a triggered Job runs before it completes. */
const JOB_MS = 4000;

/** What a CronJob's resume says, as Rust's `suspend::RESUMED`. */
const RESUMED =
  "Its schedule starts jobs again, and the latest run it missed while suspended starts at once, unless its starting deadline has passed.";

/** What a command risks, as `twigo_policy::friction::Risk` says. */
type Risk =
  | { readonly kind: "reversible" }
  | { readonly kind: "replaced" }
  | { readonly kind: "lasting" }
  | { readonly kind: "wide"; readonly name: string }
  | { readonly kind: "reveal" }
  | { readonly kind: "reviewed" };

/** `twigo_policy::friction::friction`. */
function frictionOf(
  risk: Risk,
  context: string,
  access: ContextAccess,
): Friction {
  if (risk.kind === "reveal" || risk.kind === "reviewed") {
    return access.mode === "read-write"
      ? { kind: "atOnce" }
      : { kind: "confirm" };
  }
  if (access.mode !== "read-write") return { kind: "typed", text: context };
  switch (risk.kind) {
    case "reversible":
      return { kind: "atOnce" };
    case "replaced":
      return access.environment === "production"
        ? { kind: "confirm" }
        : { kind: "countdown", seconds: COUNTDOWN_SECONDS };
    case "lasting":
      return { kind: "confirm" };
    case "wide":
      return { kind: "typed", text: risk.name };
  }
}

const RANK: Readonly<Record<Friction["kind"], number>> = {
  atOnce: 0,
  countdown: 1,
  confirm: 2,
  typed: 3,
};

/** `twigo_policy::friction::covers`. */
function covers(planned: Friction, now: Friction): boolean {
  const same =
    planned.kind === now.kind &&
    (planned.kind !== "typed" ||
      (now.kind === "typed" && planned.text === now.text));
  return same || RANK[planned.kind] > RANK[now.kind];
}

/** Where a mode comes from, as `Blocked`'s message in Rust says it. */
function setBy(source: ModeSource): string {
  switch (source.kind) {
    case "policyFile":
      return source.pattern === null
        ? ` because ${source.file} cannot be read`
        : ` by ${source.pattern} in ${source.file}`;
    case "user":
      return " by your choice";
    case "kubeconfig":
      return " by its kubeconfig";
    case "provider":
      return " by its provider";
    case "environment":
      return ` as ${source.environment.charAt(0).toUpperCase()}${source.environment.slice(1)} by default`;
    case "default":
      return "";
    case "unlisted":
      return " because no source lists it now";
    case "moved":
      return " because it names another cluster now";
  }
}

/** What a plan risks, says follows and lists, beside its words. */
interface Asked {
  readonly risk: Risk;
  readonly consequences: string[];
  readonly affected: Affected[];
  /** False for a CronJob's resume, which asks for the run it may start and takes nothing away. */
  readonly destructive?: false;
}

/** A CronJob's resume, as Rust's `Asks::Resume`. */
const RESUMES: Asked = {
  risk: { kind: "lasting" },
  consequences: [RESUMED],
  affected: [],
  destructive: false,
};

const AT_ONCE: Asked = {
  risk: { kind: "reversible" },
  consequences: [],
  affected: [],
};

/**
 * What puts an action back, as `actions::undo::Revert` holds it. Only the
 * bus writes to the mock's cluster, and every action takes the space's
 * undo, so no object changes under one: Rust's check that nobody changed
 * it has nothing to find here.
 */
interface Revert {
  readonly context: string;
  readonly write: { readonly verb: string; readonly target: string };
  /** What the undo asks as it is planned, as Rust's `Asks`. */
  readonly asks: () => Asked;
  /** Why the undo is refused as it runs, as Rust's `ended_since`. */
  readonly left?: () => string | undefined;
  readonly question: string;
  readonly doing: string;
  readonly done: string;
  readonly kubectl: string;
  readonly put: () => void;
}

/** What a run tells as it goes, and how it ends; `undoable` ends it with an undo. */
type Told =
  | OperationEvent
  | {
      readonly state: "undoable";
      readonly text: string;
      readonly revert: Revert;
    };

/** `live` says whether it still runs: a stop ends it. */
type Run = (tell: (event: Told) => void, live: () => boolean) => void;

/** What the gate reads of a request a plan sends: its class is a write unless it says. */
interface Write {
  readonly verb: string;
  readonly target: string;
  readonly class?: RequestClass;
}

interface Planned {
  readonly plan: Omit<Plan, "id" | "friction" | "mode" | "environment">;
  readonly risk: Risk;
  /** What the gate reads of the write it sends, none for a Reveal. */
  readonly write?: Write;
  /** The space whose last action it is once it starts; none for an undo, which takes its own. */
  readonly space?: string;
  /** What a stop while it runs says. */
  readonly stopped?: string;
  /** The object of the preview it was made from: a newer preview of it drops the plan. */
  readonly previewed?: string;
  readonly run: Run;
}

interface Waiting {
  readonly planned: Planned;
  readonly friction: Friction;
  readonly since: number;
}

/** What a preview left for the plan of its id, as Rust's `Prepared`. */
interface Previewed {
  readonly step: "apply" | "mergePatch" | "recreate";
  readonly context: string;
  /** `configmaps/settings in default`. */
  readonly target: string;
  /** `configmap settings`. */
  readonly what: string;
  /** `configmaps settings -n default`, as kubectl names the object. */
  readonly named: string;
  readonly job: boolean;
  /** What a merge patch after the apply removes. */
  readonly removals: readonly string[];
  /** The edit, which an apply leaves as the object. */
  readonly edited: Record<string, unknown>;
  /** The resource of an edit of an opened object. */
  readonly resource: ResourceRef["gvr"] | undefined;
}

/** The annotation a mock edit names the preview's answer by. */
const ANSWER = "mock.twigo.io/answer";

const CONFLICTS = [
  { path: ".spec.replicas", manager: "kube-controller-manager" },
  { path: ".metadata.labels.team", manager: "kubectl-client-side-apply" },
] as const;

/** The mock's stand-ins for Rust's kubectl lines: not run, as the mock sends nothing. */
function applyKubectl({ step, named, removals }: Previewed): string {
  if (step === "mergePatch") {
    return `kubectl patch ${named} --type=merge --field-manager=twigo-edit -p '<the edit>'`;
  }
  if (step === "recreate") {
    return `kubectl delete ${named} && kubectl create --field-manager twigo -f - < the edit`;
  }
  const apply =
    "kubectl apply --server-side --field-manager=twigo -f - < the edit";
  return removals.length === 0
    ? apply
    : `${apply} && kubectl patch ${named} --type=merge --field-manager=twigo -p '<what goes>'`;
}

/** What follows a plan, in the words of Rust's `apply`. */
function applyConsequences({ step, job, removals }: Previewed): string[] {
  if (step === "mergePatch") {
    return [
      "An apply cannot express this edit, so it goes as one merge patch under field manager twigo-edit, as kubectl edit would.",
    ];
  }
  if (step === "recreate") {
    return [
      job
        ? "It goes with its pods, and a new one with a new uid runs from the start, whatever this one finished."
        : "It goes, and a new one with a new uid takes its place.",
    ];
  }
  return removals.length === 0
    ? []
    : [`Then a merge patch removes ${removals.join(", ")}.`];
}

/** The fields of an object that Rust never sends: `SERVER_METADATA` in `twigo-kube`'s `apply`. */
const SERVER_METADATA = [
  "uid",
  "resourceVersion",
  "generation",
  "creationTimestamp",
  "deletionTimestamp",
  "deletionGracePeriodSeconds",
  "selfLink",
  "managedFields",
] as const;

type Fields = Record<string, unknown>;

function metadataOf(object: unknown): Fields {
  const { metadata } = (object ?? {}) as { metadata?: unknown };
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Fields)
    : {};
}

function omit(object: Fields, names: readonly string[]): Fields {
  return Object.fromEntries(
    Object.entries(object).filter(([name]) => !names.includes(name)),
  );
}

/** The fields of an object that an apply may carry, as Rust's `editable`. */
function editable(object: unknown, status: boolean): Fields {
  return {
    ...omit((object ?? {}) as Fields, [
      "apiVersion",
      "kind",
      "metadata",
      ...(status ? ["status"] : []),
    ]),
    metadata: omit(metadataOf(object), [
      "name",
      "namespace",
      ...SERVER_METADATA,
    ]),
  };
}

/** What an edit says differently from its object in the fields no apply carries, as Rust's `ignored`; for a manifest, all it says of them. */
function ignoredBy(base: unknown, edited: unknown, status: boolean): string[] {
  const differs = (of: (object: unknown) => unknown): boolean =>
    base === undefined
      ? of(edited) !== undefined
      : !isEqual(of(base), of(edited));
  return [
    ...(status && differs((object) => (object as Fields).status)
      ? [".status"]
      : []),
    ...SERVER_METADATA.filter((field) =>
      differs((object) => metadataOf(object)[field]),
    ).map((field) => `.metadata.${field}`),
  ];
}

/** Structural equality of JSON values, whatever the order of their keys. */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => isEqual(item, b[index]))
    );
  }
  const left = Object.entries(a);
  return (
    left.length === Object.keys(b).length &&
    left.every(([key, value]) => isEqual(value, (b as Fields)[key]))
  );
}

/** An object as a side of the diff, as Rust's `side`: without what would only be noise. */
function side(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const object = masked(value as Record<string, unknown>);
  const { metadata } = object as { metadata?: object };
  if (metadata === undefined) return object;
  return {
    ...object,
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(
        ([name]) => name !== "resourceVersion" && name !== "generation",
      ),
    ),
  };
}

/** What the mock backend's bus reaches. */
export interface BusHost {
  access(context: string): ContextAccess;
  /** The context of a space, or none. */
  context(space: string): string | undefined;
  cluster(context: string): Cluster;
  /** The value a Reveal of an open object's key answers. */
  reveal(object: number, key: string): { value: string; binary: boolean };
  /** The context and the name of an open Secret. */
  secret(object: number): {
    context: string;
    namespace: string;
    name: string;
  };
  /** The containers of a pod that run, none of a pod that does not exist or runs nothing. */
  containers(context: string, namespace: string, pod: string): ShellContainers;
  /** A shell's session, which starts once `shell_open` names it. */
  session(target: ShellTarget, kind: ShellKind): number;
  /** Tells the lists that the cluster changed. */
  changed(): void;
  /** What `apply_preview` answers to every edit that changes something, unless the edit names an answer. */
  readonly answer: string | undefined;
  /** The object that an edit or a change from outside has written, none while it is as recorded. */
  written(
    context: string,
    target: ResourceRef,
  ): Record<string, unknown> | undefined;
  /** What the cluster serves of a kind, none when the mock does not know it. */
  resource(apiVersion: string, kind: string): Resource | undefined;
  /** An edit was applied: the object in `context` is `edited` now. */
  applied(
    context: string,
    resource: { readonly group: string; readonly resource: string } | undefined,
    edited: Record<string, unknown>,
  ): void;
}

/** `1 pod`, `3 pods`: the mock's kinds all count with an s. */
function counted(count: number, words: string): string {
  return `${String(count)} ${words}${count === 1 ? "" : "s"}`;
}

function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The kubectl words of a namespace, as `Target::kubectl` adds them. */
function inNamespace(namespace: string | null): string {
  return namespace === null ? "" : ` -n ${namespace}`;
}

function podRef(pod: Pod): ObjectRef {
  return {
    group: "",
    version: "v1",
    kind: "Pod",
    namespace: pod.namespace,
    name: pod.name,
  };
}

/** What the mock serves of a resource, by `group/resource`, as its words and kubectl name. */
const KINDS: Readonly<
  Record<string, { readonly words: string; readonly name: string }>
> = {
  "/pods": { words: "pod", name: "pods" },
  "/nodes": { words: "node", name: "nodes" },
  "apps/deployments": { words: "deployment", name: "deployments.apps" },
  "batch/jobs": { words: "job", name: "jobs.batch" },
  "batch/cronjobs": { words: "cron job", name: "cronjobs.batch" },
};

/** The characters of a generated name's suffix, as in Rust. */
const SUFFIX = "bcdfghjklmnpqrstvwxz2456789";

/**
 * The command bus as `twigo-core` runs it, over the mock's cluster: the same
 * friction by what a command risks and the context's mode, a plan that runs
 * once with its typed name or once its countdown has ended, the gate's
 * refusal before anything is asked, and each space's last undo.
 */
export class MockBus {
  readonly #waiting = new Map<number, Waiting>();
  readonly #stopping = new Map<number, () => void>();
  readonly #undos = new Map<
    string,
    { readonly id: number; readonly until: number; readonly revert: Revert }
  >();
  /** The run of each space that started last. */
  readonly #latest = new Map<string, PlanId>();
  /** How many times each Job was set running. */
  readonly #started = new WeakMap<Job, number>();
  #next = 0;
  #undoId = 0;
  #jobs = 0;
  readonly #previews = new Map<number, Previewed>();
  #previewId = 0;

  constructor(private readonly host: BusHost) {}

  /**
   * `apply_preview` over the mock: it merges nothing. An edit's annotation
   * `mock.twigo.io/answer`, or else the scenario, names the answer
   * (`unchanged`, `conflicts`, `stale`, `lists-moved` for a stale one that
   * Keep mine cannot answer, `immutable`, `recreate`, `removals` for a ready
   * answer with a removal step, or `merge-patch` for one that goes as a
   * single merge patch); any other edit is ready, an edit that differs from
   * its base only in what an apply leaves out (`status` where the resource
   * has the subresource, the server's metadata) unchanged, saying what it
   * left out. A manifest of an object that an apply left shows it as live.
   * The choices count as they do in Rust: Force takes the conflicting
   * fields, so the edit is ready, and giving up every one of them leaves
   * nothing to send; an edit locked to a version the object has moved from is
   * stale, Keep mine's lock included. An edit that names another object than
   * the one it edits, or a namespaced kind with no namespace, is refused as
   * Rust refuses it, and any preview of an object, a refused one too, ends
   * the plans of older ones.
   */
  applyPreview(request: ApplyRequest): ApplyPreviewed {
    const { space, opened, edited } = request;
    const context = this.host.context(space);
    if (context === undefined)
      throw new IpcError("notFound", `no space ${space}`);
    const object = edited as {
      readonly apiVersion?: string;
      readonly kind?: string;
      readonly metadata?: {
        readonly name?: string;
        readonly namespace?: string;
        readonly annotations?: Readonly<Record<string, string>>;
      };
    };
    const name = object.metadata?.name ?? opened?.target.name ?? "";
    const kind = object.kind ?? opened?.target.gvr.resource ?? "object";
    const namespace = opened?.target.namespace ?? object.metadata?.namespace;
    const resource = opened?.target.gvr.resource ?? `${kind.toLowerCase()}s`;
    const target = `${resource}/${opened?.target.name ?? name}${namespace === undefined ? "" : ` in ${namespace}`}`;
    for (const [id, kept] of this.#previews) {
      if (kept.context === context && kept.target === target) {
        this.#previews.delete(id);
      }
    }
    for (const [id, waiting] of this.#waiting) {
      if (waiting.planned.previewed === `${context}/${target}`) {
        this.#waiting.delete(id);
      }
    }
    const served = this.host.resource(
      object.apiVersion ?? "",
      object.kind ?? "",
    );
    const status = served?.subresources.includes("status") ?? false;
    const same =
      opened !== null &&
      isEqual(editable(opened.base, status), editable(edited, status));
    const ignored = ignoredBy(opened?.base, edited, status);
    const live = opened?.base as
      { kind?: string; apiVersion?: string } | undefined;
    if (opened && live) {
      const refused = (what: string, named: unknown, target: unknown) =>
        new IpcError(
          "invalidInput",
          `the edit names ${what} ${JSON.stringify(named)}, but it is an edit of ${JSON.stringify(target)}`,
        );
      const other = (["apiVersion", "kind"] as const).find(
        (field) => (edited as Record<string, unknown>)[field] !== live[field],
      );
      if (other)
        throw refused(
          other,
          (edited as Record<string, unknown>)[other],
          live[other],
        );
      if (name !== opened.target.name)
        throw refused("name", name, opened.target.name);
      if ((object.metadata?.namespace ?? null) !== opened.target.namespace)
        throw refused(
          "namespace",
          object.metadata?.namespace,
          opened.target.namespace,
        );
    } else if (
      object.metadata?.namespace === undefined &&
      served?.namespaced === true
    ) {
      throw new IpcError("invalidInput", `${name} names no namespace`);
    }
    const what = `${kind.toLowerCase()} ${name}`;
    const group = opened?.target.gvr.group ?? "";
    const named = `${group === "" ? resource : `${resource}.${group}`} ${name}${inNamespace(namespace ?? null)}`;
    const prepared = (
      step: Previewed["step"],
      removals: readonly string[] = [],
    ): number => {
      const id = ++this.#previewId;
      this.#previews.set(id, {
        step,
        context,
        target,
        what,
        named,
        job: resource === "jobs",
        removals,
        edited: edited as Record<string, unknown>,
        resource: opened?.target.gvr,
      });
      return id;
    };
    if (same && object.metadata?.annotations?.[ANSWER] === undefined) {
      return { state: "unchanged", ignored };
    }
    const version = opened
      ? (
          this.host.written(context, opened.target)?.metadata as
            { resourceVersion?: unknown } | undefined
        )?.resourceVersion
      : undefined;
    const moved =
      opened !== null && typeof version === "string" && version !== opened.lock;
    const existing =
      opened === null && served !== undefined && name !== ""
        ? this.host.written(context, {
            gvr: served.gvr,
            namespaced: served.namespaced,
            namespace: served.namespaced
              ? (object.metadata?.namespace ?? null)
              : null,
            name,
          })
        : undefined;
    const ready = (id: number) =>
      this.#ready(id, opened?.base ?? existing, edited, ignored);
    const answer =
      object.metadata?.annotations?.[ANSWER] ??
      (moved ? "stale" : same ? undefined : this.host.answer);
    const stale = (keepable: boolean) =>
      ({
        state: "stale",
        message: keepable
          ? `Operation cannot be fulfilled on ${resource} "${name}": the object has been modified; please apply your changes to the latest version and try again`
          : `.spec.template.spec.containers changed on the server since this edit was opened, and the edit sends it whole, so keeping yours would revert that change`,
        keepable,
      }) as const;
    switch (answer) {
      case "unchanged":
        return { state: "unchanged", ignored: [".status"] };
      case "conflicts": {
        const remaining = CONFLICTS.filter(
          ({ path }) => !request.drop.includes(path),
        );
        if (request.force) return ready(prepared("apply"));
        if (remaining.length === 0) return { state: "unchanged", ignored: [] };
        return { state: "conflicts", conflicts: remaining };
      }
      case "stale":
        // Keep mine locks to the new version and sends the object at it.
        return opened?.locked === undefined || moved
          ? stale(true)
          : ready(prepared("apply"));
      case "lists-moved":
        return stale(false);
      case "immutable":
        return {
          state: "immutable",
          message: `${kind} "${name}" is invalid: spec.selector: Invalid value: field is immutable`,
          recreate: null,
        };
      case "recreate":
        return {
          state: "immutable",
          message: `${kind} "${name}" is invalid: spec.template: Invalid value: field is immutable`,
          recreate: prepared("recreate"),
        };
      case "removals":
        return {
          ...ready(prepared("apply", [".metadata.labels.team"])),
          warnings: ["metadata.annotations: this annotation is deprecated"],
          removals: [".metadata.labels.team"],
          ignored: [".status"],
        };
      case "merge-patch":
        return {
          ...ready(prepared("mergePatch")),
          removals: [".spec.strategy.rollingUpdate"],
          strategy: "mergePatch",
        };
      default:
        return ready(prepared("apply"));
    }
  }

  /** A ready answer: the object as it was, none for a manifest of a new one, against the edit, with nothing to say besides. */
  #ready(
    id: number,
    live: unknown,
    edited: unknown,
    ignored: readonly string[],
  ): Extract<ApplyPreviewed, { state: "ready" }> {
    return {
      state: "ready",
      id,
      live: side(live ?? null),
      result: side(edited),
      warnings: [],
      removals: [],
      ignored: [...ignored],
      strategy: "serverSideApply",
    };
  }

  #apply(space: string, preview: number): Planned {
    const previewed = this.#previews.get(preview);
    if (previewed === undefined) {
      throw new IpcError("notFound", `no preview ${preview} waits to apply`);
    }
    const { step, context, target, what, edited, resource } = previewed;
    const recreate = step === "recreate";
    const write = { verb: recreate ? "delete" : "patch", target };
    this.#authorize(context, this.host.access(context), { write });
    this.#previews.delete(preview);
    const words = recreate ? "Recreated" : "Applied";
    return {
      plan: {
        context,
        question: recreate
          ? `Delete ${what} on ${context} and create it from your edit?`
          : `Apply your changes to ${what} on ${context}?`,
        confirm: recreate ? `Delete and recreate ${what}` : "Apply",
        destructive: recreate,
        consequences: applyConsequences(previewed),
        affected: [],
        kubectl: applyKubectl(previewed),
        doing: `${recreate ? "Recreating" : "Applying"} ${what}`,
      },
      risk: recreate ? { kind: "lasting" } : { kind: "reviewed" },
      write,
      space,
      previewed: `${context}/${target}`,
      run: (tell) => {
        this.host.applied(context, resource, edited);
        tell({ state: "done", text: `${words} ${what}`, undoUntil: null });
      },
    };
  }

  plan(request: PlanRequest): Plan {
    const planned = this.#planned(request);
    const { context } = planned.plan;
    const access = this.host.access(context);
    this.#authorize(context, access, planned);
    const friction = frictionOf(planned.risk, context, access);
    const id: PlanId = ++this.#next;
    this.#waiting.set(id, { planned, friction, since: Date.now() });
    return {
      id,
      ...planned.plan,
      mode: access.mode,
      environment: access.environment,
      friction,
    };
  }

  #planned(request: PlanRequest): Planned {
    switch (request.action) {
      case "delete":
        return this.#delete(request.space, request.targets);
      case "scale":
        return this.#scale(request.space, request.target, request.replicas);
      case "restart":
        return this.#restart(request.space, request.target);
      case "cordon":
        return this.#cordon(request.space, request.node, request.unschedulable);
      case "drain":
        return this.#drain(request.space, request.node);
      case "trigger":
        return this.#trigger(request.space, request.namespace, request.name);
      case "suspend":
        return this.#suspend(request.space, request.target, request.suspend);
      case "undo":
        return this.#undo(request.space);
      case "reveal":
        return this.#reveal(request.object, request.key);
      case "apply":
        return this.#apply(request.space, request.preview);
      case "shell":
        return this.#shell(request.target, request.kind);
    }
  }

  execute(
    { plan: id, typed }: Execute,
    onMessage: (event: OperationEvent) => void,
  ): null {
    const waiting = this.#waiting.get(id);
    if (!waiting) throw new IpcError("notFound", `no plan ${id} waits to run`);
    this.#waiting.delete(id);
    const { planned, friction, since } = waiting;
    const { context } = planned.plan;
    const access = this.host.access(context);
    if (!covers(friction, frictionOf(planned.risk, context, access))) {
      throw new IpcError(
        "conflict",
        `${context} is ${access.mode} now, which asks for more than you confirmed, so Twigo sent nothing`,
      );
    }
    if (
      friction.kind === "countdown" &&
      Date.now() - since < friction.seconds * 1000
    ) {
      throw new IpcError("invalidInput", "the countdown has not ended");
    }
    if (friction.kind === "typed" && typed !== friction.text) {
      throw new IpcError("invalidInput", `type ${friction.text} to confirm`);
    }
    this.#authorize(context, access, planned);
    const { space } = planned;
    if (space !== undefined) {
      this.#latest.set(space, id);
      this.#undos.delete(space);
    }
    let ended = false;
    const end = (undo: Revert | undefined) => {
      ended = true;
      this.#stopping.delete(id);
      if (space === undefined || !undo || this.#latest.get(space) !== id) {
        return null;
      }
      const until = Date.now() + UNDO_MS;
      this.#undos.set(space, { id: ++this.#undoId, until, revert: undo });
      return until;
    };
    this.#stopping.set(id, () => {
      if (ended) return;
      end(undefined);
      onMessage({ state: "stopped", text: planned.stopped ?? "Stopped" });
    });
    const tell = (event: Told) => {
      if (ended) return;
      if (event.state === "undoable") {
        const undoUntil = end(event.revert);
        onMessage({ state: "done", text: event.text, undoUntil });
        return;
      }
      if (event.state !== "running") end(undefined);
      onMessage(event);
    };
    setTimeout(() => {
      try {
        planned.run(tell, () => !ended);
      } catch (error) {
        if (!(error instanceof IpcError)) throw error;
        tell({
          state: "failed",
          error: { kind: error.kind, message: error.message },
        });
      }
    }, 0);
    return null;
  }

  cancel(id: PlanId): null {
    this.#waiting.delete(id);
    this.#stopping.get(id)?.();
    this.#stopping.delete(id);
    return null;
  }

  #authorize(
    context: string,
    access: ContextAccess,
    { write }: Pick<Planned, "write">,
  ): void {
    if (!write || access.mode !== "read-only") return;
    const blocked: Blocked = {
      context,
      mode: access.mode,
      source: access.source,
      class: write.class ?? "write",
      reason: "mode",
      verb: write.verb,
      target: write.target,
    };
    throw new IpcError(
      "permissions",
      `${context} is read-only${setBy(access.source)}, so Twigo did not send ${write.verb} ${write.target}`,
      blocked,
    );
  }

  /** The space's context, refused in read-only before anything is read, as Rust refuses it. */
  #context(space: string, write: Write): string {
    const context = this.host.context(space);
    if (context === undefined)
      throw new IpcError("notFound", `no space ${space}`);
    this.#authorize(context, this.host.access(context), { write });
    return context;
  }

  #deployment(cluster: Cluster, target: ResourceRef): Pod[] {
    const { namespace, name } = target;
    const pods = namespace === null ? [] : cluster.podsOf(namespace, name);
    const emptied = cluster.emptied.has(`${namespace ?? ""}/${name}`);
    if (pods.length === 0 && !emptied) {
      throw new IpcError("notFound", `deployments.apps "${name}" not found`);
    }
    return pods;
  }

  #delete(space: string, targets: readonly ResourceRef[]): Planned {
    const [first] = targets;
    if (!first) throw new IpcError("invalidInput", "nothing to delete");
    const { group, resource } = first.gvr;
    const namespaceOf = (target: ResourceRef) =>
      target.namespaced ? target.namespace : null;
    const writes = targets.map((target) => {
      const namespace = namespaceOf(target);
      return `${resource}/${target.name}${namespace === null ? "" : ` in ${namespace}`}`;
    });
    const context = this.#context(space, {
      verb: "delete",
      target: writes[0] ?? "",
    });
    const kind = KINDS[`${group}/${resource}`];
    if (!kind) {
      throw new IpcError(
        "notFound",
        `the mock backend deletes only pods, nodes, deployments, jobs and cron jobs, not ${resource}`,
      );
    }
    const cluster = this.host.cluster(context);
    const gone = (name: string) =>
      new IpcError("notFound", `${kind.name} "${name}" not found`);
    const objects: ObjectRef[] = [];
    const following: ObjectRef[] = [];
    /** Whether each object is still there, and what removes it. */
    const deletes: { there: () => boolean; remove: () => void }[] = [];
    let replacedBy: string | undefined;
    // As Rust's: an object gone since it was marked stays out.
    const kept: ResourceRef[] = [];
    const left: string[] = [];
    let missing: IpcError | undefined;
    for (const target of targets) {
      try {
        const namespace = namespaceOf(target);
        const { name } = target;
        const object = (objectKind: string, version: string): ObjectRef => ({
          group,
          version,
          kind: objectKind,
          namespace,
          name,
        });
        if (resource === "pods") {
          const pod = cluster.pods.find(
            (candidate) =>
              candidate.namespace === namespace && candidate.name === name,
          );
          if (!pod) throw gone(name);
          objects.push(object("Pod", "v1"));
          replacedBy = `${deploymentOf(pod)}-${pod.templateHash}`;
          deletes.push({
            there: () => cluster.pods.includes(pod),
            remove: () => {
              cluster.deletePod(pod, Date.now());
            },
          });
        } else if (resource === "nodes") {
          if (!cluster.nodes.some((node) => node.name === name))
            throw gone(name);
          objects.push(object("Node", "v1"));
          deletes.push({
            there: () => cluster.nodes.some((node) => node.name === name),
            remove: () => {
              cluster.deleteNode(name);
            },
          });
        } else if (resource === "deployments") {
          const pods = this.#deployment(cluster, target);
          objects.push(object("Deployment", "v1"));
          const sets = new Set(pods.map((pod) => pod.templateHash));
          for (const hash of sets) {
            following.push({
              group: "apps",
              version: "v1",
              kind: "ReplicaSet",
              namespace,
              name: `${name}-${hash}`,
            });
          }
          following.push(...pods.map(podRef));
          const key = `${namespace ?? ""}/${name}`;
          deletes.push({
            there: () =>
              namespace !== null &&
              (cluster.podsOf(namespace, name).length > 0 ||
                cluster.emptied.has(key)),
            remove: () => {
              if (namespace !== null) cluster.deleteDeployment(namespace, name);
              cluster.emptied.delete(key);
            },
          });
        } else {
          const list: (CronJob | Job)[] =
            resource === "jobs" ? cluster.jobs : cluster.cronJobs;
          const found = list.find(
            (candidate) =>
              candidate.namespace === namespace && candidate.name === name,
          );
          if (!found) throw gone(name);
          objects.push(object(resource === "jobs" ? "Job" : "CronJob", "v1"));
          if (resource === "cronjobs") {
            following.push(
              ...cluster.jobs
                .filter(
                  (job) => job.namespace === namespace && job.owner === name,
                )
                .map((job) => ({
                  group: "batch",
                  version: "v1",
                  kind: "Job",
                  namespace,
                  name: job.name,
                })),
            );
          }
          deletes.push({
            there: () => list.includes(found),
            remove: () => {
              list.splice(list.indexOf(found), 1);
              if (resource === "cronjobs") {
                for (const job of cluster.jobs.filter(
                  (candidate) =>
                    candidate.namespace === namespace &&
                    candidate.owner === name,
                ))
                  cluster.jobs.splice(cluster.jobs.indexOf(job), 1);
              }
              cluster.version++;
            },
          });
        }
        kept.push(target);
      } catch (error) {
        if (!(error instanceof IpcError) || error.kind !== "notFound") {
          throw error;
        }
        left.push(target.name);
        missing ??= error;
      }
    }
    const [shown] = kept;
    if (!shown) {
      throw missing ?? new IpcError("invalidInput", "nothing to delete");
    }
    const several = kept.length > 1;
    const namespaces = new Set(
      kept.map(namespaceOf).filter((namespace) => namespace !== null),
    );
    const place =
      namespaces.size === 0
        ? ""
        : namespaces.size === 1
          ? ` in ${[...namespaces][0] ?? ""}`
          : ` in ${String(namespaces.size)} namespaces`;
    const what = several
      ? counted(kept.length, kind.words)
      : `${kind.words} ${shown.name}`;
    const byNamespace = new Map<string | null, string[]>();
    for (const target of kept) {
      const namespace = namespaceOf(target);
      byNamespace.set(namespace, [
        ...(byNamespace.get(namespace) ?? []),
        target.name,
      ]);
    }
    const kubectl = [...byNamespace.entries()]
      .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))
      .map(
        ([namespace, names]) =>
          `kubectl --context ${context} delete ${kind.name} ${names.join(" ")}${inNamespace(namespace)}`,
      )
      .join("; ");
    const wide = resource === "nodes";
    const consequences: string[] = [];
    let risk: Risk;
    if (several) {
      risk = { kind: "wide", name: context };
    } else if (wide) {
      risk = { kind: "wide", name: shown.name };
    } else if (resource === "pods" && replacedBy !== undefined) {
      consequences.push(`Its replica set ${replacedBy} replaces it.`);
      risk = { kind: "replaced" };
    } else {
      risk = { kind: "lasting" };
    }
    if (left.length > 0) {
      consequences.push(
        `Gone already, so not in this delete: ${left.join(", ")}.`,
      );
    }
    const affected: Affected[] = [];
    if (several) affected.push({ title: "Deletes", objects });
    if (following.length > 0) {
      affected.push({
        title: several ? "With them go" : "With it go",
        objects: following,
      });
    }
    return {
      stopped: several
        ? `Stopped waiting for ${what}, which are still being deleted`
        : `Stopped waiting for ${what}, which is still being deleted`,
      plan: {
        context,
        question: `Delete ${what}${place} from ${context}?`,
        confirm: several ? `Delete ${what}` : `Delete ${kind.words}`,
        destructive: true,
        consequences,
        affected,
        kubectl,
        doing: `Deleting ${what}`,
      },
      risk,
      write: { verb: "delete", target: writes[0] ?? "" },
      space,
      run: (tell) => {
        // As Rust's: what went before the run is told at once, and the
        // wait counts only what it sent.
        const going = deletes.filter(({ there }) => there());
        const gone = deletes.length - going.length;
        const text =
          gone === 0
            ? `Deleted ${what}`
            : several
              ? `Deleted ${counted(going.length, kind.words)}; ${String(gone)} ${gone === 1 ? "was" : "were"} already gone`
              : `${capital(what)} was already gone`;
        if (going.length === 0) {
          tell({ state: "done", text, undoUntil: null });
          return;
        }
        tell({
          state: "running",
          text: several
            ? `Waiting for ${String(going.length)} of ${counted(going.length, kind.words)} to go`
            : `Waiting for ${what} to go`,
        });
        setTimeout(() => {
          for (const { remove } of going) remove();
          this.host.changed();
          tell({ state: "done", text, undoUntil: null });
        }, GRACE_MS);
      },
    };
  }

  #scale(space: string, target: ResourceRef, replicas: number): Planned {
    const { namespace, name } = target;
    const write = {
      verb: "patch",
      target: `deployments/${name}/scale in ${namespace ?? ""}`,
    };
    const context = this.#context(space, write);
    if (target.gvr.resource !== "deployments") {
      throw new IpcError(
        "notFound",
        `the mock backend scales only deployments, not ${target.gvr.resource}`,
      );
    }
    const cluster = this.host.cluster(context);
    const pods = this.#deployment(cluster, target);
    const what = `deployment ${name}`;
    if (pods.length === replicas) {
      throw new IpcError(
        "invalidInput",
        `${capital(what)} has ${String(replicas)} replicas already`,
      );
    }
    const zero = replicas === 0;
    const ns = namespace ?? "";
    const line = (words: string) =>
      `kubectl --context ${context} scale deployments.apps ${name} ${words}${inNamespace(namespace)}`;
    return {
      plan: {
        context,
        question: `Scale ${what} in ${ns} to ${String(replicas)} on ${context}?`,
        confirm: `Scale to ${String(replicas)}`,
        destructive: zero,
        consequences: zero ? ["Its pods go, and none take their place."] : [],
        affected:
          zero && pods.length > 0
            ? [{ title: "Its pods go", objects: pods.map(podRef) }]
            : [],
        kubectl: line(
          `--current-replicas ${String(pods.length)} --replicas ${String(replicas)}`,
        ),
        doing: `Scaling ${what} to ${String(replicas)}`,
      },
      risk: zero ? { kind: "lasting" } : { kind: "reversible" },
      write,
      space,
      run: (tell) => {
        this.#deployment(cluster, target);
        const from = cluster.podsOf(ns, name).length;
        if (from === replicas) {
          tell({
            state: "done",
            text: `${capital(what)} has ${String(replicas)} replicas already`,
            undoUntil: null,
          });
          return;
        }
        if (from !== pods.length) {
          throw new IpcError(
            "conflict",
            `${capital(what)} has ${String(from)} replicas now, not the ${String(pods.length)} Twigo asked about, so it scaled nothing`,
          );
        }
        cluster.scale(ns, name, replicas, Date.now());
        this.host.changed();
        tell({
          state: "undoable",
          text: `Scaled ${what} to ${String(replicas)}`,
          revert: {
            context,
            write,
            asks: () => {
              if (from > 0) return AT_ONCE;
              const going = cluster.podsOf(ns, name);
              return {
                risk: { kind: "lasting" },
                consequences: ["Its pods go, and none take their place."],
                affected:
                  going.length > 0
                    ? [{ title: "Its pods go", objects: going.map(podRef) }]
                    : [],
              };
            },
            question: `Scale ${what} in ${ns} back to ${String(from)} on ${context}?`,
            doing: `Scaling ${what} back to ${String(from)}`,
            done: `Scaled ${what} back to ${String(from)}`,
            kubectl: line(
              `--current-replicas ${String(replicas)} --replicas ${String(from)}`,
            ),
            put: () => {
              cluster.scale(ns, name, from, Date.now());
            },
          },
        });
      },
    };
  }

  #restart(space: string, target: ResourceRef): Planned {
    const { namespace, name } = target;
    const write = {
      verb: "patch",
      target: `deployments/${name} in ${namespace ?? ""}`,
    };
    const context = this.#context(space, write);
    if (target.gvr.resource !== "deployments") {
      throw new IpcError(
        "notFound",
        `the mock backend restarts only deployments, not ${target.gvr.resource}`,
      );
    }
    const cluster = this.host.cluster(context);
    const pods = this.#deployment(cluster, target);
    const what = `deployment ${name}`;
    return {
      plan: {
        context,
        question: `Restart ${what} in ${namespace ?? ""} on ${context}?`,
        confirm: "Restart deployment",
        destructive: false,
        consequences: [
          "Its pods are replaced in turn, as its update strategy says.",
        ],
        affected:
          pods.length > 0
            ? [{ title: "Replaces", objects: pods.map(podRef) }]
            : [],
        kubectl: `kubectl --context ${context} rollout restart deployments.apps/${name}${inNamespace(namespace)}`,
        doing: `Restarting ${what}`,
      },
      risk: { kind: "lasting" },
      write,
      space,
      run: (tell) => {
        this.#deployment(cluster, target);
        cluster.restart(namespace ?? "", name, Date.now());
        this.host.changed();
        tell({ state: "done", text: `Restarted ${what}`, undoUntil: null });
      },
    };
  }

  #cordon(space: string, name: string, unschedulable: boolean): Planned {
    const write = { verb: "patch", target: `nodes/${name}` };
    const context = this.#context(space, write);
    const cluster = this.host.cluster(context);
    const node = cluster.nodes.find((candidate) => candidate.name === name);
    if (!node) throw new IpcError("notFound", `nodes "${name}" not found`);
    const already = `Node ${name} is ${unschedulable ? "cordoned already" : "not cordoned"}`;
    if (cordoned(node) === unschedulable) {
      throw new IpcError("invalidInput", already);
    }
    const words = (cordon: boolean) =>
      cordon
        ? { verb: "cordon", doing: "Cordoning", done: "Cordoned" }
        : { verb: "uncordon", doing: "Uncordoning", done: "Uncordoned" };
    const { verb, doing, done } = words(unschedulable);
    const back = words(!unschedulable);
    return {
      plan: {
        context,
        question: `${capital(verb)} node ${name} on ${context}?`,
        confirm: `${capital(verb)} node`,
        destructive: false,
        consequences: [
          unschedulable
            ? "No new pods are scheduled on it; those on it stay."
            : "New pods can be scheduled on it again.",
        ],
        affected: [],
        kubectl: `kubectl --context ${context} ${verb} ${name}`,
        doing: `${doing} node ${name}`,
      },
      risk: { kind: "reversible" },
      write,
      space,
      run: (tell) => {
        if (!cluster.nodes.includes(node)) {
          throw new IpcError("notFound", `nodes "${name}" not found`);
        }
        if (cordoned(node) === unschedulable) {
          tell({ state: "done", text: already, undoUntil: null });
          return;
        }
        cluster.cordon(name, unschedulable);
        this.host.changed();
        tell({
          state: "undoable",
          text: `${done} node ${name}`,
          revert: {
            context,
            write,
            asks: () => AT_ONCE,
            question: `${capital(back.verb)} node ${name} on ${context}?`,
            doing: `${back.doing} node ${name}`,
            done: `${back.done} node ${name}`,
            kubectl: `kubectl --context ${context} ${back.verb} ${name}`,
            put: () => {
              cluster.cordon(name, !unschedulable);
            },
          },
        });
      },
    };
  }

  #drain(space: string, name: string): Planned {
    const write = { verb: "patch", target: `nodes/${name}` };
    const context = this.#context(space, write);
    const cluster = this.host.cluster(context);
    if (!cluster.nodes.some((node) => node.name === name)) {
      throw new IpcError("notFound", `nodes "${name}" not found`);
    }
    const pods = cluster.pods.filter((pod) => pod.node === name);
    const total = counted(pods.length, "pod");
    return {
      stopped: `Stopped draining node ${name}, which stays cordoned; it evicted 0 of ${total}`,
      plan: {
        context,
        question: `Drain node ${name} on ${context}?`,
        confirm: "Drain node",
        destructive: true,
        consequences: [
          "It is cordoned first, and stays cordoned.",
          "A disruption budget may hold a pod back; Twigo asks again every 5 s.",
        ],
        affected:
          pods.length > 0
            ? [{ title: "Evicts", objects: pods.map(podRef) }]
            : [],
        kubectl: `kubectl --context ${context} drain ${name} --ignore-daemonsets`,
        doing: `Draining node ${name}`,
      },
      risk: { kind: "lasting" },
      write,
      space,
      run: (tell, live) => {
        if (!cluster.nodes.some((node) => node.name === name)) {
          throw new IpcError("notFound", `nodes "${name}" not found`);
        }
        cluster.cordon(name, true);
        this.host.changed();
        tell({
          state: "running",
          text: `Evicting ${total} from node ${name}`,
        });
        setTimeout(() => {
          if (!live()) return;
          cluster.drain(name, Date.now());
          this.host.changed();
          tell({
            state: "done",
            text: `Drained node ${name}`,
            undoUntil: null,
          });
        }, GRACE_MS);
      },
    };
  }

  #trigger(space: string, namespace: string, name: string): Planned {
    const write = { verb: "create", target: `jobs in ${namespace}` };
    const context = this.#context(space, write);
    const cluster = this.host.cluster(context);
    if (
      !cluster.cronJobs.some(
        (cronJob) => cronJob.namespace === namespace && cronJob.name === name,
      )
    ) {
      throw new IpcError("notFound", `cronjobs.batch "${name}" not found`);
    }
    const serial = ++this.#jobs;
    const suffix = Array.from({ length: 5 }, (_, i) =>
      SUFFIX.charAt((serial * 31 + i * 7) % SUFFIX.length),
    ).join("");
    const job = `${name.slice(0, 50).replace(/[-.]+$/, "")}-manual-${suffix}`;
    return {
      plan: {
        context,
        question: `Trigger cron job ${name} in ${namespace} on ${context} now?`,
        confirm: "Trigger cron job",
        destructive: false,
        consequences: [
          `Job ${job} runs once from its template, beside its schedule.`,
        ],
        affected: [],
        kubectl: `kubectl --context ${context} create job ${job} --from cronjob/${name} -n ${namespace}`,
        doing: `Triggering cron job ${name}`,
      },
      risk: { kind: "lasting" },
      write,
      space,
      run: (tell) => {
        if (
          !cluster.cronJobs.some(
            (cronJob) =>
              cronJob.namespace === namespace && cronJob.name === name,
          )
        ) {
          throw new IpcError("notFound", `cronjobs.batch "${name}" not found`);
        }
        cluster.trigger(namespace, name, job, Date.now());
        this.host.changed();
        const made = cluster.jobs.find(
          (candidate) =>
            candidate.namespace === namespace && candidate.name === job,
        );
        if (made) this.#runs(cluster, made);
        tell({ state: "done", text: `Created job ${job}`, undoUntil: null });
      },
    };
  }

  #suspend(space: string, target: ResourceRef, suspend: boolean): Planned {
    const { resource } = target.gvr;
    const { namespace, name } = target;
    const write = {
      verb: "patch",
      target: `${resource}/${name} in ${namespace ?? ""}`,
    };
    const context = this.#context(space, write);
    if (resource !== "jobs" && resource !== "cronjobs") {
      throw new IpcError("invalidInput", "Twigo suspends jobs and cron jobs");
    }
    const cluster = this.host.cluster(context);
    const list: (CronJob | Job)[] =
      resource === "jobs" ? cluster.jobs : cluster.cronJobs;
    const found = list.find(
      (candidate) =>
        candidate.namespace === namespace && candidate.name === name,
    );
    const kind = resource === "jobs" ? "job" : "cron job";
    if (!found) {
      throw new IpcError("notFound", `${resource}.batch "${name}" not found`);
    }
    const what = `${kind} ${name}`;
    const already = `${capital(what)} is ${suspend ? "suspended already" : "not suspended"}`;
    if (found.suspend === suspend) {
      throw new IpcError("invalidInput", already);
    }
    const ended = () => "completed" in found && found.completed !== null;
    const nothing = () =>
      new IpcError(
        "invalidInput",
        `${capital(what)} has completed, so there is nothing to ${suspend ? "suspend" : "resume"}`,
      );
    if (ended()) throw nothing();
    const left = () =>
      ended()
        ? `${capital(what)} has completed since you ${suspend ? "suspended" : "resumed"} it, so Twigo left it`
        : undefined;
    const words = (on: boolean) =>
      on
        ? { verb: "Suspend", doing: "Suspending", done: "Suspended" }
        : { verb: "Resume", doing: "Resuming", done: "Resumed" };
    const { verb, doing, done } = words(suspend);
    const back = words(!suspend);
    const line = (on: boolean) =>
      `kubectl --context ${context} patch ${resource}.batch ${name} --type merge -p '{"spec":{"suspend":${String(on)}}}'${inNamespace(namespace)}`;
    // As Rust's `suspend::stopping`: the mock's Jobs run no pods it lists.
    const stopping = (): Asked =>
      "completed" in found && found.completed === null && !found.suspend
        ? {
            risk: { kind: "lasting" },
            consequences: [
              "Its running pods stop and their work is lost; when it resumes, new ones start.",
            ],
            affected: [],
          }
        : {
            risk: { kind: "reversible" },
            consequences: [
              "Its running pods stop, and none start until it resumes.",
            ],
            affected: [],
          };
    const asked: Asked =
      resource === "cronjobs"
        ? suspend
          ? {
              ...AT_ONCE,
              consequences: [
                "No new jobs start on its schedule until it resumes; those running go on.",
              ],
            }
          : RESUMES
        : suspend
          ? stopping()
          : { ...AT_ONCE, consequences: ["It starts its pods again."] };
    return {
      plan: {
        context,
        question: `${verb} ${what} in ${namespace ?? ""} on ${context}?`,
        confirm: `${verb} ${kind}`,
        destructive: asked.destructive ?? asked.risk.kind === "lasting",
        consequences: asked.consequences,
        affected: asked.affected,
        kubectl: line(suspend),
        doing: `${doing} ${what}`,
      },
      risk: asked.risk,
      write,
      space,
      run: (tell) => {
        if (!list.includes(found)) {
          throw new IpcError(
            "notFound",
            `${resource}.batch "${name}" not found`,
          );
        }
        if (found.suspend === suspend) {
          tell({ state: "done", text: already, undoUntil: null });
          return;
        }
        if (ended()) throw nothing();
        this.#switch(cluster, found, suspend);
        this.host.changed();
        tell({
          state: "undoable",
          text: `${done} ${what}`,
          revert: {
            context,
            write,
            asks: () => {
              if (suspend && resource === "cronjobs") return RESUMES;
              if (suspend || resource !== "jobs") return AT_ONCE;
              const why = left();
              if (why) throw new IpcError("conflict", why);
              return stopping();
            },
            left: resource === "jobs" ? left : undefined,
            question: `${back.verb} ${what} in ${namespace ?? ""} on ${context}?`,
            doing: `${back.doing} ${what}`,
            done: `${back.done} ${what}`,
            kubectl: line(!suspend),
            put: () => {
              this.#switch(cluster, found, !suspend);
            },
          },
        });
      },
    };
  }

  /** Completes a Job its latest start set running after its time, unless it was suspended or went meanwhile. */
  #runs(cluster: Cluster, job: Job): void {
    const start = (this.#started.get(job) ?? 0) + 1;
    this.#started.set(job, start);
    setTimeout(() => {
      if (
        this.#started.get(job) !== start ||
        !cluster.jobs.includes(job) ||
        job.suspend ||
        job.completed !== null
      ) {
        return;
      }
      job.completed = Date.now();
      cluster.version++;
      this.host.changed();
    }, JOB_MS);
  }

  /** Suspends a Job or a CronJob, or resumes it; a resumed Job runs again. */
  #switch(cluster: Cluster, found: CronJob | Job, suspend: boolean): void {
    cluster.suspend(found, suspend);
    if (!suspend && "completed" in found) this.#runs(cluster, found);
  }

  #undo(space: string): Planned {
    const slot = this.#undos.get(space);
    if (!slot || Date.now() >= slot.until) {
      throw new IpcError("notFound", "nothing in this space can be undone now");
    }
    const { id, revert } = slot;
    const asked = revert.asks();
    return {
      plan: {
        context: revert.context,
        question: revert.question,
        confirm: "Undo",
        destructive: asked.destructive ?? asked.risk.kind === "lasting",
        consequences: asked.consequences,
        affected: asked.affected,
        kubectl: revert.kubectl,
        doing: revert.doing,
      },
      risk: asked.risk,
      write: revert.write,
      run: (tell) => {
        const live = this.#undos.get(space);
        if (live?.id !== id || Date.now() >= live.until) {
          throw new IpcError(
            "conflict",
            "the undo ended before it ran, so Twigo put nothing back",
          );
        }
        this.#undos.delete(space);
        const why = revert.left?.();
        if (why) throw new IpcError("conflict", why);
        revert.put();
        this.host.changed();
        tell({ state: "done", text: revert.done, undoUntil: null });
      },
    };
  }

  #shell(target: ShellTarget, kind: ShellKind): Planned {
    const { space, namespace, pod, container } = target;
    const attach = kind === "attach";
    const write: Write = {
      verb: "create",
      target: `pods/${pod}/${attach ? "attach" : "exec"} in ${namespace}`,
      class: "exec",
    };
    const context = this.#context(space, write);
    if (
      !this.host
        .containers(context, namespace, pod)
        .containers.includes(container)
    ) {
      throw new IpcError(
        "notFound",
        `container ${container} does not run in pod ${pod}`,
      );
    }
    const where = `container ${container} of pod ${pod} on ${context}`;
    return {
      plan: {
        context,
        question: attach
          ? `Attach to the main process of ${where}?`
          : `Open a shell in ${where}?`,
        confirm: attach ? "Attach" : "Open shell",
        destructive: false,
        consequences: [
          attach
            ? "What you type goes to the container's main process, and an interrupt may stop it."
            : "It runs in the container with the rights of its service account.",
        ],
        affected: [],
        kubectl: attach
          ? `kubectl --context ${context} attach -it ${pod} -n ${namespace} -c ${container}`
          : `kubectl --context ${context} exec -it ${pod} -n ${namespace} -c ${container} -- sh -c 'export TERM=xterm-256color; command -v bash >/dev/null && exec bash || exec sh'`,
        doing: `${attach ? "Attaching to" : "Opening a shell in"} ${pod}`,
      },
      risk: { kind: "reviewed" },
      write,
      run: (tell) => {
        tell({ state: "session", id: this.host.session(target, kind) });
      },
    };
  }

  #reveal(object: number, key: string): Planned {
    const { context, namespace, name } = this.host.secret(object);
    const { binary } = this.host.reveal(object, key);
    const template = binary
      ? `'go-template={{index .data "${key}"}}'`
      : `'go-template={{index .data "${key}" | base64decode}}'`;
    return {
      plan: {
        context,
        question: `Reveal ${key} of secret ${name} in ${namespace} from ${context}?`,
        confirm: "Reveal value",
        destructive: false,
        consequences: [
          `It shows until you hide it or close the secret${binary ? ", as base64" : ""}.`,
        ],
        affected: [],
        kubectl: `kubectl --context ${context} get secrets ${name} -n ${namespace} -o ${template}`,
        doing: `Revealing ${key}`,
      },
      risk: { kind: "reveal" },
      run: (tell) => {
        const { value, binary: isBinary } = this.host.reveal(object, key);
        tell({ state: "revealed", value, binary: isBinary });
      },
    };
  }
}
