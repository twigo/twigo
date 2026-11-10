import { IpcError } from "../error";
import type {
  AnswerApproval,
  ApprovalAsk,
  ApprovalDetail,
  ApprovalEvent,
  ApprovalId,
} from "../generated";
import { side } from "./edits";
import { recordedManifest } from "./objects";

/**
 * Pins the asks a process makes of the window (ARCHITECTURE 6.4), which
 * nothing in the app raises before step 7: `approval` raises a sequence, the
 * next one after each answer, `approvalQueue` raises three at once and
 * `approvalWithdrawn` one that is withdrawn a while after it shows. Any
 * other scenario raises none.
 */
export type ApprovalScenario =
  "approval" | "approvalQueue" | "approvalWithdrawn";

export const APPROVAL_SCENARIOS: readonly ApprovalScenario[] = [
  "approval",
  "approvalQueue",
  "approvalWithdrawn",
];

export function isApprovalScenario(
  scenario: string,
): scenario is ApprovalScenario {
  return (APPROVAL_SCENARIOS as readonly string[]).includes(scenario);
}

/** How long after the window follows the asks the first one comes, and how long after an answer the next of `approval`. */
export const FIRST_ASK_MS = 3000;
export const NEXT_ASK_MS = 1000;

/** How long after `approvalWithdrawn`'s ask shows it is withdrawn. */
export const WITHDRAWN_AFTER_MS = 6000;

type Fields = Record<string, unknown>;
type Draft = Omit<ApprovalAsk, "id">;

const STAGING = "staging";
const PRODUCTION = "prod-eu";
const POD = "web-54454cf656-dvb7s";
const NEW_UID = "0b8f6a3e-52c1-4d7e-9a14-6f3d2c9e7a58";

function named(manifest: Fields, name: string, namespace: string): Fields {
  return {
    ...manifest,
    metadata: { ...(manifest.metadata as Fields), name, namespace },
  };
}

function withImage(deployment: Fields, image: string): Fields {
  const spec = deployment.spec as Fields;
  const template = spec.template as Fields;
  const pod = template.spec as Fields;
  const [first, ...more] = pod.containers as Fields[];
  return {
    ...deployment,
    spec: {
      ...spec,
      template: {
        ...template,
        spec: { ...pod, containers: [{ ...first, image }, ...more] },
      },
    },
  };
}

function annotated(object: Fields, key: string, value: string): Fields {
  const metadata = object.metadata as Fields;
  return {
    ...object,
    metadata: {
      ...metadata,
      annotations: {
        ...(metadata.annotations as Fields | undefined),
        [key]: value,
      },
    },
  };
}

function withData(object: Fields, data: Record<string, string>): Fields {
  return { ...object, data: { ...(object.data as Fields), ...data } };
}

function diff(
  live: Fields | null,
  result: Fields,
  warnings: string[],
): ApprovalDetail {
  return { kind: "diff", live: side(live), result: side(result), warnings };
}

function created(name: string, data: Record<string, string>): Fields {
  const settings = recordedManifest("configmap");
  return {
    apiVersion: settings.apiVersion,
    kind: settings.kind,
    metadata: {
      ...(settings.metadata as Fields),
      name,
      namespace: "default",
      uid: NEW_UID,
    },
    data,
  };
}

function drafts(): Record<string, Draft> {
  const web = named(recordedManifest("deployment"), "web", "default");
  const settings = named(recordedManifest("configmap"), "settings", "default");
  const credentials = named(
    recordedManifest("secret"),
    "credentials",
    "default",
  );
  const common = {
    class: "write",
    impersonate: null,
    typed: false,
    lastingMinutes: 15,
  } as const;
  return {
    patch: {
      ...common,
      context: STAGING,
      process: "Terminal 2",
      command: "kubectl set image",
      verb: "patch",
      target: "deployments/web in default",
      detail: diff(web, withImage(web, "registry.k8s.io/pause:3.11"), [
        'would violate PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "app" must set securityContext.allowPrivilegeEscalation=false)',
      ]),
    },
    create: {
      ...common,
      context: STAGING,
      process: "Terminal 1",
      command: "kubectl create",
      verb: "create",
      target: "configmaps/feature-flags in default",
      detail: diff(null, created("feature-flags", { checkout: "on" }), []),
    },
    delete: {
      ...common,
      context: PRODUCTION,
      process: "Terminal 3",
      command: "kubectl delete",
      verb: "delete",
      target: `pods/${POD} in default`,
      detail: { kind: "delete", propagation: "Background" },
      typed: true,
      lastingMinutes: null,
    },
    exec: {
      ...common,
      class: "exec",
      context: STAGING,
      process: "Terminal 2",
      command: "kubectl exec",
      verb: "exec",
      target: `pods/${POD} in default`,
      detail: {
        kind: "session",
        container: "app",
        command: ["sh", "-c", "tail -n 100 /var/log/app.log | grep ERROR"],
        tty: true,
        stdin: true,
      },
    },
    scale: {
      ...common,
      context: STAGING,
      process: "Terminal 1",
      command: "kubectl scale",
      verb: "patch",
      target: "deployments/web/scale in default",
      detail: {
        kind: "unknown",
        reason: { reason: "subresource" },
        body: JSON.stringify({ spec: { replicas: 5 } }),
      },
    },
    aggregated: {
      ...common,
      context: STAGING,
      process: "Terminal 3",
      command: "kubectl apply",
      verb: "create",
      target: "flunders/blue in default",
      detail: {
        kind: "unknown",
        reason: { reason: "aggregated" },
        body: null,
      },
    },
    refused: {
      ...common,
      context: STAGING,
      process: "Terminal 2",
      command: "kubectl apply",
      verb: "patch",
      target: "ingresses/shop in default",
      detail: {
        kind: "unknown",
        reason: {
          reason: "refused",
          message:
            'admission webhook "policy.example.com" does not support dry run',
        },
        body: null,
      },
    },
    impersonated: {
      ...common,
      context: STAGING,
      process: "Terminal 1",
      command: "kubectl annotate",
      verb: "patch",
      target: "configmaps/settings in default",
      impersonate:
        "system:serviceaccount:default:deployer, groups system:serviceaccounts",
      detail: diff(settings, annotated(settings, "team", "payments"), []),
    },
    secret: {
      ...common,
      context: STAGING,
      process: "Terminal 3",
      command: "kubectl edit",
      verb: "patch",
      target: "secrets/credentials in default",
      detail: diff(
        credentials,
        withData(credentials, { password: "<17 bytes>" }),
        [],
      ),
    },
    deleteFlags: {
      ...common,
      context: STAGING,
      process: "Terminal 1",
      command: "kubectl delete",
      verb: "delete",
      target: "configmaps/feature-flags in default",
      detail: { kind: "delete", propagation: "Background" },
      typed: true,
      lastingMinutes: null,
    },
  };
}

