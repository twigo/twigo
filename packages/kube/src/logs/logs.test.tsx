import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { INITIAL_LOGS, type LogEntry, type LogsSession } from "@twigo/protocol";
import { WorkbenchView } from "@twigo/workbench";
import { inWorkbench, tabsIn, testWorkbench } from "@twigo/workbench/testing";
import { registerKube } from "../register";
import { registerLogs } from "./register";
import { LogsToolbar } from "./LogsToolbar";
import { LogsTabs } from "./state";
import { logsUri, parseLogsUri } from "../uri";
import {
  anchoredMatch,
  currentMatch,
  lineItem,
  logsKind,
  podTag,
  standingMatch,
} from "./entries";

afterEach(cleanup);

const DEPLOYMENT = {
  space: "prod-eu",
  gvr: { group: "apps", version: "v1", resource: "deployments" },
  namespace: "auth",
  name: "auth-api",
};

const POD = {
  space: "prod-eu",
  gvr: { group: "", version: "v1", resource: "pods" },
  namespace: "auth",
  name: "auth-api-7f9c8d6b5-h8lbx",
};

async function mounted() {
  const workbench = await testWorkbench();
  registerKube(workbench);
  render(<WorkbenchView workbench={workbench} />);
  return workbench;
}

test("pods and workloads have logs, other resources none", () => {
  expect(logsKind(POD.gvr)).toBe("pod");
  expect(logsKind(DEPLOYMENT.gvr)).toBe("deployment");
  expect(
    logsKind({ group: "batch", version: "v1", resource: "cronjobs" }),
  ).toBe("cronjob");
  expect(logsKind({ group: "", version: "v1", resource: "configmaps" })).toBe(
    undefined,
  );
});

test("a line's tag is its pod's last part", () => {
  expect(podTag("auth-api-7f9c8d6b5-h8lbx")).toBe("h8lbx");
  expect(podTag("ledger-0")).toBe("0");
});

test("the current match counts back from the newest, and its mark from its entry's last", () => {
  const matches = { count: 12, entries: [30, 70, 70, 90] };
  expect(currentMatch(matches, 0)).toEqual({ id: 90, fromEnd: 0, number: 12 });
  expect(currentMatch(matches, 1)).toEqual({ id: 70, fromEnd: 0, number: 11 });
  expect(currentMatch(matches, 2)).toEqual({ id: 70, fromEnd: 1, number: 10 });
  expect(currentMatch(matches, 4)).toBeUndefined();
  expect(currentMatch(undefined, 0)).toBeUndefined();
});

test("an anchored match keeps its entry and mark as matches come after it and drop before it", () => {
  expect(anchoredMatch({ count: 4, entries: [30, 70, 70, 90] }, 70, 1)).toBe(2);
  const after = { count: 5, entries: [70, 70, 95, 96, 97] };
  expect(anchoredMatch(after, 70, 1)).toBe(4);
  expect(anchoredMatch(after, 70, 0)).toBe(3);
  expect(anchoredMatch(after, 30, 0)).toBeUndefined();
});

test("a stepped match stands while the matches list it, and beyond the last they list while they list only those", () => {
  const capped = { count: 12, entries: [30, 70, 90] };
  expect(standingMatch(capped, { id: 70, fromEnd: 0 })).toEqual({
    id: 70,
    fromEnd: 0,
    number: 11,
    back: 1,
  });
  expect(standingMatch(capped, { id: 20, fromEnd: 0 })).toEqual({
    id: 20,
    fromEnd: 0,
    number: 9,
    back: 3,
    atMost: true,
  });
  const every = { count: 3, entries: [30, 70, 90] };
  expect(standingMatch(every, { id: 20, fromEnd: 0 })).toEqual({
    id: 90,
    fromEnd: 0,
    number: 3,
    back: 0,
  });
  expect(standingMatch(every, undefined)?.id).toBe(90);
});

