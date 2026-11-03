import { expect, test } from "vitest";
import type { Cell, Column, ListQuery } from "../generated";
import CASES from "../query-cases.json";
import { compileQuery, queryColumns, runQuery, type QueryRow } from "./query";

interface CaseRow {
  namespace: string | null;
  name: string;
  created: string | null;
  labels: Record<string, string>;
  owners?: { uid: string; controller: boolean }[];
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
    fieldSelector: null,
    owners: null,
    text: "x",
    columns: {},
    sort: null,
    countBy: null,
    groupBy: null,
    values: null,
  };
  const rows: QueryRow[] = [
    {
      id: "w",
      namespace: null,
      created: null,
      labels: {},
      controller: null,
      cells: ["w", "x"],
    },
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
        fieldSelector: null,
        owners: null,
        text: null,
        columns: null,
        sort: null,
        countBy: null,
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
          controller:
            row.owners?.find((owner) => owner.controller)?.uid ?? null,
          cells: withNamespace
            ? [first ?? null, row.namespace, ...rest]
            : row.cells,
        };
      });
      const result = runQuery(rows, compileQuery(query, columns));
      const [start, end] = window;
      expect({
        total: result.rows.length,
        ids: result.readable.slice(start, end).map((row) => row.id),
      }).toEqual({ total: wanted.total, ids: wanted.ids });
      if ("columns" in wanted) {
        expect(columns.map((column) => column.name)).toEqual(wanted.columns);
      }
      if ("counts" in wanted) expect(result.counts).toEqual(wanted.counts);
      if (query.groupBy !== null) {
        expect(result.groups).toEqual(
          "groups" in wanted ? wanted.groups : null,
        );
      }
    });
  }
}
