import type { ApplyPreviewed } from "@twigo/protocol";

/**
 * Where an answer shows: a bar above the editor, which keeps the YAML in
 * view, or a `diff://` tab of its own for what needs room, the diff of an
 * apply.
 */
export function placementOf(answer: ApplyPreviewed): "bar" | "page" {
  switch (answer.state) {
    case "ready":
      return "page";
    case "unchanged":
    case "conflicts":
    case "stale":
    case "immutable":
      return "bar";
  }
}
