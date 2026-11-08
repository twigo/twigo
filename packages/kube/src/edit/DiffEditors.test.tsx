import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { Discovery } from "../discovery";
import { diffUri } from "../uri";
import { DiffEditor } from "./DiffEditors";
import { resourceVersionOf, yamlOfJson } from "./object";
import { setupEdit } from "../../test/edits";
import { createEdits } from "./services";

vi.mock("./DiffView", () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <pre data-testid="diff">
      {original}
      {"\n---\n"}
      {modified}
    </pre>
  ),
}));

afterEach(cleanup);

const POD = "k8s://prod-eu//v1/pods/auth/auth-api-1a4uyl1-r2bkk";
const SECRET = "k8s://prod-eu//v1/secrets/auth/credentials";
const OTHER_SECRET = "k8s://prod-eu//v1/secrets/auth/tokens";
const NOT_RECORDED = "k8s://prod-eu//v1/limitranges/auth/limits";

async function shown(uri: string) {
  const workbench = await testWorkbench("ready");
  const edits = createEdits(workbench);
  const discovery = new Discovery(workbench);
  const view = () => (
    <DiffEditor uri={uri} edits={edits} discovery={discovery} />
  );
  render(view(), { wrapper: inWorkbench(workbench) });
  return { workbench, edits };
}

test("the diff against the server follows the object itself, which nothing else has open", async () => {
  const workbench = await testWorkbench("ready");
  const edits = createEdits(workbench);
  const discovery = new Discovery(workbench);
  edits.copies.edit(POD, "kind: Pod\n", {
    space: "prod-eu",
    base: JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "auth-api-1a4uyl1-r2bkk", resourceVersion: "1" },
      spec: { containers: [{ name: "as-opened" }] },
    }),
    lock: "1",
  });
  expect(edits.copies.live(POD)).toBeUndefined();
  render(
    <DiffEditor
      uri={diffUri({ kind: "server", editor: POD })}
      edits={edits}
      discovery={discovery}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  const diff = (await screen.findByTestId("diff")).textContent;
  expect(diff).toContain("as-opened");
  expect(diff).toContain("name: auth-api-1a4uyl1-r2bkk");
  expect(diff.split("---\n")[1]).not.toContain("as-opened");
});

test("the diff against the server tells the working copy what it read, so that Keep mine locks to what the diff shows", async () => {
  const workbench = await testWorkbench("ready");
  const edits = createEdits(workbench);
  const discovery = new Discovery(workbench);
  const older = JSON.stringify({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "auth-api-1a4uyl1-r2bkk", resourceVersion: "1" },
  });
  edits.copies.edit(POD, "kind: Pod\n", {
    space: "prod-eu",
    base: older,
    lock: "1",
  });
  edits.copies.see(POD, older, false);
  render(
    <DiffEditor
      uri={diffUri({ kind: "server", editor: POD })}
      edits={edits}
      discovery={discovery}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  const diff = (await screen.findByTestId("diff")).textContent;
  const seen = edits.copies.live(POD);
  expect(seen).not.toBe(older);
  expect(diff.split("---\n")[1]).toBe(yamlOfJson(seen ?? ""));
  expect(edits.copies.serverChanged(POD)).toBe(true);

  edits.copies.keepMine(POD);
  expect(edits.copies.get(POD)).toMatchObject({
    lock: resourceVersionOf(seen ?? ""),
    locked: seen,
  });
  expect(edits.copies.serverChanged(POD)).toBe(false);
});

test("the diff against the server offers Reload and Keep mine, and no Compare, which is where it is", async () => {
  const { workbench, edits, discovery, uri } = await setupEdit("ready", "dev");
  render(
    <DiffEditor
      uri={diffUri({ kind: "server", editor: uri })}
      edits={edits}
      discovery={discovery}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  await screen.findByTestId("diff");
  expect(
    screen.getAllByRole("button").map((button) => button.textContent.trim()),
  ).toEqual(["Reload", "Keep mine"]);
});

test("comparing objects says when one cannot be read, and that a Secret's values are hidden", async () => {
  await shown(
    diffUri({
      kind: "objects",
      space: "prod-eu",
      left: POD,
      right: NOT_RECORDED,
    }),
  );
  expect(await screen.findByText("Nothing to compare")).toBeTruthy();
  expect(
    screen.getByText(/auth\/limits: Could not load the object/),
  ).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  cleanup();

  await shown(
    diffUri({
      kind: "objects",
      space: "prod-eu",
      left: SECRET,
      right: OTHER_SECRET,
    }),
  );
  expect(await screen.findByTestId("diff")).toBeTruthy();
  expect(
    screen.getByText(
      /values are hidden, as their sizes: values of the same size may still differ/,
    ),
  ).toBeTruthy();
  cleanup();

  await shown(
    diffUri({
      kind: "objects",
      space: "prod-eu",
      left: POD,
      right: POD.replace("r2bkk", "x"),
    }),
  );
  await screen.findByTestId("diff");
  expect(screen.queryByText(/values are hidden/)).toBeNull();
});
