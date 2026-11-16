import { expect, test } from "vitest";
import { testWorkbench } from "@twigo/workbench/testing";
import { ListStates } from "../listState";
import { parseListUri } from "../uri";
import { followingTheSpace } from "./pin";
import { namespacesOf, showAllNamespaces } from "./scope";

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

  showAllNamespaces(spaces, "prod-eu");
  expect(namespacesOf(spaces, input(PODS))).toEqual([]);
});

test("a list that follows the space is the list as it stands, text and health kept, without namespaces of its own", () => {
  const states = new ListStates();
  const uri = `${PODS}?ns=a,b&q=api&l=app%3Dweb&h=error`;
  expect(followingTheSpace({ states }, uri)).toBe(
    `${PODS}?q=api&l=app%3Dweb&h=error`,
  );

  states.setText(uri, "web");
  states.setHealth(uri, { health: "warn", values: ["Pending"] });
  expect(followingTheSpace({ states }, uri)).toBe(
    `${PODS}?q=web&l=app%3Dweb&h=warn`,
  );
});
