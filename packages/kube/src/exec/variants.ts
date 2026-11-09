/**
 * The two choices the owner makes at the checkpoint of the shell tab, as
 * live variants: `?variant=end=bar,again=focus`. The first value of each is
 * the recommendation.
 *
 * - `end`: `inline` words the ending as a line in the scrollback and shows
 *   the state in the group's actions with Restart there; `bar` adds a bar
 *   across the top of the terminal with the words and a Restart button.
 * - `again`: `new` opens another shell (`?n=2`) when `s` meets a container
 *   that has one; `focus` focuses the existing one, and a new one comes from
 *   the tab's actions.
 *
 * @todo: delete the variant that loses, and this file, once the owner chooses
 */
export interface ExecVariants {
  readonly end: "inline" | "bar";
  readonly again: "new" | "focus";
}

export function readVariants(search: string): ExecVariants {
  const chosen = new Map(
    (new URLSearchParams(search).get("variant") ?? "")
      .split(",")
      .map((part) => part.split("=") as [string, string | undefined]),
  );
  const end = chosen.get("end");
  const again = chosen.get("again");
  return {
    end: end === "bar" ? "bar" : "inline",
    again: again === "focus" ? "focus" : "new",
  };
}
