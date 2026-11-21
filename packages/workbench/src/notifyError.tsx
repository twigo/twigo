import { notify, type NotifyOptions } from "@twigo/ui";
import { ErrorMessage } from "./ErrorMessage";
import type { ErrorLike } from "./errors";

/**
 * A toast for an error, with its code as the variant says. A repeat of the
 * same words replaces the toast, so the key is the lead and the message, never
 * the code.
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
    <ErrorMessage error={error} lead={lead} />,
    { key: `${lead}${error.message}`, ...options },
  );
}
