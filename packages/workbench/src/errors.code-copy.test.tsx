import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ErrorMessage } from "./ErrorMessage";
import { Toaster } from "@twigo/ui";
import { errorLines } from "./errors";
import { notifyError } from "./notifyError";
import { testWorkbench } from "./testing";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=code:copy");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

const REFUSED = {
  code: "connect.refused",
  message: "The server refused the connection",
} as const;

test("code:copy shows no code, only Copy details, which carries it", () => {
  const { container } = render(<ErrorMessage error={REFUSED} />);
  expect(container.textContent).not.toContain("connect.refused");
  expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
  expect(errorLines(REFUSED)).toEqual(["The server refused the connection"]);
});

test("a toast has Copy details and no code", async () => {
  render(<Toaster />);
  act(() => {
    notifyError(REFUSED, { lead: "Cannot open the pod: " });
  });
  const toast = await screen.findByRole("alert");
  expect(toast.textContent).toBe(
    "Cannot open the pod: The server refused the connectionCopy details",
  );
});

async function orphanRow() {
  const workbench = await testWorkbench("kubeconfigFailures");
  const resolved = workbench.quickAccess.resolve("ctx ");
  const found = await resolved?.provider.items("", { lookup: () => undefined });
  return found?.find(({ id }) => id === "context:orphan");
}

test("a context's problem on a picker row says its words and no code", async () => {
  const orphan = await orphanRow();
  expect(orphan?.description).toBe("orphan.internal:6443");
  expect(orphan?.state?.label).toBe(
    'no kubeconfig defines the user "orphan-admin"',
  );
});
