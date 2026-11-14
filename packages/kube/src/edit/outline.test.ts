import { expect, test } from "vitest";
import { landmarksOf, outlineOf } from "./outline";

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
