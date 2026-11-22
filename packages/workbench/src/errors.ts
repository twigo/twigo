import type { ErrorCode, ServerStatus } from "@twigo/protocol";
import { variant } from "./variants";

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

/** The error as plain lines, for a tooltip or a terminal, with its code where the variant puts it. */
export function errorLines(error: ErrorLike): string[] {
  // @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
  switch (variant("code")) {
    case "line":
      return [error.message, error.code];
    case "inline":
      return [`${error.code}: ${error.message}`];
    case "copy":
      return [error.message];
  }
}

export function errorText(error: ErrorLike): string {
  return errorLines(error).join("\n");
}
