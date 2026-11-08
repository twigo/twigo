import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { Discovery } from "../discovery";
import { diffUri } from "../uri";
import { DiffEditor } from "./DiffEditors";
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
  expect(edits.copies.live(POD)).toBeUndefined();
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
