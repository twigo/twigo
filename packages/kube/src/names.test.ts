import { expect, test } from "vitest";
import { splitName } from "./names";

test.each([
  ["auth-api-7f9c8d6b5-x2kq9", 9, "auth-api-", "7f9c8d6b5-", "x2kq9"],
  ["node-exporter-4xq9z", 14, "node-exporter-", "", "4xq9z"],
  ["a-b-c-d", 2, "a-", "b-c-", "d"],
])(
  "%s with its generated part from %d reads %s, %s and %s",
  (name, generated, first, hash, last) => {
    expect(splitName(name, generated)).toEqual({ first, hash, last });
  },
);

test("a name with no generated part stays whole", () => {
  expect(splitName("auth-api", null)).toEqual({
    first: "auth-api",
    hash: "",
    last: "",
  });
});
