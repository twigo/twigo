import type { ErrorLike } from "./errors";

/**
 * What a view says when Twigo's own code failed in it, one wording for every
 * item that ends with `internal.panic` (ARCHITECTURE 4.10): the error's own
 * message is Rust's, and stays in Copy details.
 */
export const INTERNAL_ERROR = {
  title: "Twigo hit an internal error",
  stopped: (what = "This view") => `${what} stopped.`,
  shell: "Twigo hit an internal error and this shell stopped.",
} as const;

export function isInternalError({ code }: Pick<ErrorLike, "code">): boolean {
  return code === "internal.panic";
}
