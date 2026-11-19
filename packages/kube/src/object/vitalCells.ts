import { useState } from "react";
import type { Gvr, ShownUsage, Vital } from "@twigo/protocol";
import { METRICS_NOTES } from "../list/metrics";
import { figure, LABEL, type Figure, type Resource } from "./figures";

const MOST = 4;

/** One cell of the strip: Rust's vital, a pod's measure from its usage, or a place held for one that has not come. */
export type VitalCell =
  | { readonly key: string; readonly kind: "vital"; readonly vital: Vital }
  | {
      readonly key: string;
      readonly kind: "measure";
      readonly resource: Resource;
      readonly usage: ShownUsage | undefined;
    }
  | { readonly key: string; readonly kind: "held" };

export const labelOf = (cell: VitalCell): string =>
  cell.kind === "vital"
    ? cell.vital.label
    : cell.kind === "measure"
      ? LABEL[cell.resource]
      : cell.key;

/** The labels of a strip's cells, which the next object of the kind holds its place by. */
export const labelsOf = (cells: readonly VitalCell[]): readonly string[] =>
  cells.map(labelOf);

/**
 * The strip's cells for an object: the vitals Rust gives it, and a pod's CPU
 * and Memory from its usage, which are not among them. With no vitals yet,
 * the labels the last object of its kind had stand in as places.
 */
export function vitalCells(
  gvr: Gvr,
  vitals: readonly Vital[] | undefined,
  usage: ShownUsage | undefined,
  held: readonly string[] | undefined,
): readonly VitalCell[] {
  if (vitals === undefined)
    return (held ?? []).slice(0, MOST).map((label) => ({
      key: label,
      kind: "held",
    }));
  const measures: readonly VitalCell[] =
    gvr.group === "" && gvr.resource === "pods"
      ? (["cpu", "memory"] as const).map((resource) => ({
          key: resource,
          kind: "measure",
          resource,
          usage,
        }))
      : [];
  return [
    ...vitals.map((vital): VitalCell => ({
      key: vital.label,
      kind: "vital",
      vital,
    })),
    ...measures,
  ].slice(0, MOST);
}

/** What a measure's cell says: its figure, or why it has none. */
export type Measured =
  | { readonly state: "figure"; readonly figure: Figure }
  | { readonly state: "none"; readonly reason: string };

export function measured(
  usage: ShownUsage | undefined,
  resource: Resource,
): Measured {
  if (usage === undefined)
    return {
      state: "none",
      reason: "No figures yet: the Metrics API has not answered, or is absent.",
    };
  if (usage.state !== "ready")
    return { state: "none", reason: METRICS_NOTES[usage.state] };
  if (usage.waiting)
    return { state: "none", reason: "Waiting for the first sample." };
  const shown = figure(resource, usage[resource]);
  return shown.used === null
    ? { state: "none", reason: "No data yet." }
    : { state: "figure", figure: shown };
}

/**
 * What the last object of a kind had, held for the next one, so that what
 * depends on it keeps its place while an object comes and the selection moves
 * along rows of one kind. A kind not seen yet has none to hold.
 */
export function useHeldPerKind<T>(
  kind: string,
  value: T | undefined,
  same: (a: T, b: T) => boolean,
): T | undefined {
  const [held, setHeld] = useState<ReadonlyMap<string, T>>(new Map());
  const was = held.get(kind);
  if (value !== undefined && (was === undefined || !same(was, value)))
    setHeld(new Map(held).set(kind, value));
  return value ?? was;
}

export const sameLabels = (
  a: readonly string[],
  b: readonly string[],
): boolean =>
  a.length === b.length && a.every((label, index) => label === b[index]);
