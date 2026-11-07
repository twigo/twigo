import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { mountKube, settle, withScreenSize } from "../../test/workbench";
import { objectUri } from "../uri";

withScreenSize(1400);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The mock backend, with every value the webview stores noted. */
function noting(): { backend: Backend; stored: string[] } {
  const mock = createMockBackend("ready");
  const stored: string[] = [];
  return {
    stored,
    backend: {
      invoke(command, request) {
        if (command === "state_set") stored.push(JSON.stringify(request));
        return mock.invoke(command, request);
      },
      subscribe: (command, request, onMessage) =>
        mock.subscribe(command, request, onMessage),
    },
  };
}

test("a Reveal in guarded asks first, and its value is never stored and leaves with Hide", async () => {
  const { backend, stored } = noting();
  const workbench = await mountKube(backend);
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(2);
  act(() => {
    workbench.editors.open(
      objectUri({
        space: "staging",
        gvr: { group: "", version: "v1", resource: "secrets" },
        namespace: "overview",
        name: "credentials",
      }),
    );
  });
  await settle();
  expect(document.body.textContent).not.toContain("test-password");

  fireEvent.click(screen.getByRole("button", { name: "Reveal password" }));
  await settle(2);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain(
    "Reveal password of secret credentials in overview from staging?",
  );
  expect(document.body.textContent).not.toContain("test-password");
  fireEvent.click(screen.getByRole("button", { name: "Reveal value" }));
  await settle(2);
  expect(document.body.textContent).toContain("test-password");

  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  await settle(4);
  expect(document.body.textContent).not.toContain("test-password");
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.join("\n")).not.toContain("test-password");
});
