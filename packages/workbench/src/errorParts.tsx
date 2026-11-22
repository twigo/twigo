import type { ReactNode } from "react";
import { ErrorDetails } from "@twigo/ui";
import { errorDetails, type ErrorLike } from "./errors";
import { variant } from "./variants";

export interface ErrorMessageProps {
  error: ErrorLike;
  message?: string;
  lead?: string;
  notice?: boolean;
  className?: string;
}

/**
 * An error's message in two parts, for a bar that sets the details on a line
 * of its own: `words` are the message, led by the code where the variant
 * puts it, and `details` the code's line and Copy details.
 */
export function errorParts({
  error,
  message = error.message,
  lead = "",
  notice = false,
  className,
}: ErrorMessageProps): { words: ReactNode; details: ReactNode } {
  // @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
  const placement = variant("code");
  if (placement === "inline") {
    return {
      words: (
        <>
          {lead}
          <code className="font-mono font-normal text-quiet">{error.code}</code>
          : {message}
        </>
      ),
      details: undefined,
    };
  }
  return {
    words: (
      <>
        {lead}
        {message}
      </>
    ),
    details: (
      <ErrorDetails
        code={placement === "line" ? error.code : undefined}
        copy={errorDetails(error)}
        notice={notice}
        {...(className && { className })}
      />
    ),
  };
}