test("entries become lines and markers: a level's tone, the current mark, a crash and a rollout", () => {
  const options = {
    tag: podTag,
    accent: (pod: string) => pod === "auth-api-63n3i1-fgcpn",
    current: 1,
    now: Date.parse("2026-11-03T10:41:00Z"),
  };
  const line: LogEntry = {
    type: "line",
    id: 4,
    pod: "auth-api-63n3i1-fgcpn",
    container: "api",
    time: "2026-11-03T10:40:59.123456789Z",
    level: "error",
    text: "refused, refused",
    styles: [],
    marks: [
      { start: 0, end: 7 },
      { start: 9, end: 16 },
    ],
  };
  expect(lineItem(line, options)).toMatchObject({
    kind: "line",
    key: "4",
    tag: "fgcpn",
    tagAccent: true,
    tone: "error",
    marks: [
      { start: 0, end: 7, current: true },
      { start: 9, end: 16, current: false },
    ],
  });
  const ended: LogEntry = {
    type: "ended",
    id: 5,
    pod: "auth-api-7f9c8d6b5-h8lbx",
    container: "api",
    time: "2026-11-03T10:40:58Z",
    exitCode: 1,
    reason: "Error",
    restarting: "2026-11-03T10:41:40Z",
  };
  expect(lineItem(ended, options)).toMatchObject({
    kind: "marker",
    tone: "error",
    tag: "h8lbx",
    text: "Container api exited with code 1 (Error) · restarting in 40s",
  });
  expect(
    lineItem({ ...ended, restarting: "2026-11-03T10:40:59Z" }, options),
  ).toMatchObject({ text: "Container api exited with code 1 (Error)" });
  const joined: LogEntry = {
    type: "joined",
    id: 6,
    pod: "auth-api-63n3i1-fgcpn",
    time: "2026-11-03T10:41:00Z",
    owner: {
      group: "apps",
      version: "v1",
      kind: "ReplicaSet",
      namespace: "auth",
      name: "auth-api-63n3i1",
    },
  };
  expect(lineItem(joined, options)).toMatchObject({
    kind: "marker",
    text: "Pod auth-api-63n3i1-fgcpn joined from ReplicaSet auth-api-63n3i1",
  });
});

function spied(workbench: Awaited<ReturnType<typeof testWorkbench>>) {
  const opened = vi.spyOn(workbench.backend, "subscribe");
  const invoked = vi.spyOn(workbench.backend, "invoke");
  return {
    sources: () =>
      opened.mock.calls
        .filter(([command]) => command === "logs_open")
        .map(([, request]) => (request as { source: unknown }).source),
    sets: () =>
      invoked.mock.calls
        .filter(([command]) => command === "logs_set_source")
        .map(([, request]) => (request as { source: unknown }).source),
  };
}

test("a finding's Previous logs opens its pod's tab on that container's previous instance from its start, and Logs switches it back", async () => {
  const workbench = await mounted();
  const backend = spied(workbench);
  const open = (previous: boolean) =>
    act(() =>
      workbench.commands.execute("k8s.logs.open", workbench.keys.lookup(null), {
        ...POD,
        container: "api",
        previous,
      }),
    );
  await open(true);
  const uri = logsUri(POD);
  expect(tabsIn("panel")).toEqual([uri]);
  expect(workbench.editors.title(uri)).toBe(
    "Logs · pod auth-api-7f9c8d6b5-h8lbx",
  );
  expect(backend.sources()).toEqual([
    {
      containers: { type: "named", name: "api" },
      pods: null,
      since: { type: "start" },
      previous: true,
    },
  ]);
  expect(screen.getByText("Previous container")).toBeTruthy();
  await open(false);
  await act(() =>
    vi.waitFor(() => {
      expect(backend.sets()).toContainEqual({
        containers: { type: "named", name: "api" },
        pods: null,
        since: { type: "start" },
        previous: false,
      });
    }),
  );
  expect(backend.sources()).toHaveLength(1);
});

