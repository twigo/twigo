import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { openList, withScreenSize } from "../../test/workbench";
import { statusWord } from "./errorWords";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const entry = (text: string) =>
  within(screen.getByRole("contentinfo")).getByText(text).closest("[title]");

test("status:family, the default, says an error by its code's family", () => {
  expect(
    [
      { code: "connect.refused" },
      { code: "connect.certificate" },
      { code: "kubeconfig.unparsable" },
      { code: "context.missing-user" },
      { code: "credentials.plugin-failed" },
      { code: "answer.undecodable" },
      { code: "server.other" },
      {
        code: "server.invalid",
        server: { reason: "BadRequest", causes: [] },
      },
    ].map((error) => statusWord(error as Parameters<typeof statusWord>[0])),
  ).toEqual([
    "Unreachable",
    "Unreachable",
    "Kubeconfig error",
    "Kubeconfig error",
    "Sign-in failed",
    "Error",
    "Server error",
    "BadRequest",
  ]);
});

test.each([
  ["error", "BadRequest", "field label not supported: spec.containers"],
  ["forbidden", "Forbidden", "You may not list pods."],
  [
    "unauthorized",
    "Unauthorized",
    "The cluster does not accept the credentials.",
  ],
] as const)(
  "a %s list's cluster entry reads %s, and its tooltip carries the message and the code",
  async (scenario, text, message) => {
    await openList(createMockBackend(scenario));
    expect(entry(text)?.getAttribute("title")).toBe(
      [
        `${text} · Kubernetes v1.33.4`,
        message,
        `server.${codeOf(scenario)}`,
      ].join("\n"),
    );
  },
);

function codeOf(scenario: string): string {
  return scenario === "error" ? "invalid" : scenario;
}
