import { expect, test } from "vitest";
import { testWorkbench } from "@twigo/workbench/testing";
import { parseListUri } from "../uri";
import { namespacesOf, whereWords } from "./scope";

const PODS = "k8s-list://prod-eu/v1/pods";

function input(uri: string) {
  const parsed = parseListUri(uri);
  if (!parsed) throw new Error(`not a list: ${uri}`);
  return parsed;
}

test("a list reads its own namespaces when its URI names them, else the space's scope", async () => {
  const { spaces } = await testWorkbench();
  spaces.update("prod-eu", (state) => ({ ...state, namespaces: ["auth"] }));
  expect(namespacesOf(spaces, input(`${PODS}?ns=a,b`))).toEqual(["a", "b"]);
  expect(namespacesOf(spaces, input(PODS))).toEqual(["auth"]);
});

test("where a list looks reads the space's contexts before the namespaces it is narrowed to", async () => {
  const { spaces } = await testWorkbench();
  expect(whereWords(spaces, "prod-eu", [])).toBe("prod-eu");
  expect(whereWords(spaces, "prod-eu", ["payments"])).toBe(
    "prod-eu · payments",
  );
  expect(whereWords(spaces, "prod-eu", ["payments", "auth"])).toBe(
    "prod-eu · payments, auth",
  );
  expect(whereWords(spaces, "gone", [])).toBe("gone");
});