function sequence(scenario: ApprovalScenario): Draft[] {
  const all = drafts();
  const pick = (...names: string[]) =>
    names.map((name) => {
      const draft = all[name];
      if (draft === undefined) throw new Error(`no ask named ${name}`);
      return draft;
    });
  switch (scenario) {
    case "approval":
      return pick(
        "patch",
        "create",
        "delete",
        "exec",
        "scale",
        "aggregated",
        "refused",
        "impersonated",
        "secret",
        "deleteFlags",
      );
    case "approvalQueue":
      return pick("patch", "create", "exec");
    case "approvalWithdrawn":
      return pick("patch");
  }
}

const grantOf = ({ process, context }: Draft) => `${process}\0${context}`;

/**
 * The approval broker as a window sees it: it sends the asks waiting and
 * every new one to the window that follows, takes the answers and refuses
 * one for an ask that is gone, a name typed wrong or a lasting answer that
 * was not offered. A lasting answer allows what its process asks on its
 * context for the minutes the ask offered, deletes excepted: an ask that
 * waits then is withdrawn, and one that comes is not raised.
 */
export class MockApprovals {
  readonly #waiting = new Map<ApprovalId, ApprovalAsk>();
  #follower: ((event: ApprovalEvent) => void) | undefined;
  #coming: Draft[] = [];
  #started = false;
  #next = 1;
  /** When each process's lasting answer on a context ends, in milliseconds. */
  readonly #lasting = new Map<string, number>();

  constructor(private readonly scenario: ApprovalScenario | undefined) {}

  watch(onMessage: (event: ApprovalEvent) => void): null {
    this.#follower = onMessage;
    for (const ask of this.#waiting.values()) {
      onMessage({ event: "asked", ask });
    }
    if (!this.#started && this.scenario !== undefined) {
      this.#started = true;
      this.#coming = sequence(this.scenario);
      this.#later(FIRST_ASK_MS);
    }
    return null;
  }

  answer({ id, answer, typed }: AnswerApproval): null {
    const ask = this.#waiting.get(id);
    if (ask === undefined) {
      throw new IpcError("notFound", `the ask ${String(id)} is gone`);
    }
    if (answer !== "deny" && ask.typed && typed !== ask.context) {
      throw new IpcError("invalidInput", `type ${ask.context} to confirm`);
    }
    if (answer === "lasting") {
      if (ask.lastingMinutes === null) {
        throw new IpcError("invalidInput", "this ask offers no lasting answer");
      }
      this.#lasting.set(grantOf(ask), Date.now() + ask.lastingMinutes * 60_000);
    }
    this.#waiting.delete(id);
    for (const other of [...this.#waiting.values()]) {
      if (this.#allowed(other)) {
        this.#waiting.delete(other.id);
        this.#follower?.({ event: "withdrawn", id: other.id });
      }
    }
    if (this.scenario === "approval") this.#later(NEXT_ASK_MS);
    return null;
  }

  #allowed(draft: Draft): boolean {
    const until = this.#lasting.get(grantOf(draft));
    return until !== undefined && Date.now() < until && draft.verb !== "delete";
  }

  #later(ms: number): void {
    setTimeout(() => {
      const several = this.scenario === "approvalQueue";
      for (
        let draft = this.#coming.shift();
        draft !== undefined;
        draft = this.#coming.shift()
      ) {
        if (this.#allowed(draft)) continue;
        this.#raise(draft);
        if (!several) return;
      }
    }, ms);
  }

  #raise(draft: Draft): void {
    const ask: ApprovalAsk = { ...draft, id: this.#next++ };
    this.#waiting.set(ask.id, ask);
    this.#follower?.({ event: "asked", ask });
    if (this.scenario === "approvalWithdrawn") {
      setTimeout(() => {
        if (this.#waiting.delete(ask.id)) {
          this.#follower?.({ event: "withdrawn", id: ask.id });
        }
      }, WITHDRAWN_AFTER_MS);
    }
  }
}
