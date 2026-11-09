import { IpcError, ListView, type ListSnapshot } from "@twigo/protocol";
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
 * the rows of each value typed: those of its kind in the space, in every
 * namespace and not the ones selected for the lists, whose name holds the
 * text, which Rust filters as the live upstream serves them, so an object past
 * the first rows is found by typing its name, then the objects the space
 * opened lately, of any kind. Someone who may not list the kind cluster-wide
 * gets the selected namespaces and the object's own instead, and is told so;
 * if one of them is refused too, the object's own namespace alone; not there
 * either, and the picker says that.
 */
export function comparisons(
  workbench: Workbench,
  uri: string,
  namespaced: boolean,
): PickSource {
  return async (filter) => {
    const object = parseObjectUri(uri);
    if (!object) return [];
    const { backend, recent, spaces } = workbench;
    const text = filter.trim();
    const rows = (namespaces: readonly string[]): Promise<ListSnapshot> =>
      firstRows(
        new ListView(backend, {
          space: object.space,
          gvr: object.gvr,
          namespaced,
          namespaces: [...namespaces],
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
    let snapshot = await rows([]);
    let notice: string | undefined;
    if (snapshot.status.state === "forbidden") {
      const own = namespaced ? object.namespace : undefined;
      if (own !== undefined) {
        const together = [
          ...new Set([...spaces.state(object.space).namespaces, own]),
        ];
        snapshot = await rows(together);
        notice = `You may not list ${object.gvr.resource} in this cluster: these are from the namespaces selected and the object's own.`;
        // A view reads all its namespaces or none (twigo-cache's `combine`), so
        // one the person may not list refuses the others with it.
        if (snapshot.status.state === "forbidden" && together.length > 1) {
          snapshot = await rows([own]);
          notice = `You may not list ${object.gvr.resource} in this cluster, nor in the namespaces selected and the object's own: these are from the object's own namespace.`;
        }
      }
      if (own === undefined || snapshot.status.state === "forbidden") {
        throw new IpcError(
          "forbidden",
          own === undefined
            ? `You may not list ${object.gvr.resource} in this cluster.`
            : `You may not list ${object.gvr.resource} in this cluster, nor in the object's own namespace (${own}).`,
        );
      }
    }
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
    const items = [...sameKind, ...filtered(lately, filter)];
    return notice === undefined ? items : { items, notice };
  };
}
