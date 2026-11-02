import { expect, test } from "vitest";
import type { Cell, Column, ListQuery } from "../generated";
import CASES from "../query-cases.json";
import { compileQuery, queryColumns, runQuery, type QueryRow } from "./query";

interface CaseRow {
  namespace: string | null;
  name: string;
  created: string | null;
  labels: Record<string, string>;
  cells: Cell[];
}

test("only the choices' own keys count, not Object.prototype's", () => {
  const columns: Column[] = [
    { name: "Name", kind: "string", priority: 0 },
    { name: "constructor", kind: "string", priority: 1 },
  ];
  const query: ListQuery = {
    space: "kind-test",
    gvr: { group: "", version: "v1", resource: "widgets" },
    namespaced: false,
    namespaces: [],
    labelSelector: null,
    text: "x",
    columns: {},
    sort: null,
    groupBy: null,
    values: null,
  };
  const rows: QueryRow[] = [
    { id: "w", namespace: null, created: null, labels: {}, cells: ["w", "x"] },
  ];
  expect(runQuery(rows, compileQuery(query, columns)).rows).toEqual([]);
});

for (const list of CASES.lists) {
  const server = list.columns as Column[];
  for (const { name, query: partial, window, expect: wanted } of list.cases) {
    test(`${list.name}: ${name}`, () => {
      const query: ListQuery = {
        space: CASES.context,
        gvr: { group: "", version: "v1", resource: list.name },
        namespaced: list.namespaced,
        namespaces: [],
        labelSelector: null,
        text: null,
        columns: null,
        sort: null,
        groupBy: null,
        values: null,
        ...(partial as Partial<ListQuery>),
      };
      const columns = queryColumns(server, query);
      if ("refused" in wanted) {
        expect(() => compileQuery(query, columns)).toThrow(
          expect.objectContaining({ kind: wanted.refused }),
        );
        return;
      }
      const rows = (list.rows as CaseRow[]).map((row): QueryRow => {
        const [first, ...rest] = row.cells;
        const withNamespace = columns.length > server.length;
        return {
          id: `${CASES.context}/${row.namespace === null ? "" : `${row.namespace}/`}${row.name}`,
          namespace: row.namespace,
          created: row.created === null ? null : Date.parse(row.created),
          labels: row.labels,
          cells: withNamespace
            ? [first ?? null, row.namespace, ...rest]
            : row.cells,
        };
      });
      const result = runQuery(rows, compileQuery(query, columns));
      const [start, end] = window;
      expect({
        total: result.rows.length,
        ids: result.rows.slice(start, end).map((row) => row.id),
      }).toEqual({ total: wanted.total, ids: wanted.ids });
      if ("columns" in wanted) {
        expect(columns.map((column) => column.name)).toEqual(wanted.columns);
      }
      if ("groups" in wanted) expect(result.groups).toEqual(wanted.groups);
    });
  }
}
