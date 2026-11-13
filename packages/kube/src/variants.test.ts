import { afterEach, expect, test } from "vitest";
import { variant } from "./variants";

afterEach(() => {
  history.replaceState(null, "", "/");
});

test("the first choice of each is the default, and the address picks others, several at once", () => {
  expect([
    variant("units"),
    variant("empty"),
    variant("usage"),
    variant("place"),
  ]).toEqual(["kubectl", "dash", "meters", "section"]);
  history.replaceState(null, "", "/?variant=units:adaptive,usage:text");
  expect([variant("units"), variant("usage"), variant("empty")]).toEqual([
    "adaptive",
    "text",
    "dash",
  ]);
  history.replaceState(
    null,
    "",
    "/?variant=empty:blank&variant=place:containers",
  );
  expect([variant("empty"), variant("place")]).toEqual(["blank", "containers"]);
});

test("what the address names wrongly leaves the default", () => {
  history.replaceState(null, "", "/?variant=units:huge,nothing:at-all,usage");
  expect([variant("units"), variant("usage")]).toEqual(["kubectl", "meters"]);
  history.replaceState(null, "", "/?variant=empty:text");
  expect([variant("empty"), variant("usage")]).toEqual(["dash", "meters"]);
});
