import { IpcError } from "../error";
import type {
  Blocked,
  ContextAccess,
  Execute,
  Friction,
  ModeSource,
  OperationEvent,
  Plan,
  PlanId,
  PlanRequest,
  ResourceRef,
} from "../generated";
import { deploymentOf, type Cluster } from "./cluster";

/** How long a toast counts down before a pod its controller replaces is deleted, as in Rust. */
const COUNTDOWN_SECONDS = 5;
/** How long a deleted pod takes to go, as its grace period would hold it. */
const GRACE_MS = 1500;

/** What a command risks, as `twigo_policy::friction::Risk` says. */
type Risk =
  | { readonly kind: "replaced" }
  | { readonly kind: "one" }
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
    case "replaced":
      return access.environment === "production"
        ? { kind: "confirm" }
        : { kind: "countdown", seconds: COUNTDOWN_SECONDS };
    case "one":
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

/** What a run tells as it goes, and how it ends. */
type Run = (tell: (event: OperationEvent) => void) => void;

interface Planned {
  readonly plan: Omit<Plan, "id" | "friction" | "mode" | "environment">;
  readonly risk: Risk;
  /** What the gate reads of the write it sends, none for a Reveal. */
  readonly write?: { readonly verb: string; readonly target: string };
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

/**
 * The command bus as `twigo-core` runs it, over the mock's cluster: the same
 * friction by what a command risks and the context's mode, a plan that runs
 * once with its typed name or once its countdown has ended, and the gate's
 * refusal before anything is asked.
 */
export class MockBus {
  readonly #waiting = new Map<number, Waiting>();
  readonly #stopping = new Map<number, () => void>();
  #next = 0;

  constructor(private readonly host: BusHost) {}

  plan(request: PlanRequest): Plan {
    const planned =
      request.action === "delete"
        ? this.#delete(request.space, request.target)
        : this.#reveal(request.object, request.key);
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
    let ended = false;
    this.#stopping.set(id, () => {
      if (ended) return;
      ended = true;
      onMessage({ state: "stopped", text: planned.stopped ?? "Stopped" });
    });
    const tell = (event: OperationEvent) => {
      if (ended) return;
      if (event.state !== "running") {
        ended = true;
        this.#stopping.delete(id);
      }
      onMessage(event);
    };
    setTimeout(() => {
      try {
        planned.run(tell);
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

  #delete(space: string, target: ResourceRef): Planned {
    const context = this.host.context(space);
    if (context === undefined)
      throw new IpcError("notFound", `no space ${space}`);
    const cluster = this.host.cluster(context);
    const { group, resource } = target.gvr;
    const { name } = target;
    const namespace = target.namespaced ? target.namespace : null;
    const place = namespace === null ? "" : ` in ${namespace}`;
    const kubectl = [
      "kubectl --context",
      context,
      "delete",
      group === "" ? resource : `${resource}.${group}`,
      name,
      ...(namespace === null ? [] : ["-n", namespace]),
    ].join(" ");
    const auditTarget = `${resource}/${name}${place}`;
    // As Rust: a read-only context says so before the object is looked up.
    this.#authorize(context, this.host.access(context), {
      write: { verb: "delete", target: auditTarget },
    });
    const described = (kind: string, risk: Risk, consequences: string[]) => ({
      stopped: `Stopped waiting for ${kind} ${name}, which is still being deleted`,
      plan: {
        context,
        question: `Delete ${kind} ${name}${place} from ${context}?`,
        confirm: `Delete ${kind}`,
        consequences,
        kubectl,
        doing: `Deleting ${kind} ${name}`,
      },
      risk,
      write: { verb: "delete", target: auditTarget },
    });
    const gone = (what: string) =>
      new IpcError("notFound", `${what} "${name}" not found`);
    if (group === "" && resource === "pods") {
      const pod = cluster.pods.find(
        (candidate) =>
          candidate.namespace === namespace && candidate.name === name,
      );
      if (!pod) throw gone("pods");
      const replicaSet = `${deploymentOf(pod)}-${pod.templateHash}`;
      return {
        ...described("pod", { kind: "replaced" }, [
          `Its replica set ${replicaSet} replaces it.`,
        ]),
        run: (tell) => {
          tell({ state: "running", text: `Waiting for pod ${name} to go` });
          setTimeout(() => {
            const still = cluster.pods.find((candidate) => candidate === pod);
            if (still) cluster.deletePod(still, Date.now());
            this.host.changed();
            tell({ state: "done", text: `Deleted pod ${name}` });
          }, GRACE_MS);
        },
      };
    }
    if (group === "" && resource === "nodes") {
      if (!cluster.nodes.some((node) => node.name === name)) {
        throw gone("nodes");
      }
      return {
        ...described("node", { kind: "wide", name }, []),
        run: (tell) => {
          cluster.deleteNode(name);
          this.host.changed();
          tell({ state: "done", text: `Deleted node ${name}` });
        },
      };
    }
    if (group === "apps" && resource === "deployments") {
      const owned = cluster.pods.some(
        (pod) => pod.namespace === namespace && deploymentOf(pod) === name,
      );
      if (!owned || namespace === null) throw gone("deployments.apps");
      return {
        ...described("deployment", { kind: "one" }, []),
        run: (tell) => {
          cluster.deleteDeployment(namespace, name);
          this.host.changed();
          tell({ state: "done", text: `Deleted deployment ${name}` });
        },
      };
    }
    throw new IpcError(
      "notFound",
      `the mock backend deletes only pods, nodes and deployments, not ${resource}`,
    );
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
