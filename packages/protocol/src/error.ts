import { ERROR_KINDS } from "./errorKinds";
import type {
  Blocked,
  ErrorCode,
  ErrorKind,
  IpcError as Wire,
  ServerStatus,
} from "./generated";

export class IpcError extends Error {
  /** The condition, `family.condition`: what a person reads, searches and copies, and what a test holds. */
  readonly code: ErrorCode;
  /** The class of the condition, the same table Rust derives it from. */
  readonly kind: ErrorKind;
  /** With `permissions`: the mode and its source, when the gate stopped a request. */
  readonly blocked: Blocked | undefined;
  /** What the API server said of a request it refused, beside the code. */
  readonly server: ServerStatus | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    blocked?: Blocked,
    server?: ServerStatus,
  ) {
    super(message);
    this.name = "IpcError";
    this.code = code;
    this.kind = ERROR_KINDS[code];
    this.blocked = blocked;
    this.server = server;
  }
}

const CODES: ReadonlySet<unknown> = new Set(Object.keys(ERROR_KINDS));

function isCode(code: unknown): code is ErrorCode {
  return CODES.has(code);
}

/** Rust rejects with `{ code, kind, message }`; anything else, such as Tauri's own errors, is `internal.ipc`. */
export function toIpcError(error: unknown): IpcError {
  if (error instanceof IpcError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    isCode(error.code) &&
    typeof error.message === "string"
  ) {
    return new IpcError(
      error.code,
      error.message,
      "blocked" in error ? (error.blocked as Blocked) : undefined,
      "server" in error ? (error.server as ServerStatus) : undefined,
    );
  }
  return new IpcError(
    "internal.ipc",
    error instanceof Error ? error.message : String(error),
  );
}

/** An error as Rust sends it inside a state or an event, made from its code. */
export function wire(
  code: ErrorCode,
  message: string,
  server?: ServerStatus,
): Wire {
  return { code, kind: ERROR_KINDS[code], message, ...(server && { server }) };
}

/** The error as Rust sends it inside a state or an event. */
export function wireError(error: IpcError): Wire {
  return {
    code: error.code,
    kind: error.kind,
    message: error.message,
    ...(error.blocked && { blocked: error.blocked }),
    ...(error.server && { server: error.server }),
  };
}
