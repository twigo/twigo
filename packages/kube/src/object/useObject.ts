import { useMemo } from "react";
import {
  INITIAL_OBJECT,
  ObjectView,
  type Backend,
  type ObjectParts,
  type ObjectQuery,
  type ObjectRef,
  type Resource,
} from "@twigo/protocol";
import { sameGvr, type Loaded } from "../discovery";
import { objectUri, type ObjectInput } from "../uri";
import { useOpenView } from "./useOpenView";

const open = (backend: Backend, query: ObjectQuery, parts: ObjectParts) =>
  new ObjectView(backend, query, parts);
const INITIAL = () => INITIAL_OBJECT;

/** An open object while `query` names one, following the parts that `parts` asks for. */
export function useObject(
  backend: Backend,
  query: ObjectQuery | undefined,
  parts: ObjectParts,
) {
  const { snapshot, current, id } = useOpenView(
    backend,
    open,
    query,
    parts,
    INITIAL,
  );
  const values = useMemo(
    () => current && ((keys: readonly string[]) => current.values(keys)),
    [current],
  );
  return { snapshot, values, id };
}

/** What opens an object, its resource told by discovery once that has come. */
export function objectQuery(
  input: ObjectInput,
  resources: Loaded<readonly Resource[]>,
): ObjectQuery {
  const known =
    resources.state === "ready"
      ? resources.value.find((resource) => sameGvr(resource.gvr, input.gvr))
      : undefined;
  return {
    space: input.space,
    gvr: input.gvr,
    namespaced: known?.namespaced ?? input.namespace !== undefined,
    namespace: input.namespace ?? null,
    name: input.name,
  };
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
