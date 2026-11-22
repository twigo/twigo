import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ErrorMessage } from "./ErrorMessage";
import { Toaster } from "@twigo/ui";
import { errorLines } from "./errors";
import { notifyError } from "./notifyError";
import { testWorkbench } from "./testing";

afterEach(cleanup);

const REFUSED = {
  code: "connect.refused",
  message: "The server refused the connection",
} as const;

test("code:line, the default, puts the code under the message with Copy details", () => {
  const { container } = render(
    <p>
      <ErrorMessage error={REFUSED} />
    </p>,
  );
  expect(container.querySelector("p")?.firstChild?.textContent).toBe(
    "The server refused the connection",
  );
  expect(container.querySelector("code")?.textContent).toBe("connect.refused");
  expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
  expect(errorLines(REFUSED)).toEqual([
    "The server refused the connection",
    "connect.refused",
  ]);
});

test("a message said in other words keeps the error's code", () => {
  const { container } = render(
    <ErrorMessage error={REFUSED} message="Nobody answers" />,
  );
  expect(container.textContent).toContain("Nobody answers");
  expect(container.querySelector("code")?.textContent).toBe("connect.refused");
});

test("a toast says its code under its message, led by what it belongs to", async () => {
  render(<Toaster />);
  act(() => {
    notifyError(REFUSED, { lead: "Cannot open the pod: " });
  });
  const toast = await screen.findByRole("alert");
  expect(toast.textContent).toBe(
    "Cannot open the pod: The server refused the connectionconnect.refusedCopy details",
  );
  expect(toast.querySelector("code")?.textContent).toBe("connect.refused");
});

async function orphanRow() {
  const workbench = await testWorkbench("kubeconfigFailures");
  const resolved = workbench.quickAccess.resolve("ctx ");
  const found = await resolved?.provider.items("", { lookup: () => undefined });
  return found?.find(({ id }) => id === "context:orphan");
}

test("a context's problem on a picker row says its code after the host", async () => {
  const orphan = await orphanRow();
  expect(orphan?.description).toBe(
    "orphan.internal:6443 · context.missing-user",
  );
  expect(orphan?.state?.label).toBe(
    'no kubeconfig defines the user "orphan-admin"',
  );
});
