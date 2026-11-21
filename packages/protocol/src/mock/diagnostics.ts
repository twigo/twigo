import { IpcError, wireError } from "../error";
import type {
  Catalog,
  CatalogFailure,
  Context,
  IpcError as Wire,
  ViewState,
} from "../generated";
import { CONTEXTS, UNMARKED } from "./fixtures";

/**
 * Lists whose cluster does not answer, pinned with the failure that keeps
 * them waiting, as Rust's upstream reports it: `connectRefused` and
 * `connectCertificate` connect again, `connectLost` shows its rows with no
 * updates. `serverRefuses` is a list the API server answers with a refusal
 * that has causes, which the status carries as data.
 */
export const CAUSE_SCENARIOS = [
  "connectRefused",
  "connectCertificate",
  "connectLost",
  "serverRefuses",
] as const;

export type CauseScenario = (typeof CAUSE_SCENARIOS)[number];

export function isCauseScenario(scenario: string): scenario is CauseScenario {
  return (CAUSE_SCENARIOS as readonly string[]).includes(scenario);
}

function error(
  code: ConstructorParameters<typeof IpcError>[0],
  message: string,
  server?: ConstructorParameters<typeof IpcError>[3],
): Wire {
  return wireError(new IpcError(code, message, undefined, server));
}

/** The pinned state of each cause scenario's lists, in the words Rust gives each cause (`research/errors.md`). */
export const CAUSED: Readonly<Record<CauseScenario, ViewState>> = {
  connectRefused: {
    state: "connecting",
    cause: error(
      "connect.refused",
      "The server refused the connection: Connection refused (os error 61)",
    ),
  },
  connectCertificate: {
    state: "connecting",
    cause: error(
      "connect.certificate",
      "The server's certificate is not trusted: “34.141.62.18” certificate is not trusted: -67843",
    ),
  },
  connectLost: {
    state: "stale",
    cause: error(
      "connect.lost",
      "The connection to the server was lost: connection closed before message completed",
    ),
  },
  serverRefuses: {
    state: "error",
    error: error(
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
    error: error(
      "kubeconfig.unparsable",
      "Cannot be parsed: unclosed bracket '[' at line 7, column 10",
    ),
  },
  {
    source: "~/.kube/work/locked.yaml",
    error: error("kubeconfig.unreadable", "Cannot be read: permission denied"),
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
  problem: error(
    "context.missing-user",
    'no kubeconfig defines the user "orphan-admin"',
  ),
};

/** What the catalog lists in a scenario: the fixtures' contexts, and what it could not read. */
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
