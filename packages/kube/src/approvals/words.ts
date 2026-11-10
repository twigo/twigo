import type { NoDiff } from "@twigo/protocol";

/** From apimachinery's `DeletionPropagation` and `DeleteOptions.PropagationPolicy` (v0.37.1). */
export function propagationWords(propagation: string | null): string {
  switch (propagation) {
    case null:
      return "The request sets no propagation, so the object's finalizers and the resource's default decide what happens to its dependents.";
    case "Foreground":
      return "The object stays until the garbage collector has deleted the dependents that block its deletion.";
    case "Background":
      return "The object goes at once, and the garbage collector deletes its dependents after.";
    case "Orphan":
      return "The object goes and its dependents are left behind.";
    default:
      return `The request asks for the propagation ${propagation}.`;
  }
}

export function noDiffWords(reason: NoDiff): readonly string[] {
  switch (reason.reason) {
    case "subresource":
      return [
        "It goes to a subresource, such as scale, which no dry run covers.",
      ];
    case "aggregated":
      return [
        "An aggregated API server serves it, and such a server may not honour a dry run.",
      ];
    case "unverified":
      return [
        "Twigo could not read whether an aggregated API server serves it, and such a server may not honour a dry run.",
      ];
    case "refused":
      return [
        `The server refused the dry run: ${reason.message}`,
        "The write itself may still pass, as a webhook that does not support dry runs refuses only the dry run.",
      ];
    case "notAResource":
      return [
        "No dry run can say what it does: its path names no resource Twigo can read, or it is a review, which answers whatever it is asked.",
      ];
  }
}

export function inputWords(tty: boolean, stdin: boolean): string {
  if (!stdin) return "None: it only shows output.";
  return tty
    ? "What is typed, in a terminal."
    : "What the client sends, with no terminal.";
}

const PLAIN = /^[\w@%+=:,./-]+$/;

export function commandLine(words: readonly string[]): string {
  return words
    .map((word) =>
      PLAIN.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}
