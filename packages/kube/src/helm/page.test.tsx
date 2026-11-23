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
import { diffUri, helmUri } from "../uri";
import { problemWords } from "./status";

vi.mock("./MaskedText", () => ({
  default: ({ text }: { text: string }) => (
    <div data-testid="masked-text" data-text={text} />
  ),
}));

const screenSize = withScreenSize(1600);

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
  fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
  await settle(4);
}

test("the release's full page leads the header's second line with the space, as an object's does, from 900 px of its own width", async () => {
  await open(release("alpha"));
  const editor = page("alpha");
  const crumbs = () =>
    within(editor)
      .queryAllByTitle("prod-eu")
      .filter((each) => !each.closest("[inert]"));
  expect(crumbs()).toHaveLength(1);
  screenSize.resize(editor, 883);
  expect(crumbs()).toHaveLength(0);
  screenSize.resize(editor, 900);
  expect(crumbs()).toHaveLength(1);
});

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

const line = (revision: number, status: string) => ({
  revision,
  status,
  chart: "demo-0.1.0",
  appVersion: "1.0.0",
  description: { text: "", hidden: false },
  rollbackOf: null,
  problem: null,
  updated: "2026-11-22T20:14:04.237774Z",
});

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
  expect(
    within(page("epsilon")).getByRole("button", { name: "Reveal the notes" }),
  ).toBeTruthy();
  expect(page("epsilon").textContent).not.toContain("epsilon-password-r2");
});

test("the Notes section holds the notes as its text, with no field that says Notes again, and its Reveal is the eye button of a Secret's key", async () => {
  await open(release("epsilon"));
  const section = document.querySelector<HTMLElement>(
    '[data-section="helm.notes"]',
  );
  if (!section) throw new Error("no Notes section");
  fireEvent.click(within(section).getByRole("button", { name: /^Notes/ }));
  await settle(3);
  expect(section.querySelector("dl, dt")).toBeNull();
  expect(section.textContent).toContain("Log in as admin");
  const reveal = within(section).getByRole("button", {
    name: "Reveal the notes",
  });
  expect(reveal.textContent).toBe("");
  expect(reveal.className).toContain("size-6");
});

function withUnreadDocument(sent: unknown[] = []): Backend {
  const mock = createMockBackend("ready");
  return {
    invoke: (command, request) => {
      if (command === "command_plan") sent.push(request);
      return mock.invoke(command, request);
    },
    subscribe: ((
      command: string,
      request: never,
      onMessage: (message: unknown) => void,
    ) =>
      mock.subscribe(
        command as never,
        request,
        command === "helm_release_open"
          ? (batch: ReleaseBatch) => {
              const { manifest } = batch;
              if (!manifest) {
                onMessage(batch);
                return;
              }
              const body = manifest.text.replace(/\n+$/, "");
              onMessage({
                ...batch,
                manifest: {
                  ...manifest,
                  text: `${body}\n---\n# Source: demo/templates/broken.yaml\n# Twigo could not read this document (line 3, column 7).\n`,
                  unread: [
                    {
                      document: 4,
                      line: body.split("\n").length + 2,
                      source: "demo/templates/broken.yaml",
                    },
                  ],
                },
              });
            }
          : onMessage,
      )) as Backend["subscribe"],
  };
}

test("the Values bar is the YAML view's: what is hidden at its left, and Reveal All and Hide All as toolbar buttons at its right, each only where it has something to do", async () => {
  await open(release("alpha"));
  fireEvent.click(screen.getByRole("tab", { name: "Values" }));
  await settle(6);
  const scope = page("alpha");
  const bar = () => within(scope).getAllByRole("toolbar").pop();
  expect(scope.textContent).toMatch(/\d+ values? hidden/);
  expect(within(scope).queryByRole("button", { name: "Hide All" })).toBeNull();
  fireEvent.click(within(scope).getByRole("button", { name: "Reveal All" }));
  await settle(3);
  fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
  await settle(4);
  expect(scope.textContent).toContain("No value is hidden");
  expect(
    within(scope).queryByRole("button", { name: "Reveal All" }),
  ).toBeNull();
  expect(bar()?.textContent).toBe("Hide All");
  expect(bar()?.parentElement?.className).toContain("pr-2 pl-3");
});

