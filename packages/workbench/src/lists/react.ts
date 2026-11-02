import { useCallback } from "react";
import type { ListController } from "@twigo/ui";
import type { ContextValue } from "../contextkey/when";
import { useWorkbench } from "../react";

/**
 * The `register` callback of a `DataGrid` or a `Tree`: while the widget is
 * mounted, its element scopes `listFocus` and the given keys, and the list
 * commands reach its controller.
 */
export function useListRegistration(
  keys: Readonly<Record<string, ContextValue>> = {},
): (element: HTMLElement, controller: ListController) => () => void {
  const { lists, keys: contextKeys } = useWorkbench();
  const scoped = JSON.stringify(keys);
  return useCallback(
    (element: HTMLElement, controller: ListController) => {
      const scope = contextKeys.scope(element);
      scope.set("listFocus", true);
      for (const [key, value] of Object.entries(
        JSON.parse(scoped) as Record<string, ContextValue>,
      ))
        scope.set(key, value);
      const unregister = lists.register(element, controller);
      return () => {
        unregister();
        scope.dispose();
      };
    },
    [contextKeys, lists, scoped],
  );
}