test("an object editor's Logs opens its workload's tab once and focuses it after", async () => {
  const workbench = await mounted();
  const backend = spied(workbench);
  const run = () =>
    workbench.commands.execute(
      "k8s.logs.open",
      workbench.keys.lookup(null),
      DEPLOYMENT,
    );
  await act(run);
  act(() => {
    workbench.editors.open(logsUri(POD));
  });
  await act(run);
  expect(tabsIn("panel").sort()).toEqual(
    [logsUri(DEPLOYMENT), logsUri(POD)].sort(),
  );
  expect(workbench.editors.activeIn("panel")).toBe(logsUri(DEPLOYMENT));
  expect(backend.sources()).toHaveLength(2);
});

async function logsSession() {
  const workbench = await testWorkbench();
  const tabs = new LogsTabs(workbench.backend);
  const uri = logsUri(DEPLOYMENT);
  const input = parseLogsUri(uri);
  if (!input) throw new Error("no logs URI");
  return { workbench, tabs, uri, input, session: tabs.session(uri, input) };
}

test("a narrow tab's fields open in a row of their own from their icons", async () => {
  const { workbench, tabs, uri, input, session } = await logsSession();
  const toolbar = () => (
    <LogsToolbar
      uri={uri}
      input={input}
      tabs={tabs}
      snapshot={INITIAL_LOGS}
      session={session}
      narrow
      compact
    />
  );
  const { rerender } = render(toolbar(), { wrapper: inWorkbench(workbench) });
  expect(screen.queryByRole("textbox", { name: "Find in the lines" })).toBe(
    null,
  );
  act(() => {
    screen.getByRole("button", { name: "Find in the Lines" }).click();
  });
  rerender(toolbar());
  expect(screen.getByRole("textbox", { name: "Find in the lines" })).toBe(
    document.activeElement,
  );
  expect(
    screen.getByRole("button", { name: "Where the lines start" }).textContent,
  ).toBe("15 min");
  session.close();
});

