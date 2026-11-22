import type { ReactNode } from "react";
import { ErrorDetails } from "@twigo/ui";
import { errorDetails, type ErrorLike } from "./errors";

export interface ErrorMessageProps {
  error: ErrorLike;
  message?: string;
  lead?: string;
  notice?: boolean;
  className?: string;
}

/**
 * An error's message in two parts, for a bar that sets the details on a line
 * of its own: `words` are the message, and `details` the code's line and Copy
 * details.
 */
export function errorParts({
  error,
  message = error.message,
  lead = "",
  notice = false,
  className,
}: ErrorMessageProps): { words: string; details: ReactNode } {
  return {
    words: `${lead}${message}`,
    details: (
      <ErrorDetails
        code={error.code}
        copy={errorDetails(error)}
        notice={notice}
        {...(className && { className })}
      />
    ),
  };
}