test("the Manifest's bar counts every hidden place, an unread document too, and Reveal All asks once for the whole manifest, which is the view's text until Hide All", async () => {
  const sent: unknown[] = [];
  const workbench = await mountKube(withUnreadDocument(sent));
  act(() => {
    workbench.editors.open(release("alpha"));
  });
  await settle(8);
  fireEvent.click(screen.getByRole("tab", { name: "Manifest" }));
  await settle(6);
  const text = () => screen.getByTestId("masked-text").dataset.text ?? "";
  const masked = text();
  expect(page("alpha").textContent).toContain("4 values hidden");
  fireEvent.click(screen.getByRole("button", { name: "Reveal All" }));
  await settle(3);
  expect(screen.getByRole("dialog").textContent).toContain(
    "Reveal all of the manifest's Secrets of release alpha (revision 2) in payments from prod-eu?",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
  await settle(6);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sent).toEqual([
    {
      action: "revealHelm",
      release: expect.any(Number) as number,
      revision: 2,
      part: { kind: "manifest" },
    },
  ]);
  expect(text()).toContain('password: "user-password-r2"');
  expect(text()).not.toContain("bytes>");
  expect(page("alpha").textContent).toContain("No value is hidden");
  expect(
    within(page("alpha")).queryByRole("button", { name: "Reveal All" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hide All" }));
  await settle(3);
  expect(text()).toBe(masked);
  expect(page("alpha").textContent).toContain("4 values hidden");
});

test("a release whose revision cannot be read is a stopped page: the words the list gives for its code, the icon in the error tone, and the block's own padding", async () => {
  await open(release("trunc", "auth"));
  const title = within(page("trunc")).getByText("This revision cannot be read");
  const state = title.parentElement;
  expect(state?.textContent).toContain(problemWords("helm.truncated").why);
  expect(state?.className).toContain("text-error");
  expect(state?.className).toContain("py-16");
  expect(state?.querySelector("svg")?.getAttribute("class")).toContain(
    "opacity-70",
  );
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

test("Copy helm Command is enabled where a command prints the view, and not on the chart's defaults", async () => {
  const workbench = await open(release("alpha"));
  const tab = screen.getByRole("tab", { name: "Overview" });
  const enabled = () =>
    workbench.commands.enabled(
      "helm.release.copyCommand",
      workbench.keys.lookup(tab),
    );
  const selected = (name: string) =>
    vi.waitFor(() => {
      expect(
        screen.getByRole("tab", { name }).getAttribute("aria-selected"),
      ).toBe("true");
    });
  expect(enabled()).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Values" }));
  await vi.waitFor(() => {
    expect(screen.getByRole("tab", { name: "Chart defaults" })).toBeTruthy();
    expect(screen.getByTestId("masked-text")).toBeTruthy();
  });
  expect(enabled()).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Chart defaults" }));
  await selected("Chart defaults");
  expect(enabled()).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Your values" }));
  await selected("Your values");
  expect(enabled()).toBe(true);
});

test("the header's Compare with Previous compares with the revision before that Helm keeps, and is not offered where it keeps none", async () => {
  const { backend, send } = core();
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(release("alpha"));
  });
  await settle(8);
  const lookup = () =>
    workbench.keys.lookup(screen.getByRole("tab", { name: "Overview" }));
  const command = "helm.release.compareWithPrevious";
  expect(workbench.commands.enabled(command, lookup())).toBe(true);
  act(() => {
    send({ seq: 50, previous: null });
  });
  await settle(3);
  expect(workbench.commands.enabled(command, lookup())).toBe(false);

  act(() => {
    send({ seq: 51, revision: 3, latest: 3, previous: 1 });
  });
  await settle(3);
  expect(workbench.commands.enabled(command, lookup())).toBe(true);
  const opened = vi.spyOn(workbench.editors, "open");
  await act(() => workbench.commands.execute(command, lookup()));
  expect(opened).toHaveBeenLastCalledWith(
    diffUri({
      kind: "release",
      release: { space: "prod-eu", namespace: "payments", name: "alpha" },
      from: 1,
      to: 3,
      part: "values",
    }),
  );
});

test("History pulses the dot of a revision that waits for Helm to end, uninstalling as the list does", async () => {
  const { backend, send } = core();
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(release("alpha"));
  });
  await settle(8);
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  await settle(6);
  act(() => {
    send({
      seq: 70,
      history: [
        line(3, "uninstalling"),
        line(2, "pending-upgrade"),
        line(1, "failed"),
      ],
    });
  });
  await settle(4);
  const pulses = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => [
      row.querySelector('[data-column="revision"]')?.textContent,
      row.querySelector(".animate-pulse") !== null,
    ]);
  expect(pulses).toEqual([
    ["3", true],
    ["2", true],
    ["1", false],
  ]);
});

