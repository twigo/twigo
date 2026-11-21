import { afterEach, expect, test } from "vitest";
import { variant } from "./variants";

afterEach(() => {
  history.replaceState(null, "", "/");
});

test("a variant is read from the page's URL by its group", () => {
  expect(variant("pick")).toBeUndefined();
  history.replaceState(null, "", "/?variant=pick:live,crumb:list");
  expect(variant("pick")).toBe("live");
  expect(variant("crumb")).toBe("list");
  expect(variant("other")).toBeUndefined();
});
