import type { ReactNode } from "react";
import { CircleAlert, KeyRound, ShieldOff } from "lucide-react";
import type { ViewState } from "@twigo/protocol";
import { EmptyState } from "@twigo/ui";

/**
 * What a view shows when Rust cannot give it rows or an object
 * (ARCHITECTURE 3.7): one rendering for lists, the explorer, details and
 * object editors. Other states draw nothing here; their view shows a
 * skeleton or its content.
 */
export function ViewStatus({
  status,
  what,
  onRetry,
  inline = false,
}: {
  status: ViewState;
  /** What failed to load, lower case: `pods`. */
  what: string;
  onRetry?: () => void;
  /** A one-line message for a panel too small for the full one. */
  inline?: boolean;
}): ReactNode {
  const retry = onRetry && { label: "Retry", onClick: onRetry };
  const shown = describe(status, what);
  if (!shown) return null;
  if (inline) {
    return (
      <EmptyState
        variant={shown.variant}
        density="inline"
        icon={shown.icon}
        className="px-3"
      >
        {shown.body}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon={shown.icon}
      variant={shown.variant}
      title={shown.title}
      {...(retry && { action: retry })}
      className="flex-1 py-16"
    >
      <p className="max-w-md">{shown.body}</p>
    </EmptyState>
  );
}

function describe(status: ViewState, what: string) {
  switch (status.state) {
    case "forbidden":
      return {
        icon: ShieldOff,
        variant: "muted" as const,
        title: "Access denied",
        body: `These credentials may not ${status.verb} ${status.resource}.`,
      };
    case "unauthorized":
      return {
        icon: KeyRound,
        variant: "muted" as const,
        title: "Sign-in needed",
        body: "The cluster rejected the credentials.",
      };
    case "error":
      return {
        icon: CircleAlert,
        variant: "error" as const,
        title: `Could not load ${what}`,
        body: status.error.message,
      };
    default:
      return undefined;
  }
}
