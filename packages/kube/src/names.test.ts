import { expect, test } from "vitest";
import { splitName } from "./names";

test.each([
  ["auth-api-7f9c8d6b5-x2kq9", 9, "auth-api-", "7f9c8d6b5-", "x2kq9"],
  ["node-exporter-4xq9z", 14, "node-exporter-", "", "4xq9z"],
  ["backup-28934", 7, "backup-", "", "28934"],
  ["a-b-c-d", 2, "a-", "b-c-", "d"],
])(
  "%s with its generated part from %d reads %s, %s and %s",
  (name, generated, first, hash, last) => {
    expect(splitName(name, generated)).toEqual({ first, hash, last });
  },
);

test.each([
  ["auth-api", null],
  ["auth-api", 0],
  ["auth-api", 8],
  ["auth-api", 12],
])("%s with a generated part from %s stays whole", (name, generated) => {
  expect(splitName(name, generated)).toEqual({
    first: name,
    hash: "",
    last: "",
  });
});