test("the pod picker sets each pod's generated part apart, its hash and suffix", async () => {
  const { workbench, tabs, uri, input, session } = await logsSession();
  const pod = (name: string, generated: number | null) => ({
    name,
    generated,
    status: "Running",
    tone: "neutral" as const,
    containers: [{ name: "api", stream: { state: "following" as const } }],
  });
  render(
    <LogsToolbar
      uri={uri}
      input={input}
      tabs={tabs}
      snapshot={{
        ...INITIAL_LOGS,
        pods: [
          pod("auth-api-7f9c8d6b5-h8lbx", 9),
          pod("auth-api-canary", null),
        ],
      }}
      session={session}
      narrow={false}
      compact={false}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  act(() => {
    screen.getByRole("button", { name: /^2 pods/ }).click();
  });
  expect(
    ["7f9c8d6b5-h8lbx", "auth-api-canary"].map(
      (text) => screen.getByText(text).previousSibling?.textContent ?? "",
    ),
  ).toEqual(["auth-api-", ""]);
  session.close();
});

test("a pause counts from what has arrived; a source that changes nothing resets nothing, and a new one follows", async () => {
  const { tabs, uri, session } = await logsSession();
  session.setWindow({ type: "tail", count: 50 });
  await vi.waitFor(() => {
    expect(session.getSnapshot().arrived).toBeGreaterThan(0);
  });
  const pausedAt = { changes: 0, arrived: session.getSnapshot().arrived };
  tabs.follow(uri, false);
  expect(tabs.get(uri)).toMatchObject({ follow: false, pausedAt });
  tabs.keepPlace(uri, { key: "7", offset: 0 });
  tabs.setSource(uri, { since: { type: "seconds", seconds: 900 } });
  expect(tabs.get(uri)).toMatchObject({ follow: false, pausedAt });
  expect(tabs.place(uri)).toEqual({ key: "7", offset: 0 });
  tabs.setSource(uri, { since: { type: "start" } });
  expect(tabs.get(uri)).toMatchObject({ follow: true });
  expect(tabs.place(uri)).toBeUndefined();
  session.close();
});

test("paused, a refused filter counts on from the pause, and a taken one counts every line its view kept", async () => {
  const { tabs, uri, session } = await logsSession();
  session.setWindow({ type: "tail", count: 50 });
  await vi.waitFor(() => {
    expect(session.getSnapshot().arrived).toBeGreaterThan(0);
  });
  tabs.follow(uri, false);
  const { pausedAt } = tabs.get(uri);
  tabs.setView(uri, { filter: "/(/" });
  await vi.waitFor(() => {
    expect(session.getSnapshot().refused).toBeDefined();
  });
  expect(tabs.get(uri).pausedAt).toEqual(pausedAt);
  expect(tabs.fresh(uri)).toBe(
    session.getSnapshot().arrived - pausedAt.arrived,
  );
  tabs.setView(uri, { filter: "request" });
  await vi.waitFor(
    () => {
      expect(session.getSnapshot()).toMatchObject({
        changes: 1,
        settled: true,
      });
      expect(session.getSnapshot().arrived).toBeGreaterThan(0);
    },
    { timeout: 10_000 },
  );
  expect(tabs.fresh(uri)).toBe(session.getSnapshot().arrived);
  session.close();
}, 15_000);

test("a step right after the search changes waits for that search's matches", async () => {
  const { tabs, uri, session } = await logsSession();
  session.setWindow({ type: "tail", count: 50 });
  tabs.setView(uri, { search: "request" });
  await vi.waitFor(() => {
    expect(session.getSnapshot()).toMatchObject({ settled: true });
    expect(session.getSnapshot().matches?.count).toBeGreaterThan(0);
  });
  tabs.setView(uri, { search: "token" });
  tabs.step(uri, true);
  expect(tabs.get(uri)).toMatchObject({ waiting: "older", reveal: undefined });
  await vi.waitFor(() => {
    expect(tabs.get(uri).reveal?.token).toBe(1);
  });
  expect(tabs.get(uri).waiting).toBeUndefined();
  expect(session.getSnapshot().matches?.entries).toContain(
    tabs.get(uri).anchor?.id,
  );
  session.close();
});

function published(session: LogsSession) {
  return act(
    () =>
      new Promise<void>((done) => {
        const off = session.subscribe(() => {
          off();
          done();
        });
      }),
  );
}

async function logsTab() {
  const workbench = await testWorkbench();
  const tabs = new LogsTabs(workbench.backend);
  registerLogs(workbench, tabs);
  render(<WorkbenchView workbench={workbench} />);
  await act(() =>
    workbench.commands.execute(
      "k8s.logs.open",
      workbench.keys.lookup(null),
      DEPLOYMENT,
    ),
  );
  const uri = logsUri(DEPLOYMENT);
  const input = parseLogsUri(uri);
  if (!input) throw new Error("no logs URI");
  return { workbench, tabs, uri, session: tabs.session(uri, input) };
}

test("F and the Follow button pause and follow through the tab", async () => {
  const { workbench, tabs, uri } = await logsTab();
  const follow = vi.spyOn(tabs, "follow");
  act(() => {
    screen.getByRole("button", { name: "Follow" }).click();
  });
  expect(follow).toHaveBeenLastCalledWith(uri, false);
  expect(tabs.get(uri).follow).toBe(false);
  await act(() =>
    workbench.commands.execute(
      "k8s.logs.toggleFollow",
      workbench.keys.lookup(screen.getByRole("log")),
    ),
  );
  expect(follow).toHaveBeenLastCalledWith(uri, true);
  expect(tabs.get(uri).follow).toBe(true);
});

test("a view that changes nothing keeps the match, the place and the session's view", async () => {
  const { tabs, uri, session } = await logsSession();
  const setView = vi.spyOn(session, "setView");
  tabs.update(uri, { anchor: { id: 9, fromEnd: 0 } });
  tabs.keepPlace(uri, { key: "7", offset: 0 });
  const before = tabs.get(uri);
  tabs.setView(uri, { level: "all", filter: null });
  expect(tabs.get(uri)).toBe(before);
  expect(tabs.place(uri)).toEqual({ key: "7", offset: 0 });
  expect(setView).not.toHaveBeenCalled();
  session.close();
});

test("a paused list keeps its place across a new filter, level and search", async () => {
  const { tabs, uri, session } = await logsSession();
  tabs.follow(uri, false);
  tabs.keepPlace(uri, { key: "3923", offset: -4 });
  tabs.setView(uri, { filter: "request" });
  tabs.setView(uri, { search: "token", level: "warn" });
  expect(tabs.place(uri)).toEqual({ key: "3923", offset: -4 });
  session.close();
});

test("a step's match the last 10,000 no longer list stays current, the line the list shows, and the steps from it go on from the oldest listed", async () => {
  const { tabs, uri, session } = await logsTab();
  await vi.waitFor(() => {
    expect(session.getSnapshot().window?.entries.length).toBeGreaterThan(3);
  });
  act(() => {
    tabs.setView(uri, { search: "request" });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.count).toBeGreaterThan(0);
  });
  const now = session.getSnapshot();
  const line = now.window?.entries.find(
    (entry) => entry.type === "line" && entry.marks.length > 0,
  );
  if (line?.type !== "line") throw new Error("no matching line in the window");
  vi.spyOn(session, "getSnapshot").mockReturnValue({
    ...now,
    settled: true,
    matches: { count: 12, entries: [line.id + 1, line.id + 2, line.id + 3] },
  });
  const height = vi
    .spyOn(Element.prototype, "clientHeight", "get")
    .mockReturnValue(600);
  act(() => {
    tabs.update(uri, {
      anchor: { id: line.id, fromEnd: 0 },
      reveal: { id: line.id, token: 1 },
      follow: false,
    });
  });
  await published(session);
  expect(tabs.get(uri).anchor).toEqual({ id: line.id, fromEnd: 0 });
  expect(screen.getByText("≤ 9 of 12")).toBeTruthy();
  expect(tabs.place(uri)?.key).toBe(String(line.id));
  act(() => {
    tabs.step(uri, false);
  });
  expect(tabs.get(uri)).toMatchObject({
    anchor: { id: line.id + 1, fromEnd: 0 },
  });
  expect(screen.getByText("10 of 12")).toBeTruthy();
  act(() => {
    tabs.update(uri, { anchor: { id: line.id, fromEnd: 0 } });
  });
  act(() => {
    tabs.step(uri, true);
  });
  expect(tabs.get(uri)).toMatchObject({
    anchor: { id: line.id + 3, fromEnd: 0 },
  });
  height.mockRestore();
  session.close();
});

