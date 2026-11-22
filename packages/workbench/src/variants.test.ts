import { expect, test } from "vitest";
import { variants } from "./variants";

test("no variant is the recommended of each family, and a named one is read whatever the others say", () => {
  expect(variants("")).toEqual({
    helm: "explorer",
    tabs: "four",
    mask: "token",
  });
  expect(variants("?scenario=ready&variant=tabs:page,mask:tree")).toEqual({
    helm: "explorer",
    tabs: "page",
    mask: "tree",
  });
  expect(variants("?variant=tabs:nonsense,helm:sidebar")).toEqual({
    helm: "sidebar",
    tabs: "four",
    mask: "token",
  });
});
