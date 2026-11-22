import { wire } from "../error";
import type {
  Catalog,
  CatalogFailure,
  Context,
  IpcError as Wire,
  LogBatch,
  ViewState,
} from "../generated";
import { CONTEXTS, UNMARKED } from "./fixtures";

/**
 * Lists whose cluster does not answer, pinned with the failure that keeps
 * them waiting, as Rust's upstream reports it: `connectRefused` and
 * `connectCertificate` connect again, `connectLost` shows its rows with no
 * updates. `serverRefuses` is a list the API server answers with a refusal
 * that has causes, which the status carries as data, and `listPanicked` one
 * that ended on an internal error of Twigo's.
 */
export const CAUSE_SCENARIOS = [
  "connectRefused",
  "connectCertificate",
  "connectLost",
  "serverRefuses",
  "listPanicked",
] as const;

export type CauseScenario = (typeof CAUSE_SCENARIOS)[number];

/** `logsPanicked`: live lists while every log stream of a session ends on an internal error of Twigo's. */
export const LOGS_PANICKED = "logsPanicked";

export function panickedLogs(batch: LogBatch): LogBatch {
  return {
    ...batch,
    pods:
      batch.pods?.map((pod) => ({
        ...pod,
        containers: pod.containers.map((container) => ({
          ...container,
          stream: {
            state: "error" as const,
            error: wire(
              "internal.panic",
              "Twigo stopped this log stream on an internal error",
            ),
          },
        })),
      })) ?? null,
  };
}

/**
 * `discoveryFails`: no space's discovery answers, each for a reason of its
 * own, as it does when a cluster cannot be reached, a context names no user
 * or a credential plugin fails; `listFails`: the lists of each space end in
 * the same errors, which is how the status bar words each family of codes.
 */
export const DISCOVERY_FAILS = "discoveryFails";
export const LIST_FAILS = "listFails";

const FAILURES: Readonly<Record<string, Wire>> = {
  "prod-eu": wire(
    "connect.refused",
    "The cluster refused the connection: Connection refused (os error 61)",
  ),
  staging: wire(
    "context.missing-user",
    'no kubeconfig defines the user "staging-admin"',
  ),
  dev: wire(
    "credentials.plugin-failed",
    "exec: executable aws failed with exit code 255",
  ),
};

/** Why a space's discovery fails under `discoveryFails`, none for a space that has no reason. */
export function discoveryFailure(
  scenario: string,
  space: string,
): Wire | undefined {
  return scenario === DISCOVERY_FAILS ? FAILURES[space] : undefined;
}

/** The error a space's lists end in under `listFails`. */
export function listFailure(scenario: string, space: string): Wire | undefined {
  return scenario === LIST_FAILS ? FAILURES[space] : undefined;
}

export function isCauseScenario(scenario: string): scenario is CauseScenario {
  return (CAUSE_SCENARIOS as readonly string[]).includes(scenario);
}

/** The pinned state of each cause scenario's lists, with the cause in Twigo's sentence and the failure's own words, as the core words it. */
export const CAUSED: Readonly<Record<CauseScenario, ViewState>> = {
  connectRefused: {
    state: "connecting",
    cause: wire(
      "connect.refused",
      "The cluster refused the connection: Connection refused (os error 61)",
    ),
  },
  connectCertificate: {
    state: "connecting",
    cause: wire(
      "connect.certificate",
      "The cluster's certificate cannot be verified: “34.141.62.18” certificate is not trusted: -67843",
    ),
  },
  connectLost: {
    state: "stale",
    cause: wire(
      "connect.lost",
      "Error reading events stream: connection closed before message completed",
    ),
  },
  listPanicked: {
    state: "error",
    error: wire(
      "internal.panic",
      "Twigo stopped this list on an internal error",
    ),
  },
  serverRefuses: {
    state: "error",
    error: wire(
      "server.invalid",
      'Pod "web-7d9f" is invalid: spec.containers[0].image: Required value',
      {
        reason: "Invalid",
        causes: [
          {
            reason: "FieldValueRequired",
            field: "spec.containers[0].image",
            message: "Required value",
          },
          {
            reason: "FieldValueInvalid",
            field: "spec.containers[0].resources.limits.memory",
            message:
              "Invalid value: must be less than or equal to memory limit",
          },
        ],
      },
    ),
  },
};

/**
 * `kubeconfigFailures`: two of the files the catalog reads fail, one that
 * cannot be parsed and one that cannot be read, beside the good ones, and a
 * context of a good file names a user that no file defines.
 * `kubeconfigAllFailed`: every file fails, so no context is listed.
 */
export const KUBECONFIG_SCENARIOS = [
  "kubeconfigFailures",
  "kubeconfigAllFailed",
] as const;

export type KubeconfigScenario = (typeof KUBECONFIG_SCENARIOS)[number];

export function isKubeconfigScenario(
  scenario: string,
): scenario is KubeconfigScenario {
  return (KUBECONFIG_SCENARIOS as readonly string[]).includes(scenario);
}

const FAILED_FILES: readonly CatalogFailure[] = [
  {
    source: "~/.kube/broken.yaml",
    error: wire(
      "kubeconfig.unparsable",
      "The file cannot be parsed: expected sequence start at line 7, column 10",
    ),
  },
  {
    source: "~/.kube/work/locked.yaml",
    error: wire(
      "kubeconfig.unreadable",
      "The file cannot be read: permission denied",
    ),
  },
];

/** A context whose entry names a user no kubeconfig defines. */
const WITHOUT_USER: Context = {
  name: "orphan",
  color: null,
  source: "~/.kube/config",
  server: "https://orphan.internal:6443",
  namespace: null,
  access: UNMARKED,
  problem: wire(
    "context.missing-user",
    'no kubeconfig defines the user "orphan-admin"',
  ),
};

/** The contexts whose user no file defines: Twigo connects with no credentials, and the server refuses what they ask. */
export const ANONYMOUS: readonly string[] = [WITHOUT_USER.name];

export function catalogOf(scenario: string): Catalog {
  if (scenario === "kubeconfigAllFailed") {
    return { contexts: [], failures: [...FAILED_FILES] };
  }
  return scenario === "kubeconfigFailures"
    ? {
        contexts: [...CONTEXTS, WITHOUT_USER],
        failures: [...FAILED_FILES],
      }
    : { contexts: CONTEXTS, failures: [] };
}
