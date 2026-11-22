import { CircleAlert, FileX, KeyRound, ShieldOff } from "lucide-react";
import { refusal, type ObjectSnapshot, type ViewState } from "@twigo/protocol";
import { INTERNAL_ERROR, isInternalError } from "@twigo/workbench";

/**
 * Why a view has no rows or object, in words, for the states that have one.
 * A list of every namespace that is refused says it is the whole cluster at
 * once that these credentials may not list.
 */
export function viewProblem(
  status: ViewState,
  what: string,
  everyNamespace = false,
) {
  switch (status.state) {
    case "forbidden": {
      const error = refusal(status);
      return {
        icon: ShieldOff,
        variant: "muted" as const,
        title: "Access denied",
        body: everyNamespace
          ? `You may not list ${status.resource} in every namespace at once.`
          : error.message,
        error,
      };
    }
    case "unauthorized": {
      const error = refusal(status);
      return {
        icon: KeyRound,
        variant: "muted" as const,
        title: "Sign-in needed",
        body: error.message,
        error,
      };
    }
    case "error": {
      const error = refusal(status);
      if (isInternalError(error)) {
        return {
          icon: CircleAlert,
          variant: "error" as const,
          title: INTERNAL_ERROR.title,
          body: INTERNAL_ERROR.stopped(),
          error,
        };
      }
      return {
        icon: CircleAlert,
        variant: "error" as const,
        title: `Could not load ${what}`,
        body: error.message,
        error,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Why an open object has nothing to show, in words: the view's problem, or
 * that the object does not exist; none while it is there or still coming.
 */
export function objectProblem({
  status,
  exists,
}: Pick<ObjectSnapshot, "status" | "exists">) {
  if (status.state === "ready" && !exists) {
    return {
      icon: FileX,
      variant: "muted" as const,
      title: "The object does not exist",
      body: "It is gone from the server.",
      error: undefined,
    };
  }
  return viewProblem(status, "the object");
}