async function openHistory(backend: Backend) {
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(release("alpha"));
  });
  await settle(8);
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  await settle(6);
  return workbench;
}

const revisionRow = (revision: number) => {
  const found = screen
    .getAllByRole("row")
    .slice(1)
    .find((row) => cellOf(row, "revision") === String(revision));
  if (!found) throw new Error(`no row of revision ${String(revision)}`);
  return found;
};

const markedRevisions = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .filter(
      (row) =>
        within(row).queryByRole("checkbox", { name: "Unmark row" }) !== null,
    )
    .map((row) => Number(cellOf(row, "revision")));

async function mark(revision: number) {
  fireEvent.click(
    within(revisionRow(revision)).getByRole("checkbox", { name: "Mark row" }),
  );
  await settle(2);
}

async function menuOf(revision: number) {
  fireEvent.contextMenu(revisionRow(revision));
  await settle(2);
  const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await settle(2);
  return items;
}

const truncated = {
  code: "helm.truncated",
  kind: "invalidInput",
  message: "",
} as const;
const forbidden = {
  code: "server.forbidden",
  kind: "forbidden",
  message: "",
} as const;

test("History draws a line as the list draws a row: the error band where its revision failed or cannot be read, and the label's status with a mark where the request for it failed", async () => {
  const { backend, send } = core();
  await openHistory(backend);
  act(() => {
    send({
      seq: 90,
      history: [
        { ...line(3, "unreadable"), problem: truncated },
        { ...line(2, "deployed"), problem: forbidden },
        { ...line(1, "failed"), problem: forbidden },
      ],
    });
  });
  await settle(4);
  expect(cellOf(revisionRow(3), "status")).toBe("Truncated");
  expect(revisionRow(3).dataset.tone).toBe("error");
  expect(within(revisionRow(3)).queryByRole("img")).toBeNull();
  for (const [revision, status, tone] of [
    [2, "deployed", undefined],
    [1, "failed", "error"],
  ] as const) {
    const row = revisionRow(revision);
    expect(cellOf(row, "status")).toBe(status);
    expect(row.dataset.tone).toBe(tone);
    const mark = within(row).getByRole("img", {
      name: `Could not fetch revision ${String(revision)}`,
    });
    expect(mark.parentElement?.title).toContain(
      `could not fetch revision ${String(revision)} (server.forbidden)`,
    );
  }
});

test("the revisions marked in History stay marked when the release moves to a new revision", async () => {
  const { backend, send } = core();
  await openHistory(backend);
  await mark(1);
  await mark(2);
  expect(markedRevisions()).toEqual([2, 1]);

  act(() => {
    send({
      seq: 80,
      revision: 3,
      latest: 3,
      history: [
        line(3, "deployed"),
        line(2, "superseded"),
        line(1, "superseded"),
      ],
    });
  });
  await settle(4);
  expect(markedRevisions()).toEqual([2, 1]);
});

test("the revisions marked in History are gone when the release is uninstalled and installed again", async () => {
  const { backend, send } = core();
  await openHistory(backend);
  await mark(1);
  expect(markedRevisions()).toEqual([1]);

  act(() => {
    send({ seq: 81, ...NOTHING_LEFT });
  });
  await settle(3);
  expect(page("alpha").textContent).toContain("This release is gone");

  act(() => {
    send({ seq: 82, history: [line(2, "deployed"), line(1, "superseded")] });
  });
  await settle(3);
  expect(markedRevisions()).toEqual([]);
});

