import type { Gvr } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import type { Discovery } from "./discovery";
import { PODS } from "./kinds";
import {
  parseExecUri,
  parseListUri,
  parseLogsUri,
  parseObjectUri,
  parseTerminalUri,
  parseUntitledUri,
} from "./uri";

const SEPARATOR = " › ";

export type TabPaths = ReturnType<typeof tabPaths>;

/**
 * What a tab's tooltip says, in one order whatever the tab: the space's
 * context, the namespace, the kind, the object. The context is the one of
 * the tab's own space, which the URI names, whichever space is shown.
 */
export function tabPaths(
  { spaces, editors }: Pick<Workbench, "spaces" | "editors">,
  discovery: Pick<Discovery, "last">,
) {
  const contextsOf = (space: string) =>
    spaces.list.find((each) => each.id === space)?.contexts;
  const resourceOf = (space: string, { group, resource }: Gvr) => {
    const found = discovery.last(space);
    return found?.state === "ready"
      ? found.value.find(
          (each) => each.gvr.group === group && each.gvr.resource === resource,
        )
      : undefined;
  };
  const path = (space: string, ...rest: readonly (string | undefined)[]) => {
    const contexts = contextsOf(space);
    return contexts === undefined
      ? undefined
      : [
          contexts.join(" + "),
          ...rest.filter((part) => part !== undefined),
        ].join(SEPARATOR);
  };
  const objectPath = (
    space: string,
    gvr: Gvr,
    namespace: string | undefined,
    name: string,
    ...rest: readonly string[]
  ) =>
    path(
      space,
      namespace,
      resourceOf(space, gvr)?.kind ?? gvr.resource,
      name,
      ...rest,
    );

  return {
    list: (uri: string) => {
      const input = parseListUri(uri);
      if (!input) return undefined;
      const { space, gvr, namespaces = spaces.state(space).namespaces } = input;
      const scope =
        namespaces.length === 0 ? "All namespaces" : namespaces.join(", ");
      return path(
        space,
        resourceOf(space, gvr)?.namespaced === false ? undefined : scope,
        editors.title(uri) ?? gvr.resource,
      );
    },
    object: (uri: string) => {
      const input = parseObjectUri(uri);
      return (
        input && objectPath(input.space, input.gvr, input.namespace, input.name)
      );
    },
    logs: (uri: string) => {
      const input = parseLogsUri(uri);
      return (
        input && objectPath(input.space, input.gvr, input.namespace, input.name)
      );
    },
    exec: (uri: string) => {
      const input = parseExecUri(uri);
      return (
        input &&
        objectPath(
          input.space,
          PODS,
          input.namespace,
          input.pod,
          input.container,
        )
      );
    },
    terminal: (uri: string) => {
      const input = parseTerminalUri(uri);
      return input && contextsOf(input.space)?.[0];
    },
    manifest: (uri: string) => {
      const input = parseUntitledUri(uri);
      return input && path(input.space);
    },
  };
}
