import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { INITIAL_LOGS, type LogEntry } from "@twigo/protocol";
import { WorkbenchView } from "@twigo/workbench";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { registerKube } from "../register";
import { LogsToolbar } from "./LogsToolbar";
import { LogsTabs } from "./state";
import { logsUri, parseLogsUri } from "../uri";
import {
  anchoredMatch,
  currentMatch,
  lineItem,
  logsKind,
  podTag,
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
  const matches = { count: 12, entries: [3, 7, 7, 9] };
  expect(currentMatch(matches, 0)).toEqual({
    index: 9,
    fromEnd: 0,
    number: 12,
  });
  expect(currentMatch(matches, 1)).toEqual({
    index: 7,
    fromEnd: 0,
    number: 11,
  });
  expect(currentMatch(matches, 2)).toEqual({
    index: 7,
    fromEnd: 1,
    number: 10,
  });
  expect(currentMatch(matches, 4)).toBeUndefined();
  expect(currentMatch(undefined, 0)).toBeUndefined();
});

test("an anchored match keeps its entry and mark as matches come after it and drop before it", () => {
  const before = { count: 4, entries: [3, 7, 7, 9] };
  expect(anchoredMatch(before, 7, 1)).toBe(2);
  const after = { count: 5, entries: [5, 5, 10, 12, 14] };
  expect(anchoredMatch(after, 5, 1)).toBe(4);
  expect(anchoredMatch(after, 5, 0)).toBe(3);
  expect(anchoredMatch(after, 6, 0)).toBeUndefined();
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
  expect(workbench.editors.openIn("panel")).toEqual([uri]);
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
  expect(workbench.editors.openIn("panel").sort()).toEqual(
    [logsUri(DEPLOYMENT), logsUri(POD)].sort(),
  );
  expect(workbench.editors.activeIn("panel")).toBe(logsUri(DEPLOYMENT));
  expect(backend.sources()).toHaveLength(2);
});

test("a narrow tab's fields open in a row of their own from their icons", async () => {
  const workbench = await testWorkbench();
  const tabs = new LogsTabs(workbench.backend);
  const uri = logsUri(DEPLOYMENT);
  const input = parseLogsUri(uri);
  if (!input) throw new Error("no logs URI");
  const session = tabs.session(uri, input);
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
