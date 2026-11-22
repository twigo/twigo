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

test("an error list's cluster entry reads the server's reason, and its tooltip carries the message and the code", async () => {
  await openList(createMockBackend("error"));
  expect(entry("BadRequest")?.getAttribute("title")).toBe(
    [
      "BadRequest · Kubernetes v1.33.4",
      "field label not supported: spec.containers",
      "server.invalid",
    ].join("\n"),
  );
});
