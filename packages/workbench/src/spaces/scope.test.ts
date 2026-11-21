import { expect, test } from "vitest";
import { scopeNames, scopeWords } from "./scope";

test("a scope is written sorted and with no name twice", () => {
  expect(scopeNames(["search", "auth", "search", "payments"])).toEqual([
    "auth",
    "payments",
    "search",
  ]);
  expect(scopeNames([])).toEqual([]);
});

test("a scope says its first name and how many follow it, and all of them in a line", () => {
  expect(scopeWords([])).toEqual({
    name: "All namespaces",
    more: 0,
    all: "All namespaces",
  });
  expect(scopeWords(["payments"])).toEqual({
    name: "payments",
    more: 0,
    all: "payments",
  });
  expect(scopeWords(["auth", "payments", "search"])).toEqual({
    name: "auth",
    more: 2,
    all: "auth, payments, search",
  });
});