test("two marked revisions bring the marked bar, as the pods list's: the count, the three comparisons and Clear Marks, which Escape does too", async () => {
  const { backend } = core();
  const workbench = await openHistory(backend);
  const bar = () =>
    screen.queryByText("marked")?.closest('[role="toolbar"]') ?? null;
  expect(bar()).toBeNull();
  await mark(2);
  expect(bar()?.textContent).toBe("1 markedClear Marks⎋");
  await mark(1);
  expect(bar()?.textContent).toMatch(
    /^2 markedCompare ValuesCompare DefaultsCompare ManifestsClear Marks⎋$/,
  );

  const opened = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", {
      name: /^Compare Manifests/,
    }),
  );
  await settle(2);
  expect(opened).toHaveBeenLastCalledWith(
    diffUri({
      kind: "release",
      release: { space: "prod-eu", namespace: "payments", name: "alpha" },
      from: 1,
      to: 2,
      part: "manifest",
    }),
  );

  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", { name: /^Clear Marks/ }),
  );
  await settle(2);
  expect(markedRevisions()).toEqual([]);
  expect(bar()).toBeNull();

  await mark(1);
  fireEvent.keyDown(screen.getByRole("grid", { name: "Revisions" }), {
    key: "Escape",
    code: "Escape",
  });
  await settle(2);
  expect(markedRevisions()).toEqual([]);
});

test("a marked revision that Helm prunes is no longer marked, so two marked rows on screen offer their comparisons and one does not", async () => {
  const { backend, send } = core();
  await openHistory(backend);
  await mark(1);
  await mark(2);

  act(() => {
    send({
      seq: 83,
      revision: 3,
      latest: 3,
      history: [line(3, "deployed"), line(2, "superseded")],
    });
  });
  await settle(4);
  expect(markedRevisions()).toEqual([2]);
  expect(await menuOf(2)).not.toContain("Compare Values");

  await mark(3);
  expect(markedRevisions()).toEqual([3, 2]);
  expect(await menuOf(3)).toContain("Compare Values");
});

test("Escape clears the Overview's filter and leaves the marks History holds, which Escape clears only while History draws one", async () => {
  const { backend, send } = core();
  const workbench = await openHistory(backend);
  await mark(1);
  const grid = () => screen.getByRole("grid", { name: "Revisions" });
  const clearable = () =>
    workbench.commands.enabled(
      "helm.revisions.clearMarks",
      workbench.keys.lookup(grid()),
    );
  expect(clearable()).toBe(true);

  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  await settle(4);
  const overview = screen.getByRole("tab", { name: "Overview" });
  await filter("alpha", "demo");
  const field = screen.getByRole("textbox", { name: "Filter this page" });
  fireEvent.keyDown(field, { key: "Enter" });
  await settle(2);
  fireEvent.keyDown(overview, { code: "Escape", key: "Escape" });
  await settle(2);
  expect(field.getAttribute("value")).toBe("");

  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  await settle(6);
  expect(markedRevisions()).toEqual([1]);

  act(() => {
    send({ seq: 85, history: [line(2, "deployed")] });
  });
  await settle(4);
  expect(markedRevisions()).toEqual([]);
  expect(clearable()).toBe(false);
});

test("History's Compare with Previous compares with the revision before that Helm keeps, and is not offered on the oldest one it keeps", async () => {
  const { backend, send } = core();
  const workbench = await openHistory(backend);
  act(() => {
    send({
      seq: 84,
      revision: 3,
      latest: 3,
      history: [line(3, "deployed"), line(1, "superseded")],
    });
  });
  await settle(4);
  expect(await menuOf(1)).toContain("Compare with Current");
  expect(await menuOf(1)).not.toContain("Compare with Previous");

  const opened = vi.spyOn(workbench.editors, "open");
  fireEvent.contextMenu(revisionRow(3));
  await settle(2);
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Compare with Previous" }),
  );
  await settle(2);
  expect(opened).toHaveBeenLastCalledWith(
    diffUri({
      kind: "release",
      release: { space: "prod-eu", namespace: "payments", name: "alpha" },
      from: 1,
      to: 3,
      part: "values",
    }),
  );
});