test("a step's match beyond the last 10,000 gives way to the newest once the window asked around it lacks its line, and only then", async () => {
  const { tabs, uri, session } = await logsTab();
  await vi.waitFor(() => {
    expect(session.getSnapshot().window?.entries.length).toBeGreaterThan(3);
  });
  act(() => {
    tabs.setView(uri, { search: "request" });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.count).toBeGreaterThan(0);
  });
  const now = session.getSnapshot();
  const entries = now.window?.entries ?? [];
  const line = entries.find(
    (entry) => entry.type === "line" && entry.marks.length > 0,
  );
  if (line?.type !== "line") throw new Error("no matching line in the window");
  const around = (kept: typeof entries, id: number | null = line.id) => ({
    ...now,
    settled: true,
    matches: { count: 12, entries: [line.id + 1, line.id + 2, line.id + 3] },
    window: {
      start: 0,
      entries: kept,
      around: id === null ? null : { id, index: 0 },
    },
  });
  const lacking = entries.filter((entry) => entry.id !== line.id);
  const snapshot = vi
    .spyOn(session, "getSnapshot")
    .mockReturnValue(around(entries));
  act(() => {
    tabs.update(uri, {
      anchor: { id: line.id, fromEnd: 0 },
      reveal: { id: line.id, token: 1 },
      follow: false,
    });
  });
  expect(tabs.get(uri).anchor).toEqual({ id: line.id, fromEnd: 0 });
  const kept = [];
  for (const id of [line.id + 1, null]) {
    snapshot.mockReturnValue(around(lacking, id));
    await published(session);
    kept.push(tabs.get(uri).anchor);
  }
  expect(kept).toEqual([
    { id: line.id, fromEnd: 0 },
    { id: line.id, fromEnd: 0 },
  ]);
  snapshot.mockReturnValue(around(lacking));
  await published(session);
  expect(tabs.get(uri)).toMatchObject({ anchor: undefined });
  session.close();
});

