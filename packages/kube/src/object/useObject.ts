import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  INITIAL_OBJECT,
  ObjectView,
  type Backend,
  type ObjectParts,
  type ObjectQuery,
  type ObjectRef,
  type Resource,
} from "@twigo/protocol";
import { objectUri } from "../uri";

const NOTHING = () => () => undefined;
const INITIAL = () => INITIAL_OBJECT;

/**
 * An open object while `query` names one, following the parts shown. A new
 * query opens its object, which replaces the last one's on its first
 * batch; the snapshot is only ever the current query's.
 */
export function useObject(
  backend: Backend,
  query: ObjectQuery | undefined,
  parts: ObjectParts,
) {
  const key = query && JSON.stringify(query);
  const [live, setLive] = useState<{ key: string; view: ObjectView }>();
  const shown = useRef(parts);
  const { overview, manifest, events, related } = parts;
  useEffect(() => {
    shown.current = { overview, manifest, events, related };
  }, [overview, manifest, events, related]);
  useEffect(() => {
    if (key === undefined) return;
    const view = new ObjectView(
      backend,
      JSON.parse(key) as ObjectQuery,
      shown.current,
    );
    const first = view.subscribe(() => {
      first();
      setLive({ key, view });
    });
    return () => {
      first();
      view.close();
      setLive((shown) => (shown?.view === view ? undefined : shown));
    };
  }, [backend, key]);
  const current = live?.key === key ? live?.view : undefined;
  useEffect(() => {
    current?.setParts({ overview, manifest, events, related });
  }, [current, overview, manifest, events, related]);
  const snapshot = useSyncExternalStore(
    current?.subscribe ?? NOTHING,
    current?.getSnapshot ?? INITIAL,
  );
  const values = useMemo(
    () => current && ((keys: readonly string[]) => current.values(keys)),
    [current],
  );
  return { snapshot, values };
}

/**
 * The resource of the object a link points at, found in the space's
 * resources by its group and kind, its version preferred.
 */
export function refResource(
  resources: readonly Resource[],
  target: ObjectRef,
): Resource | undefined {
  const candidates = resources.filter(
    (resource) =>
      resource.gvr.group === target.group && resource.kind === target.kind,
  );
  return (
    candidates.find((candidate) => candidate.gvr.version === target.version) ??
    candidates[0]
  );
}

/**
 * The editor URI of the object a link points at, its namespace dropped
 * when the kind is cluster-scoped.
 */
export function refUri(
  space: string,
  resources: readonly Resource[],
  target: ObjectRef,
): string | undefined {
  const resource = refResource(resources, target);
  if (!resource) return undefined;
  return objectUri({
    space,
    gvr: resource.gvr,
    ...(resource.namespaced &&
      target.namespace !== null && { namespace: target.namespace }),
    name: target.name,
  });
}
