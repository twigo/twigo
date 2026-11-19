import { expect, test } from "vitest";
import { parseText } from "./textFilter";

function keeps(filter: string, cells: readonly string[]): boolean {
  return parseText(filter)?.keeps(cells) ?? true;
}

test("a substring in any case of any text, trimmed, never a regex without slashes", () => {
  expect(keeps("WEB", ["db-1", "web-7"])).toBe(true);
  expect(keeps("  web ", ["Web-7"])).toBe(true);
  expect(keeps("api", ["db-1", "web-7"])).toBe(false);
  expect(keeps("web.7", ["web-7"])).toBe(false);
});

test("a bang negates, and a bare one keeps everything", () => {
  expect(keeps("!api", ["web-7"])).toBe(true);
  expect(keeps("!web", ["web-7"])).toBe(false);
  expect(parseText("!")).toBeNull();
  expect(parseText("")).toBeNull();
});

test("a filter says whether it is a negation", () => {
  expect(parseText("api")?.negated).toBe(false);
  expect(parseText("/api/")?.negated).toBe(false);
  expect(parseText("!api")?.negated).toBe(true);
  expect(parseText("!/api/")?.negated).toBe(true);
});

test("slashes make a regex in any case, a substring until they close", () => {
  expect(keeps("/^WEB-\\d$/", ["web-7"])).toBe(true);
  expect(keeps("/^web-\\d$/", ["web-17"])).toBe(false);
  expect(keeps("!/^web/", ["db-1"])).toBe(true);
  expect(keeps("!/^web/", ["web-1"])).toBe(false);
  expect(keeps("/web-[", ["/web-[0"])).toBe(true);
});

test("a closed regex that does not parse is invalid input", () => {
  expect(() => parseText("/web-[/")).toThrow(
    expect.objectContaining({ kind: "invalidInput" }),
  );
});
