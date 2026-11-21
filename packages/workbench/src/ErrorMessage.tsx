import { ErrorDetails } from "@twigo/ui";
import { errorDetails, type ErrorLike } from "./errors";
import { variant } from "./variants";

/**
 * An error's message with its code: under it as a quiet line with Copy
 * details, before it, or only in Copy details, as the variant says. `message`
 * says it in other words than the error's own, `lead` what the message
 * belongs to: `Cannot open the pod in dev: `.
 */
export function ErrorMessage({
  error,
  message = error.message,
  lead = "",
  className,
}: {
  error: ErrorLike;
  message?: string;
  lead?: string;
  className?: string;
}) {
  // @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
  const placement = variant("code");
  if (placement === "inline") {
    return (
      <>
        {lead}
        <code className="font-mono text-quiet">{error.code}</code>: {message}
      </>
    );
  }
  return (
    <>
      {lead}
      {message}
      <ErrorDetails
        code={placement === "line" ? error.code : undefined}
        copy={errorDetails(error)}
        {...(className && { className })}
      />
    </>
  );
}
