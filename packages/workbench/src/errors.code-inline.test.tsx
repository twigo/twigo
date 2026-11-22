import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ErrorMessage } from "./ErrorMessage";
import { Toaster } from "@twigo/ui";
import { errorLines } from "./errors";
import { notifyError } from "./notifyError";
import { testWorkbench } from "./testing";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=code:inline");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

const REFUSED = {
  code: "connect.refused",
  message: "The server refused the connection",
} as const;

test("code:inline puts the code before the message and has no Copy details", () => {
  const { container } = render(<ErrorMessage error={REFUSED} />);
  expect(container.textContent).toBe(
    "connect.refused: The server refused the connection",
  );
  expect(container.querySelector("code")?.textContent).toBe("connect.refused");
  expect(screen.queryByRole("button")).toBeNull();
  expect(errorLines(REFUSED)).toEqual([
    "connect.refused: The server refused the connection",
  ]);
});

test("a toast leads its message with the code", async () => {
  render(<Toaster />);
  act(() => {
    notifyError(REFUSED, { lead: "Cannot open the pod: " });
  });
  const toast = await screen.findByRole("alert");
  expect(toast.textContent).toBe(
    "Cannot open the pod: connect.refused: The server refused the connection",
  );
});

async function orphanRow() {
  const workbench = await testWorkbench("kubeconfigFailures");
  const resolved = workbench.quickAccess.resolve("ctx ");
  const found = await resolved?.provider.items("", { lookup: () => undefined });
  return found?.find(({ id }) => id === "context:orphan");
}

test("a context's problem on a picker row leads its words with the code", async () => {
  const orphan = await orphanRow();
  expect(orphan?.description).toBe("orphan.internal:6443");
  expect(orphan?.state?.label).toBe(
    'context.missing-user: no kubeconfig defines the user "orphan-admin"',
  );
});
