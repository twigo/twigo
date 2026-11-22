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

/** The error as plain text, for a tooltip or a terminal: its message, then its code on a line of its own. */
export function errorText({ message, code }: ErrorLike): string {
  return `${message}\n${code}`;
}

/** The error on one line, for a label or a tooltip row that has no room for a second. */
export function errorOneLine({ message, code }: ErrorLike): string {
  return `${message} · ${code}`;
}
