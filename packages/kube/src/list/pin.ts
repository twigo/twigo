import type { Workbench } from "@twigo/workbench";
import { HEALTH } from "../columns";
import type { PinnedList } from "../explorer/pinned";
import type { ListServices } from "../services";
import { listUri, parseListUri, type ListInput } from "../uri";
import { namespacesOf } from "./scope";

/**
 * A list as the person has it now, its own namespaces aside: the text and
 * health they set over the ones it opened with.
 */
export function standing(
  { states }: Pick<ListServices, "states">,
  uri: string,
  input: ListInput,
): ListInput {
  const text = states.text(uri) ?? input.text;
  const picked = states.health(uri);
  const health = picked === null ? undefined : (picked?.health ?? input.health);
  return {
    space: input.space,
    gvr: input.gvr,
    ...(text && { text }),
    ...(input.labels && { labels: input.labels }),
    ...(health && { health }),
  };
}

/** The list as it stands without namespaces of its own, which follows its space's scope. */
export function followingTheSpace(
  services: Pick<ListServices, "states">,
  uri: string,
): string | undefined {
  const input = parseListUri(uri);
  return input && listUri(standing(services, uri, input));
}

/**
 * The list a list editor shows now, as a pin keeps it: its namespaces,
 * text and health baked into the URI, so the pin opens the same rows.
 */
export function pinOf(
  services: Pick<ListServices, "states" | "statuses">,
  spaces: Workbench["spaces"],
  uri: string,
): PinnedList | undefined {
  const input = parseListUri(uri);
  if (!input) return undefined;
  const stood = standing(services, uri, input);
  const namespaces = namespacesOf(spaces, input);
  return {
    uri: listUri({ ...stood, namespaces }),
    title: services.statuses.get(uri)?.title ?? input.gvr.resource,
    detail: [
      stood.health && HEALTH[stood.health].title,
      namespaces.join(", "),
      stood.text && `“${stood.text}”`,
      stood.labels,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
