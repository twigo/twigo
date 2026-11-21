import { expect, test } from "vitest";
import { scopeWords } from "./scope";

test("a scope says its first name and how many follow it, all of them in a line, and the tooltip's words", () => {
  expect(scopeWords([])).toEqual({
    name: "All namespaces",
    more: 0,
    all: "All namespaces",
    tooltip: "All namespaces",
  });
  expect(scopeWords(["payments"])).toEqual({
    name: "payments",
    more: 0,
    all: "payments",
    tooltip: "Namespace: payments",
  });
  expect(scopeWords(["auth", "payments", "search"])).toEqual({
    name: "auth",
    more: 2,
    all: "auth, payments, search",
    tooltip: "Namespaces: auth, payments, search",
  });
});
