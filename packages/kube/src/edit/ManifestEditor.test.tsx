import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { Discovery } from "../discovery";
import { ManifestEditor } from "./ManifestEditor";
import { createEdits } from "./services";

vi.mock("./YamlEditor", () => ({
  default: ({ schema }: { schema?: { source: string } }) => (
    <p data-testid="schema">{schema?.source ?? "none"}</p>
  ),
}));

afterEach(cleanup);

const URI = "untitled://manifest-1";

async function typing(kinds: readonly string[]) {
  const real = createMockBackend("ready");
  const asked: unknown[] = [];
  const backend: Backend = {
    invoke: (command, request) => {
      if (command === "schema_get") asked.push(request);
      return real.invoke(command, request);
    },
    subscribe: (command, request, onMessage) =>
      real.subscribe(command, request, onMessage),
  };
  const workbench = await testWorkbench("ready", backend);
  const edits = createEdits(workbench);
  const discovery = new Discovery(workbench);
  await discovery.resources("prod-eu");
  render(<ManifestEditor uri={URI} edits={edits} discovery={discovery} />, {
    wrapper: inWorkbench(workbench),
  });
  for (const kind of kinds) {
    act(() => {
      edits.copies.write(
        URI,
        "prod-eu",
        `apiVersion: apps/v1\nkind: ${kind}\n`,
      );
    });
  }
  return asked;
}

const prefixes = Array.from({ length: "Deployment".length }, (_, at) =>
  "Deployment".slice(0, at + 1),
);

test("a schema is asked only of a kind the cluster serves, not of each prefix of the kind being typed", async () => {
  const asked = await typing(prefixes);
  await vi.waitFor(() => {
    expect(screen.getByTestId("schema").textContent).not.toBe("none");
  });
  expect(asked).toEqual([
    { space: "prod-eu", group: "apps", version: "v1", kind: "Deployment" },
  ]);
});

test("a schema's id names its space, since two clusters serve different ones for a kind", async () => {
  await typing(["Deployment"]);
  await vi.waitFor(() => {
    expect(screen.getByTestId("schema").textContent).toBe(
      "twigo://schema/prod-eu/apps/v1/Deployment",
    );
  });
});
