import type { ApplyPreviewed } from "@twigo/protocol";
import type { Variants } from "./variants";

/**
 * Where an answer shows: a bar above the editor, which keeps the YAML in
 * view, or a page of its own for what needs room, the diff of an apply.
 */
export function placementOf(
  answer: ApplyPreviewed,
  variants: Pick<Variants, "conflicts">,
): "bar" | "page" {
  switch (answer.state) {
    case "ready":
      return "page";
    case "conflicts":
      return variants.conflicts === "diff" ? "page" : "bar";
    case "unchanged":
    case "stale":
    case "immutable":
      return "bar";
  }
}
