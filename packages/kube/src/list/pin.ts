import type { Workbench } from "@twigo/workbench";
import { HEALTH } from "../columns";
import type { PinnedList } from "../explorer/pinned";
import type { ListServices } from "../services";
import { listUri, parseListUri } from "../uri";
import { namespacesOf } from "./scope";

/**
 * The list a list editor shows now, as a pin keeps it: its namespaces,
 * text and health baked into the URI, so the pin opens the same rows.
 */
export function pinOf(
  { states, statuses }: Pick<ListServices, "states" | "statuses">,
  spaces: Workbench["spaces"],
  uri: string,
): PinnedList | undefined {
  const input = parseListUri(uri);
  if (!input) return undefined;
  const text = states.text(uri) ?? input.text;
  const picked = states.health(uri);
  const health = picked === null ? undefined : (picked?.health ?? input.health);
  const namespaces = namespacesOf(spaces, input);
  return {
    uri: listUri({
      space: input.space,
      gvr: input.gvr,
      namespaces,
      ...(text && { text }),
      ...(input.labels && { labels: input.labels }),
      ...(health && { health }),
    }),
    title: statuses.get(uri)?.title ?? input.gvr.resource,
    detail: [
      health && HEALTH[health].title,
      namespaces.join(", "),
      text && `“${text}”`,
      input.labels,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
