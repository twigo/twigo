import { notify, type NotifyOptions } from "@twigo/ui";
import { ErrorMessage } from "./ErrorMessage";
import type { ErrorLike } from "./errors";
import { INTERNAL_ERROR, isInternalError } from "./internalError";

/**
 * A toast for an error, with its code under the message. A repeat of the same
 * words replaces the toast, so the key is the lead and the message, never the
 * code. Twigo's own error says it in Twigo's words, keeps Rust's in Copy
 * details and offers Report… (ARCHITECTURE 4.10).
 */
export function notifyError(
  error: ErrorLike,
  {
    lead = "",
    warning = false,
    ...options
  }: NotifyOptions & { lead?: string; warning?: boolean } = {},
): void {
  (warning ? notify.warning : notify.error)(
    <ErrorMessage
      error={error}
      lead={lead}
      notice
      {...(isInternalError(error) && { message: INTERNAL_ERROR.title })}
    />,
    { key: `${lead}${error.message}`, ...options },
  );
}