test("a pod's lines stand out once the window shows it joined, from the render that draws them", async () => {
  const height = vi
    .spyOn(Element.prototype, "clientHeight", "get")
    .mockReturnValue(600);
  const { session } = await logsTab();
  await vi.waitFor(() => {
    expect(session.getSnapshot().window).toBeDefined();
  });
  const pod = "auth-api-63n3i1-fgcpn";
  vi.spyOn(session, "getSnapshot").mockReturnValue({
    ...session.getSnapshot(),
    total: 2,
    window: {
      start: 0,
      around: null,
      entries: [
        {
          type: "joined",
          id: 1,
          pod,
          time: "2026-11-03T10:41:00Z",
          owner: null,
        },
        {
          type: "line",
          id: 2,
          pod,
          container: "api",
          time: "2026-11-03T10:41:01Z",
          level: null,
          text: "ready to serve",
          styles: [],
          marks: [],
        },
      ],
    },
  });
  await published(session);
  const row = screen.getByText("ready to serve").closest("[data-index]");
  expect(row?.querySelector(".text-brand")?.textContent).toMatch(/^fgcpn/);
  height.mockRestore();
  session.close();
});

async function remountAfterSteps(follow: boolean) {
  const { workbench, tabs, uri, session } = await logsTab();
  act(() => {
    tabs.setView(uri, { search: "request" });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.count).toBeGreaterThan(5);
  });
  act(() => {
    tabs.step(uri, true);
  });
  act(() => {
    tabs.step(uri, true);
  });
  act(() => {
    tabs.setView(uri, { search: "no line says this" });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.count).toBe(0);
  });
  if (follow)
    act(() => {
      tabs.follow(uri, true);
    });
  const place = tabs.place(uri);
  cleanup();
  render(<WorkbenchView workbench={workbench} />);
  act(() => {
    tabs.setView(uri, { search: "request" });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.count).toBeGreaterThan(5);
  });
  await screen.findByText(/^\d[\d,]* of [\d,]+$/);
  return { tabs, uri, session, place };
}

test("following, a step's reveal does not come back after a remount when a search finds matches again", async () => {
  const height = vi
    .spyOn(Element.prototype, "clientHeight", "get")
    .mockReturnValue(600);
  const { tabs, uri, session } = await remountAfterSteps(true);
  expect(tabs.get(uri).follow).toBe(true);
  expect(tabs.place(uri)).toBeUndefined();
  height.mockRestore();
  session.close();
}, 20_000);

test("paused, a step's reveal does not pull the list off its place after a remount when a search finds matches again", async () => {
  const height = vi
    .spyOn(Element.prototype, "clientHeight", "get")
    .mockReturnValue(600);
  const { tabs, uri, session, place } = await remountAfterSteps(false);
  expect(place).toBeDefined();
  expect(tabs.place(uri)).toEqual(place);
  height.mockRestore();
  session.close();
}, 20_000);

