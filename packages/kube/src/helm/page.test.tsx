import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, ReleaseBatch } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { ENDS_MS } from "../../../protocol/src/mock/edits";
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

async function open(uri: string, scenario: MockScenario = "ready") {
  const workbench = await mountKube(createMockBackend(scenario));
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(8);
  return workbench;
}

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

test("a release in a namespace whose Secrets the person may not list says so, naming them, where one they may list shows whole", async () => {
  const workbench = await open(release("alpha"), "rbacNamespaces");
  expect(page("alpha").textContent).toContain(
    "These credentials may not list Secrets in payments, which Helm keeps its releases in.",
  );
  expect(page("alpha").textContent).not.toContain("This release is gone");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

  act(() => {
    workbench.editors.open(release("alpha", "default"));
  });
  await settle(8);
  expect(
    screen.getAllByRole("region", { name: "Helm release alpha" }),
  ).toHaveLength(1);
  expect(page("alpha").textContent).toContain("Chart version");
  expect(page("alpha").textContent).not.toContain("Access denied");
});

test("a release that is still connecting shows a placeholder, neither gone nor refused", async () => {
  await open(release("alpha"), "connecting");
  expect(page("alpha").textContent).not.toContain("This release is gone");
  expect(page("alpha").textContent).not.toContain("Access denied");
  expect(page("alpha").textContent).not.toContain("Chart version");
});

test("a release editor that Twigo stopped says so with Report… and Reopen, which opens it anew", async () => {
  const mock = createMockBackend("objectPanicked");
  let opened = 0;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "helm_release_open") opened++;
      return mock.subscribe(command, request, onMessage);
    },
  };
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(release("alpha"));
  });
  await settle(8);
  expect(page("alpha").textContent).toContain("Chart version");
  expect(screen.queryByText("Twigo hit an internal error")).toBeNull();

  await settle(ENDS_MS / 50);
  expect(screen.getByText("Twigo hit an internal error")).toBeTruthy();
  expect(page("alpha").textContent).toContain("This view stopped.");
  expect(screen.getByRole("button", { name: "Report…" })).toBeTruthy();

  const before = opened;
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await settle(8);
  expect(opened).toBeGreaterThan(before);
  expect(page("alpha").textContent).toContain("Chart version");
});

const titles = (name: string) =>
  [...page(name).querySelectorAll("button[aria-expanded]")].map(
    (button) => button.textContent,
  );

test("under tabs:split the Overview leaves out what Hooks and Objects hold, which each draws apart", async () => {
  window.history.replaceState({}, "", "/?variant=tabs:split");
  await open(release("alpha"));
  const named = (...words: string[]) =>
    titles("alpha").filter((title) =>
      words.some((word) => title.startsWith(word)),
    );
  expect(named("Chart", "Metadata", "Hooks", "Objects")).toEqual([
    "Chartdemo",
    "Metadata",
  ]);
  fireEvent.click(screen.getByRole("tab", { name: "Hooks" }));
  await settle(4);
  expect(named("Chart", "Metadata", "Hooks", "Objects")).toEqual([
    "Hooks2 hooks",
  ]);
  fireEvent.click(screen.getByRole("tab", { name: "Objects" }));
  await settle(4);
  expect(named("Chart", "Metadata", "Hooks", "Objects")).toEqual([
    "Objects4 objects",
  ]);
});

async function filter(name: string, text: string) {
  fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), {
    code: "Slash",
    key: "/",
  });
  await settle(3);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter this page" }), {
    target: { value: text },
  });
  await settle(3);
  return page(name).textContent;
}

test("the page's filter finds what Helm wrote of a failed revision, and keeps the finding that holds it", async () => {
  await open(release("epsilon"));
  const found = await filter("epsilon", "cannot patch");
  expect(found).toContain("1 match in 1 section");
  expect(found).toContain('Upgrade "epsilon" failed');
  expect(found).not.toContain("Nothing here matches");
});
