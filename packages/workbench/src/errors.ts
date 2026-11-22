import type { ErrorCode, ServerStatus } from "@twigo/protocol";

/** What an error shows of itself, which a wire error and an `IpcError` both have. */
export interface ErrorLike {
  readonly code: ErrorCode;
  readonly message: string;
  readonly server?: ServerStatus | undefined;
}

export function errorDetails({ code, message, server }: ErrorLike): string {
  const lines = [`Code: ${code}`, `Message: ${message}`];
  if (server) {
    if (server.reason !== "") lines.push(`Server reason: ${server.reason}`);
    if (server.causes.length > 0) {
      lines.push("Causes:");
      for (const { reason, field, message: said } of server.causes) {
        lines.push(`- ${field === "" ? "" : `${field}: `}${said} (${reason})`);
      }
    }
  }
  return lines.join("\n");
}

/** The error as plain lines, for a tooltip or a terminal: its message, then its code. */
export function errorLines(error: ErrorLike): string[] {
  return [error.message, error.code];
}

export function errorText(error: ErrorLike): string {
  return errorLines(error).join("\n");
}

/** The error on one line, for a label or a tooltip row that has no room for a second. */
export function errorOneLine(error: ErrorLike): string {
  return errorLines(error).join(" · ");
}
