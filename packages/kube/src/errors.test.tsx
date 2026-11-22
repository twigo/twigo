import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  INITIAL_OBJECT,
  IpcError,
  type Backend,
  type ViewState,
} from "@twigo/protocol";
import { testWorkbench } from "@twigo/workbench/testing";
import { RequestDetail } from "./approvals/RequestDetail";
import { FailedBar } from "./edit/answers";
import { Previews } from "./edit/previews";
import { ObjectContent, RelatedView } from "./object/ObjectContent";
import { Events } from "./object/Overview";
import { PageStates } from "./object/pageStates";
import { registerKube } from "./register";
import { ViewStatus } from "./ViewStatus";
import { ending } from "./xterm/words";

afterEach(cleanup);

const REFUSED: ViewState = {
  state: "error",
  error: {
    code: "server.invalid",
    kind: "invalidInput",
    message: "Pod web is invalid",
    server: {
      reason: "Invalid",
      causes: [
        {
          reason: "FieldValueRequired",
          field: "spec.containers[0].image",
          message: "Required value",
        },
      ],
    },
  },
};

test("an empty state says its code under the message, and Copy details copies it with the server's causes", () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<ViewStatus status={REFUSED} what="pods" />);
  expect(screen.getByText("Pod web is invalid")).toBeTruthy();
  expect(screen.getByText("server.invalid").tagName).toBe("CODE");
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  expect(writeText).toHaveBeenCalledWith(
    [
      "Code: server.invalid",
      "Message: Pod web is invalid",
      "Server reason: Invalid",
      "Causes:",
      "- spec.containers[0].image: Required value (FieldValueRequired)",
    ].join("\n"),
  );
});

test("a refusal that is no error of the server's has its code too, and a session ends with the code on its own line", () => {
  render(
    <ViewStatus
      status={{ state: "forbidden", verb: "list", resource: "pods" }}
      what="pods"
    />,
  );
  expect(screen.getByText("You may not list pods.")).toBeTruthy();
  expect(screen.getByText("server.forbidden")).toBeTruthy();

  const { title, detail } = ending({
    reason: "failed",
    error: { code: "server.forbidden", kind: "forbidden", message: "no exec" },
  });
  expect([title, detail]).toEqual(["no exec", "server.forbidden"]);
});

test("an object that cannot be read says its code under the message too", () => {
  const { error } = REFUSED;
  render(
    <ObjectContent
      pages={new PageStates()}
      uri="k8s://test"
      object="a"
      tab="yaml"
      space="dev"
      states={{} as never}
      kind="apps/deployments"
      snapshot={{ ...INITIAL_OBJECT, status: { state: "error", error } }}
      values={{} as never}
      yaml={() => <p>the live editor</p>}
      onOpen={() => undefined}
      onEvents={() => undefined}
    />,
  );
  expect(screen.getByText("Could not load the object")).toBeTruthy();
  expect(screen.getByText("Pod web is invalid")).toBeTruthy();
  expect(screen.getByText("server.invalid")).toBeTruthy();
});

test("the bar over a dry run the server refused says its code under the message", async () => {
  const refusal = new IpcError(
    "server.invalid",
    "ConfigMap settings is invalid",
    undefined,
    {
      reason: "Invalid",
      causes: [
        { reason: "FieldValueInvalid", field: "data", message: "too long" },
      ],
    },
  );
  const backend: Backend = {
    invoke: () => Promise.reject(refusal),
    subscribe: () => Promise.reject(refusal),
  };
  const failed = await new Previews(backend).run("k8s://dev/settings", {
    space: "dev",
    opened: null,
    text: "kind: ConfigMap\nmetadata:\n  name: settings\n",
  });
  if (failed?.state !== "failed") throw new Error("the preview did not fail");
  render(<FailedBar failure={failed} />);
  expect(screen.getByText("Cannot apply")).toBeTruthy();
  expect(screen.getByText("ConfigMap settings is invalid")).toBeTruthy();
  expect(screen.getByText("server.invalid").tagName).toBe("CODE");
  expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
});

test("what could not be listed for an object, and a dry run's refusal in an approval, say their codes", () => {
  const unavailable = {
    code: "server.forbidden",
    kind: "forbidden",
    message: "You may not list pods.",
  } as const;
  render(
    <RelatedView
      related={{ owners: [], owned: [], unavailable }}
      onOpen={() => undefined}
    />,
  );
  render(<Events list={{ events: [], listed: false, unavailable }} />);
  expect(screen.getAllByText("server.forbidden")).toHaveLength(2);
  cleanup();

  render(
    <RequestDetail
      detail={{
        kind: "unknown",
        reason: {
          reason: "refused",
          error: {
            code: "server.invalid",
            kind: "invalidInput",
            message: "webhook does not support dry run",
          },
        },
        body: null,
      }}
    />,
  );
  expect(screen.getByText("server.invalid").tagName).toBe("CODE");
});

test("a space whose discovery failed says why and its code on its connection", async () => {
  const workbench = await testWorkbench("discoveryFails");
  registerKube(workbench);
  await vi.waitFor(() => {
    expect(workbench.spaceStatus.get("prod-eu")).toEqual({
      tone: "error",
      label:
        "The cluster refused the connection: Connection refused (os error 61) · connect.refused",
    });
  });
});