test("a filter Rust refuses shows as not applied until one is taken", async () => {
  await logsTab();
  const filter = screen.getByRole("textbox", { name: "Only lines with" });
  fireEvent.change(filter, { target: { value: "/(/" } });
  expect(
    await screen.findByText("Not applied:", undefined, { timeout: 3000 }),
  ).toBeTruthy();
  fireEvent.change(filter, { target: { value: "refused" } });
  await vi.waitFor(() => {
    expect(screen.queryByText("Not applied:")).toBeNull();
  });
});

test("the level counts hide while a range is set, which they do not count", async () => {
  const { workbench, tabs, uri, input, session } = await logsSession();
  const snapshot = {
    ...INITIAL_LOGS,
    histogram: {
      from: "2026-11-03T10:00:00Z",
      to: "2026-11-03T10:15:00Z",
      buckets: [{ lines: 9, warnings: 2, errors: 1 }],
    },
  };
  const toolbar = () => (
    <LogsToolbar
      uri={uri}
      input={input}
      tabs={tabs}
      snapshot={snapshot}
      session={session}
      narrow={false}
      compact={false}
    />
  );
  const { rerender } = render(toolbar(), { wrapper: inWorkbench(workbench) });
  const level = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}`) }).textContent;
  expect([level("Warn"), level("Error")]).toEqual(["Warn+3", "Error1"]);
  tabs.setView(uri, {
    range: { from: "2026-11-03T10:05:00Z", to: "2026-11-03T10:10:00Z" },
  });
  rerender(toolbar());
  expect([level("Warn"), level("Error")]).toEqual(["Warn+", "Error"]);
  session.close();
});

test("a step binds the current match to its entry, so matches that come after it move its number, not the match", async () => {
  const { tabs, uri, session } = await logsTab();
  tabs.setView(uri, { search: "request" });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.entries.length).toBeGreaterThan(1);
  });
  act(() => {
    tabs.step(uri, true);
  });
  const { anchor } = tabs.get(uri);
  const standing = () =>
    standingMatch(session.getSnapshot().matches, tabs.get(uri).anchor);
  const back = standing()?.back ?? 0;
  await vi.waitFor(
    () => {
      expect(standing()?.back).toBeGreaterThan(back);
    },
    { timeout: 10_000 },
  );
  expect(standing()?.id).toBe(anchor?.id);
}, 15_000);

test("a filter keeps the match stepped to while the view keeps it, a refused one too, and one that hides it goes back to the newest", async () => {
  const { tabs, uri, session } = await logsTab();
  tabs.setView(uri, { search: "request" });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.entries.length).toBeGreaterThan(1);
  });
  act(() => {
    tabs.step(uri, true);
  });
  const { anchor } = tabs.get(uri);
  expect(anchor).toBeDefined();
  const stepped = () =>
    standingMatch(session.getSnapshot().matches, tabs.get(uri).anchor)?.id;
  act(() => {
    tabs.setView(uri, { filter: "/(/" });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot().refused).toBeDefined();
  });
  expect(tabs.get(uri).anchor).toEqual(anchor);
  expect(stepped()).toBe(anchor?.id);
  act(() => {
    tabs.setView(uri, { filter: "request" });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot()).toMatchObject({
      settled: true,
      refused: undefined,
    });
  });
  expect(tabs.get(uri).anchor).toEqual(anchor);
  expect(stepped()).toBe(anchor?.id);
  act(() => {
    tabs.setView(uri, { filter: "no line says this" });
  });
  await vi.waitFor(() => {
    expect(tabs.get(uri)).toMatchObject({ anchor: undefined });
  });
  act(() => {
    tabs.setView(uri, { filter: null });
  });
  await vi.waitFor(() => {
    expect(session.getSnapshot().settled).toBe(true);
    expect(session.getSnapshot().matches?.entries.length).toBeGreaterThan(1);
  });
  act(() => {
    tabs.step(uri, true);
  });
  expect(tabs.get(uri).anchor).toBeDefined();
  act(() => {
    tabs.setView(uri, { search: "token" });
  });
  expect(tabs.get(uri)).toMatchObject({ anchor: undefined });
  session.close();
}, 20_000);
