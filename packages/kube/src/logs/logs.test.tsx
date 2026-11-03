import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { LogEntry } from "@twigo/protocol";
import { WorkbenchView } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import { registerKube } from "../register";
import { logsUri } from "../uri";
import { currentMatch, lineItem, logsKind, podTag } from "./entries";

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

test("the current match counts back from the newest, and knows its place in its entry", () => {
  const matches = { count: 12, entries: [3, 7, 7, 9] };
  expect(currentMatch(matches, 0)).toEqual({
    index: 9,
    ordinal: 0,
    number: 12,
  });
  expect(currentMatch(matches, 1)).toEqual({
    index: 7,
    ordinal: 1,
    number: 11,
  });
  expect(currentMatch(matches, 2)).toEqual({
    index: 7,
    ordinal: 0,
    number: 10,
  });
  expect(currentMatch(matches, 4)).toBeUndefined();
  expect(currentMatch(undefined, 0)).toBeUndefined();
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
      { start: 0, end: 7, current: false },
      { start: 9, end: 16, current: true },
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

test("a finding's Previous logs opens its pod's tab in the panel on that container's previous instance", async () => {
  const workbench = await mounted();
  await act(() =>
    workbench.commands.execute("k8s.logs.open", workbench.keys.lookup(null), {
      ...POD,
      container: "api",
      previous: true,
    }),
  );
  const uri = logsUri(POD);
  expect(workbench.editors.openIn("panel")).toEqual([uri]);
  expect(workbench.editors.title(uri)).toBe(
    "Logs · pod auth-api-7f9c8d6b5-h8lbx",
  );
  const space = workbench.spaces.active?.id ?? "";
  expect(workbench.spaces.state(space).parts.panel.visible).toBe(true);
  expect(screen.getByText("Previous container")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /pod …-h8lbx · api/ }),
  ).toBeTruthy();
});

test("an object editor's Logs opens its workload's tab once, focusing it after", async () => {
  const workbench = await mounted();
  const run = () =>
    workbench.commands.execute(
      "k8s.object.logs",
      (key) =>
        key === "resource.logs" ? true : workbench.keys.lookup(null)(key),
      "k8s://prod-eu/apps/v1/deployments/auth/auth-api",
    );
  await act(run);
  await act(run);
  expect(workbench.editors.openIn("panel")).toEqual([logsUri(DEPLOYMENT)]);
});
