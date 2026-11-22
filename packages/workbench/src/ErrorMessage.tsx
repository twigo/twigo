import type { ComponentProps } from "react";
import { ErrorDetails } from "@twigo/ui";
import { errorDetails, type ErrorLike } from "./errors";
import { isInternalError } from "./internalError";
import { useReport } from "./report/useReport";

interface CodeProps {
  error: ErrorLike;
  notice?: boolean;
  className?: string;
}

/**
 * What goes under an error's message: its code as a quiet line, and Copy
 * details. In a notice, Twigo's own error offers Report… beside them, since a
 * toast has no banner to carry it (ARCHITECTURE 4.10).
 */
export function ErrorCode({ error, notice = false, className }: CodeProps) {
  const details = {
    code: error.code,
    copy: errorDetails(error),
    notice,
    ...(className && { className }),
  };
  return notice && isInternalError(error) ? (
    <ReportableDetails {...details} />
  ) : (
    <ErrorDetails {...details} />
  );
}

function ReportableDetails(details: ComponentProps<typeof ErrorDetails>) {
  const report = useReport();
  return <ErrorDetails {...details} onReport={report} />;
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
