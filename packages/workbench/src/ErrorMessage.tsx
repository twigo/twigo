import { ErrorDetails } from "@twigo/ui";
import { errorDetails, type ErrorLike } from "./errors";

interface CodeProps {
  error: ErrorLike;
  notice?: boolean;
  className?: string;
}

/** What goes under an error's message: its code as a quiet line, and Copy details. */
export function ErrorCode({ error, notice = false, className }: CodeProps) {
  return (
    <ErrorDetails
      code={error.code}
      copy={errorDetails(error)}
      notice={notice}
      {...(className && { className })}
    />
  );
}

/**
 * An error's message with its code under it as a quiet line, and Copy
 * details. `message` says it in other words than the error's own, `lead` what
 * the message belongs to: `Cannot open the pod in dev: `.
 */
export function ErrorMessage({
  error,
  message = error.message,
  lead = "",
  ...code
}: CodeProps & { message?: string; lead?: string }) {
  return (
    <>
      {`${lead}${message}`}
      <ErrorCode error={error} {...code} />
    </>
  );
}
