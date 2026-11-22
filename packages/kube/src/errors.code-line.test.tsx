import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { INITIAL_OBJECT, type ViewState } from "@twigo/protocol";
import { ObjectContent } from "./object/ObjectContent";
import { PageStates } from "./object/pageStates";
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

test("code:line, the default: an empty state says its code under the message, and Copy details copies it with the server's causes", () => {
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

test("code:line: a refusal that is no error of the server's has its code too, and a session ends with the code on its own line", () => {
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

test("code:line: an object that cannot be read says its code under the message too", () => {
  const { error } = REFUSED as Extract<ViewState, { state: "error" }>;
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
