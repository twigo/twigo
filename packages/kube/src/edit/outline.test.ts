import { expect, test } from "vitest";
import { landmarksOf, outlineOf, pathAt } from "./outline";

const pod = [
  "apiVersion: v1",
  "kind: Pod",
  "metadata:",
  "  name: web",
  "  managedFields:",
  "    - manager: kubectl",
  "      operation: Apply",
  "  namespace: shop",
  "spec:",
  "  containers:",
  "    - name: web",
  "      image: web:1",
  "",
].join("\n");

const keysOf = (text: string) =>
  landmarksOf(outlineOf(text)).keys.map(([start, end]) =>
    text.slice(start, end),
  );

test("the top-level keys are the keys of the root map, and no deeper one", () => {
  expect(keysOf(pod)).toEqual(["apiVersion", "kind", "metadata", "spec"]);
});

test("a quoted top-level key is marked with its quotes", () => {
  expect(keysOf('"kind": Pod\nspec: {}\n')).toEqual(['"kind"', "spec"]);
});

test("managedFields under metadata is the lines from its key to the end of its block", () => {
  expect(landmarksOf(outlineOf(pod)).managed).toEqual({ from: 5, to: 7 });
});

test("managedFields anywhere else is not the one the server fills", () => {
  expect(
    landmarksOf(outlineOf("managedFields: []\nspec:\n  managedFields: []\n"))
      .managed,
  ).toBeUndefined();
});

test("text that is no block map has no landmarks", () => {
  for (const text of ["", "- a\n- b\n", "{a: 1}\n", "just text\n"]) {
    expect(landmarksOf(outlineOf(text))).toEqual({
      keys: [],
      managed: undefined,
    });
  }
});

test("a text that does not parse keeps the keys read before the fault", () => {
  expect(keysOf("a: 1\nb: [\nc: 2\n")).toContain("a");
});

const deployment = [
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: web",
  "spec:",
  "  template:",
  "    spec:",
  "      # the web container",
  "      containers:",
  "        - name: web",
  "          image: web:1",
  '          args: ["--port", "80"]',
  "          command:",
  "            - sh",
  "            - -c",
  "        - name: sidecar",
  "          image: proxy:2",
  "",
].join("\n");

const at = (text: string, line: number) => pathAt(outlineOf(text), line);

test("a line in nested maps has the keys down to it", () => {
  expect(at(deployment, 7)).toEqual(["spec", "template", "spec"]);
  expect(at(deployment, 4)).toEqual(["metadata", "name"]);
});

test("the key on the cursor's own line is the last of the path", () => {
  expect(at(deployment, 2)).toEqual(["kind"]);
  expect(at(deployment, 9)).toEqual(["spec", "template", "spec", "containers"]);
  expect(at(deployment, 11)).toEqual([
    "spec",
    "template",
    "spec",
    "containers[0]",
    "image",
  ]);
});

test("an item of a sequence joins the key it belongs to, and the first key of a compact item is the item's own", () => {
  expect(at(deployment, 10)).toEqual([
    "spec",
    "template",
    "spec",
    "containers[0]",
    "name",
  ]);
  expect(at(deployment, 16)).toEqual([
    "spec",
    "template",
    "spec",
    "containers[1]",
    "name",
  ]);
  expect(at(deployment, 14)).toEqual([
    "spec",
    "template",
    "spec",
    "containers[0]",
    "command[0]",
  ]);
  expect(at("- name: a\n- name: b\n", 2)).toEqual(["[1]", "name"]);
});

test("a comment line has the path of the block it stands in", () => {
  expect(at(deployment, 8)).toEqual(["spec", "template", "spec"]);
});

test("a blank line inside a block has the path of the block", () => {
  expect(at("spec:\n  a: 1\n\n  b: 2\n", 3)).toEqual(["spec"]);
});

test("a flow collection is the value of its key", () => {
  expect(at(deployment, 12)).toEqual([
    "spec",
    "template",
    "spec",
    "containers[0]",
    "args",
  ]);
});

test("the lines of a block scalar are under its key", () => {
  expect(at("data:\n  script: |\n    echo a\n    echo b\n", 4)).toEqual([
    "data",
    "script",
  ]);
});

test("a position past the end, before the first line, or on a blank line between top-level keys has no path", () => {
  expect(at(deployment, 19)).toEqual([]);
  expect(at(deployment, 0)).toEqual([]);
  expect(at("a: 1\n\nb: 2\n", 2)).toEqual([]);
  expect(at("", 1)).toEqual([]);
});
