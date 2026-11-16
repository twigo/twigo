import type { Workbench } from "@twigo/workbench";
import { HEALTH } from "../columns";
import type { PinnedList } from "../explorer/pinned";
import { objectOf } from "../selection";
import type { ListServices } from "../services";
import { listUri, parseListUri, type ListInput } from "../uri";
import { namespacesOf } from "./scope";

/**
 * A list as the person has it now, its own namespaces aside: the text and
 * health they set over the ones it opened with.
 */
function standing(
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
 * Puts the list that follows its space in the place of one with namespaces of
 * its own, which keeps its tab's group and position, and carries what the
 * person set in it: the sort, the collapsed groups, the details open and
 * their view, and the selected row where the space's scope still reads it.
 */
export function followTheSpace(
  services: Pick<ListServices, "states" | "selection">,
  { spaces, editors }: Pick<Workbench, "spaces" | "editors">,
  uri: string,
): void {
  const input = parseListUri(uri);
  const next = followingTheSpace(services, uri);
  if (!input || next === undefined) return;
  const { states, selection } = services;
  states.carry(uri, next);
  const selected = selection.get(uri);
  const scope = spaces.state(input.space).namespaces;
  const namespace = selected && objectOf(selected).namespace;
  if (
    selected &&
    (scope.length === 0 || namespace === undefined || scope.includes(namespace))
  ) {
    selection.set(next, selected);
  }
  editors.replace(uri, next);
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
