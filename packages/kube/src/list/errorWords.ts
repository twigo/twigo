import type { ErrorCode, ServerStatus } from "@twigo/protocol";
import { variant } from "@twigo/workbench";

export interface Failure {
  readonly code: ErrorCode;
  readonly server?: ServerStatus | undefined;
}

/** What a cluster that does not answer says in a few words, by what kept it from answering. */
const CAUSES: Partial<Record<ErrorCode, string>> = {
  "connect.refused": "connection refused",
  "connect.unresolved": "name does not resolve",
  "connect.timeout": "timed out",
  "connect.certificate": "certificate not trusted",
  "connect.tls": "TLS handshake failed",
  "connect.proxy": "proxy failed",
  "connect.lost": "connection lost",
  "connect.other": "unreachable",
};

/** The reason the API server gave, none where it gave none. */
function reasonOf(server: ServerStatus | undefined): string | undefined {
  return server?.reason === "" ? undefined : server?.reason;
}

/** Why a list waits, in a few words; the server's own reason where it answered. */
export function causeWords({ code, server }: Failure): string {
  return CAUSES[code] ?? reasonOf(server) ?? code;
}

/** The status bar's word for a list that failed: by the code's family, as kubectl names what refused, or the code itself. */
export function statusWord(error: Failure): string {
  // @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
  if (variant("status") === "code") return error.code;
  switch (error.code.slice(0, error.code.indexOf("."))) {
    case "connect":
      return "Unreachable";
    case "server":
      return reasonOf(error.server) ?? "Server error";
    case "kubeconfig":
    case "context":
      return "Kubeconfig error";
    case "credentials":
      return "Sign-in failed";
    default:
      return "Error";
  }
}
