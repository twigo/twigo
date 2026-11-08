import { CircleAlert, FileX, KeyRound, ShieldOff } from "lucide-react";
import type { ObjectSnapshot, ViewState } from "@twigo/protocol";

/** Why a view has no rows or object, in words, for the states that have one. */
export function viewProblem(status: ViewState, what: string) {
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
    };
  }
  return viewProblem(status, "the object");
}
