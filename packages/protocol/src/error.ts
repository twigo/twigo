import type { ErrorKind } from "./generated";

export class IpcError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "IpcError";
    this.kind = kind;
  }
}

/** Rust rejects with `{ kind, message }`; anything else, such as Tauri's own errors, is internal. */
export function toIpcError(error: unknown): IpcError {
  if (error instanceof IpcError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error &&
    typeof error.kind === "string" &&
    typeof error.message === "string"
  ) {
    return new IpcError(error.kind as ErrorKind, error.message);
  }
  return new IpcError(
    "internal",
    error instanceof Error ? error.message : String(error),
  );
}
