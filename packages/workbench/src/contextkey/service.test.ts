import { afterEach, expect, test } from "vitest";
import { ContextKeys } from "./service";

afterEach(() => {
  document.body.replaceChildren();
});

function tree() {
  document.body.innerHTML = `
    <div id="list"><button id="row"></button><input id="filter" /></div>
    <div id="editor"><button id="tab"></button></div>`;
  const get = (id: string) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`no #${id}`);
    return element;
  };
  return {
    list: get("list"),
    row: get("row"),
    filter: get("filter"),
    editor: get("editor"),
    tab: get("tab"),
  };
}

test("a scoped key holds only from inside its element", () => {
  const keys = new ContextKeys();
  const { list, row, tab } = tree();
  keys.scope(list).set("listFocus", true);
  expect(keys.lookup(row)("listFocus")).toBe(true);
  expect(keys.lookup(list)("listFocus")).toBe(true);
  expect(keys.lookup(tab)("listFocus")).toBeUndefined();
  expect(keys.lookup(null)("listFocus")).toBeUndefined();
});

test("the innermost scope wins over outer scopes and global keys", () => {
  const keys = new ContextKeys();
  const { list, row, tab } = tree();
  keys.set("resource.kind", "Node");
  keys.scope(document.body).set("resource.kind", "Deployment");
  keys.scope(list).set("resource.kind", "Pod");
  expect(keys.lookup(row)("resource.kind")).toBe("Pod");
  expect(keys.lookup(tab)("resource.kind")).toBe("Deployment");
  expect(keys.lookup(null)("resource.kind")).toBe("Node");
});

test("unsetting a scoped key reveals the outer value", () => {
  const keys = new ContextKeys();
  const { list, row } = tree();
  keys.set("selection.count", 0);
  const scope = keys.scope(list);
  scope.set("selection.count", 3);
  expect(keys.lookup(row)("selection.count")).toBe(3);
  scope.set("selection.count", undefined);
  expect(keys.lookup(row)("selection.count")).toBe(0);
});

test("a disposed scope stops holding", () => {
  const keys = new ContextKeys();
  const { list, row } = tree();
  const scope = keys.scope(list);
  scope.set("listFocus", true);
  scope.dispose();
  expect(keys.lookup(row)("listFocus")).toBeUndefined();
  expect(() => keys.scope(list)).not.toThrow();
});

test("an element takes one scope", () => {
  const keys = new ContextKeys();
  const { list } = tree();
  keys.scope(list);
  expect(() => keys.scope(list)).toThrow();
});

test("inputFocus follows the element, whatever the scopes say", () => {
  const keys = new ContextKeys();
  const { list, row, filter } = tree();
  keys.scope(list).set("inputFocus", true);
  expect(keys.lookup(filter)("inputFocus")).toBe(true);
  expect(keys.lookup(row)("inputFocus")).toBe(false);
});

test("changes notify subscribers and bump the version", () => {
  const keys = new ContextKeys();
  const { list } = tree();
  let calls = 0;
  const unsubscribe = keys.subscribe(() => calls++);
  const before = keys.version;
  keys.set("platform", "mac");
  keys.set("platform", "mac");
  const scope = keys.scope(list);
  scope.set("listFocus", true);
  scope.dispose();
  expect(calls).toBe(3);
  expect(keys.version).toBe(before + 3);
  unsubscribe();
  keys.set("platform", "linux");
  expect(calls).toBe(3);
});
