import { IpcError } from "../error";
import type { Column, ListQuery } from "../generated";
import { podCells, type Pod } from "./cluster";
import { POD_COLUMNS } from "./fixtures";

const collator = new Intl.Collator("en", { numeric: true });

/** The columns of a query: Context in multi-context spaces, Namespace unless one namespace is chosen. */
export function podColumns(contexts: number, query: ListQuery): Column[] {
  const [name, ...rest] = POD_COLUMNS;
  if (!name) throw new Error("POD_COLUMNS is empty");
  return [
    ...(contexts > 1
      ? [{ name: "Context", kind: "string" as const, priority: 0 }]
      : []),
    name,
    ...(query.namespaces.length === 1
      ? []
      : [{ name: "Namespace", kind: "string" as const, priority: 0 }]),
    ...rest,
  ];
}

export function checkQuery(query: ListQuery, columns: readonly Column[]): void {
  if (
    query.gvr.group !== "" ||
    query.gvr.version !== "v1" ||
    query.gvr.resource !== "pods"
  ) {
    throw new IpcError(
      "notFound",
      `the mock backend serves only pods, not ${query.gvr.resource}`,
    );
  }
  if (query.labelSelector) {
    throw new IpcError(
      "invalidInput",
      "the mock backend does not filter by label",
    );
  }
  if (
    query.sort &&
    !columns.some((column) => column.name === query.sort?.column)
  ) {
    throw new IpcError("invalidInput", `no column ${query.sort.column}`);
  }
  if (
    query.values &&
    !columns.some((column) => column.name === query.values?.column)
  ) {
    throw new IpcError("invalidInput", `no column ${query.values.column}`);
  }
}

/**
 * Filters on the shown columns and sorts, as Rust's query view does
 * (ARCHITECTURE 3.4). `counted` are the matches before `values`, which the
 * grouped counts come from.
 */
export function runQuery(
  pods: readonly Pod[],
  query: ListQuery,
  columns: readonly Column[],
): { rows: Pod[]; counted: Pod[] } {
  const withContext = columns[0]?.name === "Context";
  const withNamespace = columns.some((column) => column.name === "Namespace");
  const cells = (pod: Pod) => podCells(pod, withContext, withNamespace);
  const shown = columns.flatMap((column, i) =>
    column.priority === 0 ? [i] : [],
  );
  const namespaces = new Set(query.namespaces);
  const text = query.text?.trim().toLowerCase() ?? "";
  const negate = text.startsWith("!");
  const needle = negate ? text.slice(1) : text;
  const matches = pods.filter((pod) => {
    if (namespaces.size > 0 && !namespaces.has(pod.namespace)) return false;
    if (needle === "") return true;
    const row = cells(pod);
    const hit = shown.some((i) => {
      const cell = row[i];
      return typeof cell === "string" && cell.toLowerCase().includes(needle);
    });
    return hit !== negate;
  });
  const valuesAt = columns.findIndex(
    (column) => column.name === query.values?.column,
  );
  const kept = new Set(query.values?.values);
  const rows = query.values
    ? matches.filter((pod) => kept.has(String(cells(pod)[valuesAt] ?? "")))
    : matches;
  const sort = query.sort ?? { column: "Name", descending: false };
  const index = columns.findIndex((column) => column.name === sort.column);
  const age = columns[index]?.kind === "age";
  const keyed = rows.map((pod) => ({ pod, key: cells(pod)[index] }));
  keyed.sort((a, b) => {
    const order = age
      ? b.pod.created - a.pod.created
      : collator.compare(String(a.key ?? ""), String(b.key ?? ""));
    return (
      (sort.descending ? -order : order) || collator.compare(a.pod.id, b.pod.id)
    );
  });
  return { rows: keyed.map(({ pod }) => pod), counted: matches };
}
