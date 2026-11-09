import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { Discovery } from "../discovery";
import { ManifestEditor } from "./ManifestEditor";
import { createEdits } from "./services";

vi.mock("./YamlEditor", () => ({
  default: ({
    schema,
    onChange,
  }: {
    schema?: { source: string };
    onChange?: (text: string) => void;
  }) => (
    <>
      <p data-testid="schema">{schema?.source ?? "none"}</p>
      <button
        type="button"
        onClick={() => {
          onChange?.("kind: ConfigMap\n");
        }}
      >
        type
      </button>
    </>
  ),
}));

afterEach(cleanup);

const URI = "untitled://prod-eu/manifest-1";

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

test("a target whose kinds are not known says there is no schema, and a shown one does not", async () => {
  const workbench = await testWorkbench("ready");
  const edits = createEdits(workbench);
  const discovery = new Discovery(workbench);
  await discovery.resources("prod-eu");
  edits.copies.write(URI, "prod-eu", "kind: ConfigMap\n");
  edits.copies.retarget(URI, "dev");
  render(<ManifestEditor uri={URI} edits={edits} discovery={discovery} />, {
    wrapper: inWorkbench(workbench),
  });
  expect(screen.getByText(/No schema for completion/)).toBeTruthy();
  cleanup();

  act(() => {
    edits.copies.retarget(URI, "prod-eu");
  });
  render(<ManifestEditor uri={URI} edits={edits} discovery={discovery} />, {
    wrapper: inWorkbench(workbench),
  });
  expect(screen.queryByText(/No schema for completion/)).toBeNull();
});

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

test("what is typed belongs to the space the URI names, whichever space is shown", async () => {
  const workbench = await testWorkbench("ready");
  const edits = createEdits(workbench);
  const discovery = new Discovery(workbench);
  workbench.spaces.select("prod-eu");
  const staging = "untitled://staging/manifest-1";
  render(<ManifestEditor uri={staging} edits={edits} discovery={discovery} />, {
    wrapper: inWorkbench(workbench),
  });
  fireEvent.click(screen.getByRole("button", { name: "type" }));
  expect(edits.copies.get(staging)).toMatchObject({
    space: "staging",
    text: "kind: ConfigMap\n",
  });
  expect(edits.copies.get("untitled://prod-eu/manifest-1")).toBeUndefined();
});

test("a URI that names no space is no manifest", async () => {
  const workbench = await testWorkbench("ready");
  render(
    <ManifestEditor
      uri="untitled://manifest-1"
      edits={createEdits(workbench)}
      discovery={new Discovery(workbench)}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(screen.getByText("Not a manifest")).toBeTruthy();
});
