import { IpcError } from "../error";
import type {
  Affected,
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
  ResourceRef,
} from "../generated";
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

/** What a command risks, as `twigo_policy::friction::Risk` says. */
type Risk =
  | { readonly kind: "reversible" }
  | { readonly kind: "replaced" }
  | { readonly kind: "lasting" }
  | { readonly kind: "wide"; readonly name: string }
  | { readonly kind: "reveal" };

/** `twigo_policy::friction::friction`. */
function frictionOf(
  risk: Risk,
  context: string,
  access: ContextAccess,
): Friction {
  if (risk.kind === "reveal") {
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

/**
 * What puts an action back, as `actions::undo::Revert` holds it. Only the
 * bus writes to the mock's cluster, and every action takes the space's
 * undo, so no object changes under one: Rust's check that nobody changed
 * it has nothing to find here.
 */
interface Revert {
  readonly context: string;
  readonly write: { readonly verb: string; readonly target: string };
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

interface Planned {
  readonly plan: Omit<Plan, "id" | "friction" | "mode" | "environment">;
  readonly risk: Risk;
  /** What the gate reads of the write it sends, none for a Reveal. */
  readonly write?: { readonly verb: string; readonly target: string };
  /** The space whose last action it is once it starts; none for an undo, which takes its own. */
  readonly space?: string;
  /** What a stop while it runs says. */
  readonly stopped?: string;
  readonly run: Run;
}

interface Waiting {
  readonly planned: Planned;
  readonly friction: Friction;
  readonly since: number;
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
  /** Tells the lists that the cluster changed. */
  changed(): void;
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
  #next = 0;
  #undoId = 0;
  #jobs = 0;

  constructor(private readonly host: BusHost) {}

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
      class: "write",
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
  #context(space: string, write: { verb: string; target: string }): string {
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
    const deletes: (() => void)[] = [];
    let replacedBy: string | undefined;
    for (const target of targets) {
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
        deletes.push(() => {
          const still = cluster.pods.find((candidate) => candidate === pod);
          if (still) cluster.deletePod(still, Date.now());
        });
      } else if (resource === "nodes") {
        if (!cluster.nodes.some((node) => node.name === name)) throw gone(name);
        objects.push(object("Node", "v1"));
        deletes.push(() => {
          cluster.deleteNode(name);
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
        deletes.push(() => {
          if (namespace !== null) cluster.deleteDeployment(namespace, name);
          cluster.emptied.delete(`${namespace ?? ""}/${name}`);
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
        deletes.push(() => {
          list.splice(list.indexOf(found), 1);
          if (resource === "cronjobs") {
            for (const job of cluster.jobs.filter(
              (candidate) =>
                candidate.namespace === namespace && candidate.owner === name,
            ))
              cluster.jobs.splice(cluster.jobs.indexOf(job), 1);
          }
          cluster.version++;
        });
      }
    }
    const several = targets.length > 1;
    const namespaces = new Set(
      targets.map(namespaceOf).filter((namespace) => namespace !== null),
    );
    const place =
      namespaces.size === 0
        ? ""
        : namespaces.size === 1
          ? ` in ${[...namespaces][0] ?? ""}`
          : ` in ${String(namespaces.size)} namespaces`;
    const what = several
      ? counted(targets.length, kind.words)
      : `${kind.words} ${first.name}`;
    const byNamespace = new Map<string | null, string[]>();
    for (const target of targets) {
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
      .join(" && ");
    const wide = resource === "nodes";
    const consequences: string[] = [];
    let risk: Risk;
    if (several) {
      risk = { kind: "wide", name: context };
    } else if (wide) {
      risk = { kind: "wide", name: first.name };
    } else if (resource === "pods" && replacedBy !== undefined) {
      consequences.push(`Its replica set ${replacedBy} replaces it.`);
      risk = { kind: "replaced" };
    } else {
      risk = { kind: "lasting" };
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
        consequences,
        affected,
        kubectl,
        doing: `Deleting ${what}`,
      },
      risk,
      write: { verb: "delete", target: writes[0] ?? "" },
      space,
      run: (tell) => {
        tell({
          state: "running",
          text: several
            ? `Waiting for ${String(targets.length)} of ${what} to go`
            : `Waiting for ${what} to go`,
        });
        setTimeout(() => {
          for (const remove of deletes) remove();
          this.host.changed();
          tell({ state: "done", text: `Deleted ${what}`, undoUntil: null });
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
        consequences: zero ? ["Its pods go, and none take their place."] : [],
        affected:
          zero && pods.length > 0
            ? [{ title: "Its pods go", objects: pods.map(podRef) }]
            : [],
        kubectl: line(`--replicas ${String(replicas)}`),
        doing: `Scaling ${what} to ${String(replicas)}`,
      },
      risk: zero ? { kind: "lasting" } : { kind: "reversible" },
      write,
      space,
      run: (tell) => {
        const from = cluster.podsOf(ns, name).length;
        cluster.scale(ns, name, replicas, Date.now());
        this.host.changed();
        tell({
          state: "undoable",
          text: `Scaled ${what} to ${String(replicas)}`,
          revert: {
            context,
            write,
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
    if (cordoned(node) === unschedulable) {
      throw new IpcError(
        "invalidInput",
        `Node ${name} is ${unschedulable ? "cordoned already" : "not cordoned"}`,
      );
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
        cluster.cordon(name, unschedulable);
        this.host.changed();
        tell({
          state: "undoable",
          text: `${done} node ${name}`,
          revert: {
            context,
            write,
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
        cluster.trigger(namespace, name, job, Date.now());
        this.host.changed();
        setTimeout(() => {
          const made = cluster.jobs.find(
            (candidate) =>
              candidate.namespace === namespace && candidate.name === job,
          );
          if (made?.completed === null) {
            made.completed = Date.now();
            cluster.version++;
            this.host.changed();
          }
        }, JOB_MS);
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
    if (found.suspend === suspend) {
      throw new IpcError(
        "invalidInput",
        `${capital(what)} is ${suspend ? "suspended already" : "not suspended"}`,
      );
    }
    const words = (on: boolean) =>
      on
        ? { verb: "Suspend", doing: "Suspending", done: "Suspended" }
        : { verb: "Resume", doing: "Resuming", done: "Resumed" };
    const { verb, doing, done } = words(suspend);
    const back = words(!suspend);
    const line = (on: boolean) =>
      `kubectl --context ${context} patch ${resource}.batch ${name} --type merge -p '{"spec":{"suspend":${String(on)}}}'${inNamespace(namespace)}`;
    const consequence =
      resource === "cronjobs"
        ? suspend
          ? "No new jobs start on its schedule until it resumes; those running go on."
          : "Its schedule starts jobs again."
        : suspend
          ? "Its running pods stop, and none start until it resumes."
          : "It starts its pods again.";
    return {
      plan: {
        context,
        question: `${verb} ${what} in ${namespace ?? ""} on ${context}?`,
        confirm: `${verb} ${kind}`,
        consequences: [consequence],
        affected: [],
        kubectl: line(suspend),
        doing: `${doing} ${what}`,
      },
      risk: { kind: "reversible" },
      write,
      space,
      run: (tell) => {
        cluster.suspend(found, suspend);
        this.host.changed();
        tell({
          state: "undoable",
          text: `${done} ${what}`,
          revert: {
            context,
            write,
            question: `${back.verb} ${what} in ${namespace ?? ""} on ${context}?`,
            doing: `${back.doing} ${what}`,
            done: `${back.done} ${what}`,
            kubectl: line(!suspend),
            put: () => {
              cluster.suspend(found, !suspend);
            },
          },
        });
      },
    };
  }

  #undo(space: string): Planned {
    const slot = this.#undos.get(space);
    if (!slot || Date.now() >= slot.until) {
      throw new IpcError("notFound", "nothing in this space can be undone now");
    }
    const { id, revert } = slot;
    return {
      plan: {
        context: revert.context,
        question: revert.question,
        confirm: "Undo",
        consequences: [],
        affected: [],
        kubectl: revert.kubectl,
        doing: revert.doing,
      },
      risk: { kind: "reversible" },
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
        revert.put();
        this.host.changed();
        tell({ state: "done", text: revert.done, undoUntil: null });
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
