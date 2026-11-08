import { ListView } from "@twigo/protocol";
import {
  filtered,
  type PickSource,
  type QuickPickItem,
  type Workbench,
} from "@twigo/workbench";
import { kindIcon } from "../kinds";
import { firstRows, substring } from "../quickaccess";
import { objectOfRow } from "../selection";
import { objectUri, parseObjectUri } from "../uri";

/**
 * The objects "Compare with…" offers for the object of `uri`, as it asks for
 * the rows of each value typed: those of its kind in the space whose name
 * holds the text, which Rust filters as the live upstream serves them, so an
 * object past the first rows is found by typing its name, then the objects
 * the space opened lately, of any kind.
 */
export function comparisons(
  workbench: Workbench,
  uri: string,
  namespaced: boolean,
): PickSource {
  return async (filter) => {
    const object = parseObjectUri(uri);
    if (!object) return [];
    const { spaces, backend, recent } = workbench;
    const text = filter.trim();
    const snapshot = await firstRows(
      new ListView(backend, {
        space: object.space,
        gvr: object.gvr,
        namespaced,
        namespaces: [...spaces.state(object.space).namespaces],
        labelSelector: null,
        fieldSelector: null,
        owners: null,
        text: text === "" ? null : text,
        columns: null,
        sort: null,
        countBy: null,
        groupBy: null,
        values: null,
      }),
    );
    const sameKind = snapshot.ids.flatMap((id) => {
      const { namespace, name } = objectOfRow(id, namespaced);
      const target = objectUri({
        space: object.space,
        gvr: object.gvr,
        ...(namespace !== undefined && { namespace }),
        name,
      });
      return target === uri
        ? []
        : [
            {
              id: target,
              label: name,
              matches: substring(name, filter),
              icon: kindIcon(object.gvr),
              ...(namespace !== undefined && { description: namespace }),
              group: "Same kind",
            } satisfies QuickPickItem,
          ];
    });
    const seen = new Set(sameKind.map(({ id }) => id));
    const lately = recent
      .list(object.space)
      .flatMap(({ uri: other, title }) => {
        const opened = parseObjectUri(other);
        return !opened || other === uri || seen.has(other)
          ? []
          : [
              {
                id: other,
                label: title,
                icon: kindIcon(opened.gvr),
                ...(opened.namespace !== undefined && {
                  description: opened.namespace,
                }),
                group: "Opened lately",
              } satisfies QuickPickItem,
            ];
      });
    return [...sameKind, ...filtered(lately, filter)];
  };
}
