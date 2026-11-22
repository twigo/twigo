import type { ReactNode } from "react";
import type { ViewState } from "@twigo/protocol";
import { EmptyState, LinkButton } from "@twigo/ui";
import {
  ErrorMessage,
  isInternalError,
  ReportButton,
  ReportLink,
} from "@twigo/workbench";
import { viewProblem } from "./viewProblem";

/**
 * What a view shows when Rust cannot give it rows, an object or the
 * cluster's kinds (ARCHITECTURE 3.7): one rendering for lists, the
 * explorer, details and object editors; the home words the same problems
 * in its tiles through `viewProblem`. Other states draw nothing here;
 * their view shows a skeleton or its content.
 */
export function ViewStatus({
  status,
  what,
  onRetry,
  onChoose,
  inline = false,
}: {
  status: ViewState;
  /** What failed to load, lower case: `pods`. */
  what: string;
  /** Retry, or Reopen for a view that Twigo stopped; `inline` draws only Reopen. */
  onRetry?: () => void;
  /** Given by a list of every namespace: where it is refused, it says so and offers to choose namespaces in place of a retry. */
  onChoose?: () => void;
  /** A one-line message for a panel too small for the full one. */
  inline?: boolean;
}): ReactNode {
  const everyNamespace = onChoose !== undefined && status.state === "forbidden";
  const shown = viewProblem(status, what, everyNamespace);
  if (!shown) return null;
  const internal = isInternalError(shown.error);
  const retry = everyNamespace
    ? { label: "Choose namespaces", onClick: onChoose }
    : onRetry && { label: internal ? "Reopen" : "Retry", onClick: onRetry };
  if (inline) {
    return (
      <EmptyState
        variant={shown.variant}
        density="inline"
        icon={shown.icon}
        className="px-3"
      >
        <ErrorMessage error={shown.error} message={shown.body} />
        {internal && onRetry && (
          <LinkButton className="ml-2" onClick={onRetry}>
            Reopen
          </LinkButton>
        )}
        {internal && <ReportLink className="ml-2" />}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon={shown.icon}
      variant={shown.variant}
      title={shown.title}
      {...(retry && { action: retry })}
      {...(internal && { secondary: <ReportButton /> })}
      className="flex-1 py-16"
    >
      <p className="max-w-md">
        <ErrorMessage
          error={shown.error}
          message={shown.body}
          className="justify-center"
        />
      </p>
    </EmptyState>
  );
}
