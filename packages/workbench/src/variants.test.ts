import { afterEach, expect, test } from "vitest";
import { variant } from "./variants";

afterEach(() => {
  history.replaceState(null, "", "/");
});

test("a group the URL does not name takes its first variant, and the URL picks several at once", () => {
  expect(variant("code")).toBe("line");
  history.replaceState(null, "", "/?variant=code:copy,status:code");
  expect([variant("code"), variant("status"), variant("wait")]).toEqual([
    "copy",
    "code",
    "inline",
  ]);
  history.replaceState(null, "", "/?variant=wait:tooltip&variant=toast:none");
  expect([variant("wait"), variant("toast")]).toEqual(["tooltip", "none"]);
});

test("a name that is no variant of its group falls back to the first", () => {
  history.replaceState(null, "", "/?variant=code:everywhere,status:family:x");
  expect([variant("code"), variant("status")]).toEqual(["line", "family"]);
});
