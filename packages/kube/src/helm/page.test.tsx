import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, ReleaseBatch } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";
import { DWELL_MS } from "../Details";
import { helmUri } from "../uri";

withScreenSize(1600);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

const release = (name: string, namespace = "payments") =>
  helmUri({ space: "prod-eu", namespace, name });

const page = (name: string) =>
  screen.getByRole("region", { name: `Helm release ${name}` });

const cellOf = (row: HTMLElement, column: string) =>
  row.querySelector(`[data-column="${column}"]`)?.textContent ?? "";

const aside = () =>
  screen.getByRole("complementary", { name: "Helm release details" });

async function inspect(name: string, namespace: string) {
  const row = screen
    .getAllByRole("row")
    .slice(1)
    .find(
      (each) =>
        cellOf(each, "Name") === name &&
        cellOf(each, "Namespace") === namespace,
    );
  if (!row) throw new Error(`no row ${namespace}/${name}`);
  fireEvent.click(row);
  await act(() => vi.advanceTimersByTimeAsync(DWELL_MS + 50));
  await settle(8);
}

async function revealNotes(scope: HTMLElement) {
  fireEvent.click(within(scope).getByRole("button", { name: /^Notes/ }));
  await settle(3);
  fireEvent.click(
    within(scope).getByRole("button", { name: "Reveal the notes" }),
  );
  await settle(3);
  fireEvent.click(screen.getByRole("button", { name: "Reveal value" }));
  await settle(4);
}

test("a value revealed in the inspector is of the release it showed: another release of the same revision, and the same release shown again, read it masked", async () => {
  await openList(createMockBackend("ready"), "helm-list://prod-eu");
  await inspect("epsilon", "payments");
  await revealNotes(aside());
  expect(aside().textContent).toContain("password epsilon-password-r2");

  await inspect("alpha", "payments");
  expect(page("alpha")).toBeTruthy();
  expect(aside().textContent).not.toContain("epsilon-password-r2");

  await inspect("epsilon", "payments");
  expect(page("epsilon")).toBeTruthy();
  expect(aside().textContent).not.toContain("epsilon-password-r2");
});

/** The mock, but an open release answers as the core does for the batches `send` is given. */
function core(): {
  backend: Backend;
  send: (batch: Partial<ReleaseBatch>) => void;
} {
  const mock = createMockBackend("ready");
  const seen: ReleaseBatch[] = [];
  let send: ((batch: ReleaseBatch) => void) | undefined;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: ((
      command: string,
      request: never,
      onMessage: (message: unknown) => void,
    ) => {
      if (command !== "helm_release_open") {
        return mock.subscribe(command as never, request, onMessage);
      }
      send = onMessage;
      return mock.subscribe(
        command as never,
        request,
        (batch: ReleaseBatch) => {
          seen.push(batch);
          onMessage(batch);
        },
      );
    }) as Backend["subscribe"],
  };
  return {
    backend,
    send: (batch) => {
      const [base] = seen;
      if (!base || !send) throw new Error("no release is open");
      send({ ...base, ...batch });
    },
  };
}

const NOTHING_LEFT = {
  exists: false,
  revision: null,
  latest: null,
  overview: null,
  notes: null,
  description: null,
  values: null,
  manifest: null,
  history: null,
} as const;

test("what was revealed does not come back when the release is uninstalled and installed again up to the same revision", async () => {
  const { backend, send } = core();
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(release("epsilon"));
  });
  await settle(8);
  await revealNotes(page("epsilon"));
  expect(page("epsilon").textContent).toContain("password epsilon-password-r2");

  act(() => {
    send({ seq: 50, ...NOTHING_LEFT });
  });
  await settle(3);
  expect(page("epsilon").textContent).toContain("This release is gone");

  act(() => {
    send({ seq: 51 });
  });
  await settle(3);
  expect(page("epsilon").textContent).toContain("Reveal the notes");
  expect(page("epsilon").textContent).not.toContain("epsilon-password-r2");
});
