import { expect, test } from "vitest";
import { refusal } from "./viewState";

test("a refusal says what Rust's ViewState::refusal says, and a state that is none says nothing", () => {
  expect(
    refusal({ state: "forbidden", verb: "list", resource: "pods" }),
  ).toEqual({
    code: "server.forbidden",
    kind: "forbidden",
    message: "You may not list pods.",
  });
  expect(refusal({ state: "unauthorized" })).toEqual({
    code: "server.unauthorized",
    kind: "unauthorized",
    message: "The cluster does not accept the credentials.",
  });
  const error = {
    code: "server.invalid",
    kind: "invalidInput",
    message: "no",
  } as const;
  expect(refusal({ state: "error", error })).toBe(error);
  expect(refusal({ state: "connecting" })).toBeUndefined();
  expect(refusal({ state: "ready" })).toBeUndefined();
});
