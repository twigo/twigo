import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  IpcError,
  type Backend,
  type Blocked,
  type Forward,
  type ForwardTarget,
  type ModeSource,
} from "@twigo/protocol";
import {
  BLOCKED_AFTER_MS,
  createMockBackend,
  FAILS_AFTER_MS,
  LIFTS_AFTER_MS,
  LOSES_POD_AFTER_MS,
  READY_AFTER_MS,
  type MockScenario,
} from "@twigo/protocol/mock";
import { WorkbenchView, type Workbench } from "@twigo/workbench";
import { tabsIn, testWorkbench } from "@twigo/workbench/testing";
import { patching } from "../../test/forward";
import { settle, withScreenSize } from "../../test/workbench";
import { objectUri, pfUri } from "../uri";
import { registerForwards } from "./register";
import { Forwards } from "./service";

withScreenSize(1400);

const NAMESPACE = "auth";
const SERVICES = { group: "", version: "v1", resource: "services" };
const PODS = { group: "", version: "v1", resource: "pods" };
const API: ForwardTarget = {
  space: "qa",
  gvr: SERVICES,
  namespace: NAMESPACE,
  name: "auth-api",
};
const GATEWAY: ForwardTarget = { ...API, name: "auth-gateway" };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  for (const dismiss of document.querySelectorAll<HTMLElement>(
    '[data-sonner-toast] button[aria-label="Dismiss"]',
  )) {
    dismiss.click();
  }
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

interface Mounted {
  readonly workbench: Workbench;
  readonly forwards: Forwards;
  readonly backend: Backend;
  /** Starts a forward in the core, as `f` would, and lets it settle. */
  readonly start: (
    target: ForwardTarget,
    port: number,
    local?: number,
  ) => Promise<Forward>;
  readonly open: (forward: Forward) => Promise<string>;
}

async function mounted(
  scenario: MockScenario = "live",
  space = "qa",
  patch?: (forward: Forward) => Forward,
): Promise<Mounted> {
  const mock = createMockBackend(scenario);
  const backend = patch ? patching(mock, patch) : mock;
  const workbench = await testWorkbench(scenario, backend);
  const forwards = new Forwards(backend);
  registerForwards(workbench, forwards);
  await act(() => workbench.spaces.open(space));
  act(() => {
    workbench.spaces.select(space);
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  return {
    workbench,
    forwards,
    backend,
    start: async (target, port, local) => {
      const started = backend.invoke("forward_start", {
        target,
        port,
        local: local ?? null,
      });
      await settle(2);
      const answer = await started;
      if (answer.outcome !== "started") throw new Error("the start was busy");
      await later(READY_AFTER_MS + 200);
      return answer.forward;
    },
    open: async ({ id, target }) => {
      const uri = pfUri({ space: target.space, id });
      act(() => {
        workbench.editors.open(uri);
      });
      await settle(6);
      return uri;
    },
  };
}

async function later(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const absent = (name: string) =>
  expect(screen.queryByRole("button", { name })).toBeNull();

const live = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-sonner-toast][data-removed="false"]',
    ),
  ].map((toast) => toast.textContent);

const toastButton = (name: string) => {
  const toast = document.querySelector<HTMLElement>(
    '[data-sonner-toast][data-removed="false"]',
  );
  if (!toast) throw new Error("no toast");
  return within(toast).getByRole("button", { name });
};

/** The requests of each command that go through the backend from now on. */
function recording(backend: Backend) {
  const invoke = vi.spyOn(backend, "invoke");
  return (command: string): unknown[] =>
    invoke.mock.calls
      .filter(([name]) => name === command)
      .map(([, request]) => request);
}

test("a ready forward's tab is titled by its target and ports, and says where it goes and how it is used", async () => {
  const { workbench, start, open } = await mounted();
  const forward = await start(API, 80);
  const uri = await open(forward);
  expect(tabsIn("editor")).toEqual([uri]);
  expect(workbench.editors.title(uri)).toBe("auth-api:http → 8080");
  expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  screen.getByText("auth/auth-api");
  screen.getByText("http 80");
  screen.getByText("localhost:8080");
  screen.getByText(/127\.0\.0\.1 and ::1/);
  expect(
    screen.getByText("Pod", { selector: "dt" }).nextSibling?.textContent,
  ).toMatch(/^auth-api-\S+ port 8080$/);
  screen.getByText("Connections");
  screen.getByText("Last failure");
  screen.getByText("None");
  expect(
    screen.queryByText(/Waiting for a place among the context's/),
  ).toBeNull();
});

test("the target and the pod are links to their objects, which open beside the tab", async () => {
  const { workbench, start, open } = await mounted();
  const forward = await start(API, 80);
  const uri = await open(forward);
  const opened = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const pinned = vi.spyOn(workbench.editors, "pin");
  fireEvent.click(button("auth/auth-api"));
  expect(opened).toHaveBeenLastCalledWith(
    objectUri({
      space: "qa",
      gvr: SERVICES,
      namespace: NAMESPACE,
      name: "auth-api",
    }),
    { preview: true },
  );
  expect(pinned).toHaveBeenLastCalledWith(uri);
  fireEvent.click(button(/^auth-api-[a-z0-9]+-[a-z0-9]+$/));
  const [pod, options] = opened.mock.calls[1] ?? [];
  expect(pod).toMatch(/^k8s:\/\/qa\/\/v1\/pods\/auth\/auth-api-/);
  expect(options).toEqual({ preview: true });
});

test("a forward to a pod has one row for it, which carries the port it reaches, and the pod opens from it", async () => {
  const { workbench, forwards, start, open } = await mounted();
  const service = await start(API, 80);
  const name = forwards.ofSpace("qa").find(({ id }) => id === service.id)?.pod;
  if (!name) throw new Error("the service's forward names no pod");
  const forward = await start({ ...API, gvr: PODS, name }, 8080, 8081);
  await open(forward);
  const rows = screen.getAllByText("Pod", { selector: "dt" });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.nextSibling?.textContent).toBe(`auth/${name} port 8080`);
  const opened = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  fireEvent.click(button(`auth/${name}`));
  expect(opened).toHaveBeenLastCalledWith(
    objectUri({ space: "qa", gvr: PODS, namespace: NAMESPACE, name }),
    { preview: true },
  );
});

test("a forward that loses its pod says it is reconnecting, why, and then shows the other pod", async () => {
  const { start, open } = await mounted("forwardReconnecting");
  const forward = await start(API, 80);
  await open(forward);
  const first = screen.getByText("Pod", { selector: "dt" }).nextSibling
    ?.textContent;
  await later(LOSES_POD_AFTER_MS - READY_AFTER_MS);
  expect(screen.getAllByText("Reconnecting").length).toBeGreaterThan(0);
  screen.getByText(/ is gone; waiting for another ready pod$/);
  screen.getByText(
    "It looks again while it has connections, and at its next one.",
  );
  expect(
    screen.getByText("Pod", { selector: "dt" }).nextSibling?.textContent,
  ).toBe("None to go to");
  await later(5500);
  expect(screen.queryByText("Reconnecting")).toBeNull();
  const second = screen.getByText("Pod", { selector: "dt" }).nextSibling
    ?.textContent;
  expect(second).not.toBe(first);
  expect(second).toMatch(/port 8080$/);
});

test("a forward that failed says the target's own failure, that it still listens and that Start tries again, and no claim about its connections", async () => {
  const { start, open } = await mounted("forwardFailed");
  const forward = await start(API, 80);
  await open(forward);
  expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  screen.getByText(
    /refused the connection to port 8080: nothing listens on it$/,
  );
  screen.getByText("It still listens on localhost:8080. Start tries it again.");
  expect(screen.queryByText(/closes every connection/)).toBeNull();
});

test("restored, stopped and failed forwards of an earlier run say so, each in its words", async () => {
  const { forwards, workbench } = await mounted("forwardRestored", "prod-eu");
  const tab = async (id: number) => {
    act(() => {
      workbench.editors.open(pfUri({ space: "prod-eu", id }));
    });
    await settle(6);
  };
  const pod = () =>
    screen.getByText("Pod", { selector: "dt" }).nextSibling?.textContent;
  expect(forwards.ofSpace("prod-eu").map(({ id }) => id)).toEqual([1, 2, 3]);

  await tab(1);
  screen.getByText("Restored.");
  screen.getByText(
    /asks its cluster at the first connection, or when its space connects\./,
  );
  expect(screen.getAllByText("Restored").length).toBeGreaterThan(0);
  expect(pod()).toBe("Not chosen yet");

  await tab(2);
  screen.getByText("Stopped.");
  screen.getByText(/Nothing listens on localhost:9090; Start brings it back\./);
  expect(pod()).toBe("None while stopped");

  await tab(3);
  screen.getByText('deployments.apps "payments-legacy" not found');
  expect(pod()).toBe("None");
});

test("connections that wait for a session say that the context's are all taken", async () => {
  const { start, open } = await mounted("forwardQueued");
  const forward = await start(API, 80);
  await open(forward);
  screen.getByText("Waiting for a place among the context's 64 sessions.");
  screen.getByText("Close a shell or another connection to free one.");
  expect(screen.getByText("Connections").nextSibling?.textContent).toBe(
    "66, 2 waiting",
  );
  expect(screen.getAllByText("Ready · 2 waiting").length).toBeGreaterThan(0);
});

test("a tab a restored layout brings back for a forward the core lacks says so and offers to close, and one the core removes while it shows does the same", async () => {
  const { workbench, start, open, backend } = await mounted();
  const gone = pfUri({ space: "qa", id: 41 });
  act(() => {
    workbench.editors.open(gone);
  });
  await settle(6);
  screen.getByText("Port-forward not found");
  screen.getByText("It was not found, so there is nothing to show.");
  expect(screen.queryByText(/removed/)).toBeNull();
  fireEvent.click(button("Close"));
  await settle(4);
  expect(tabsIn("editor")).toEqual([]);

  const forward = await start(API, 80);
  const uri = await open(forward);
  screen.getByText("auth-api:http → 8080", { selector: "h2" });
  await act(() => backend.invoke("forward_remove", forward.id));
  await settle(4);
  screen.getByText("Port-forward not found");
  expect(tabsIn("editor")).toEqual([uri]);
});

test("a tab a restored layout brings back with a stale title is retitled by its forward", async () => {
  const { workbench, start, open } = await mounted();
  const uri = await open(await start(API, 80));
  cleanup();
  const layout = structuredClone(workbench.spaces.state("qa").editors);
  const panel = layout?.panels[uri];
  if (!layout || !panel) throw new Error("the layout was not saved");
  layout.panels[uri] = { ...panel, title: "Port forward" };
  workbench.spaces.update("qa", (state) => ({ ...state, editors: layout }));
  render(<WorkbenchView workbench={workbench} />);
  await settle(6);
  expect(workbench.editors.title(uri)).toBe("auth-api:http → 8080");
});

test("the actions follow the state: a ready http forward can be opened, copied, stopped, moved and removed, not started", async () => {
  const { start, open } = await mounted();
  await open(await start(API, 80));
  for (const name of [
    "Open in Browser",
    "Copy Address",
    "Stop",
    "Change Local Port…",
    "Remove",
  ]) {
    button(name);
  }
  absent("Start");
});

test("a stopped forward offers Start and no Stop, and a failed one both", async () => {
  const stopped = await mounted("forwardRestored", "prod-eu");
  act(() => {
    stopped.workbench.editors.open(pfUri({ space: "prod-eu", id: 2 }));
  });
  await settle(6);
  button("Start");
  absent("Stop");
  button("Remove");
  cleanup();

  const failed = await mounted("forwardRestored", "prod-eu");
  act(() => {
    failed.workbench.editors.open(pfUri({ space: "prod-eu", id: 3 }));
  });
  await settle(6);
  button("Start");
  button("Stop");
});

test("a port that does not say HTTP has no Open in Browser", async () => {
  const { start, open } = await mounted();
  await open(await start(GATEWAY, 9000));
  screen.getByText("grpc 9000");
  absent("Open in Browser");
  button("Copy Address");
});

test("Open in Browser reads the forward's own appProtocol: a port named metrics that declares http opens, with nothing asked of the core", async () => {
  const { start, open, backend } = await mounted();
  const forward = await start(GATEWAY, 9090);
  await open(forward);
  const calls = recording(backend);
  vi.spyOn(globalThis, "open").mockReturnValue(null);
  fireEvent.click(button("Open in Browser"));
  await settle(4);
  expect(calls("url_open")).toEqual(["http://localhost:9090"]);
  expect(calls("forward_ports")).toEqual([]);
});

test("Open in Browser opens the local address through the workbench, Copy Address copies it", async () => {
  const { start, open, backend } = await mounted();
  const calls = recording(backend);
  const opener = vi.spyOn(globalThis, "open").mockReturnValue(null);
  const write = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  await open(await start(API, 80));
  fireEvent.click(button("Open in Browser"));
  await settle(4);
  expect(calls("url_open")).toEqual(["http://localhost:8080"]);
  expect(opener).toHaveBeenCalledWith(
    "http://localhost:8080",
    "_blank",
    "noopener,noreferrer",
  );
  fireEvent.click(button("Copy Address"));
  await settle(2);
  expect(write).toHaveBeenCalledWith("localhost:8080");
});

test("Stop stops the forward and Start brings it back, from the same tab", async () => {
  const { start, open, backend } = await mounted();
  const calls = recording(backend);
  const forward = await start(API, 80);
  await open(forward);
  fireEvent.click(button("Stop"));
  await settle(6);
  expect(calls("forward_stop")).toEqual([forward.id]);
  expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
  button("Start");
  absent("Stop");

  fireEvent.click(button("Start"));
  await later(READY_AFTER_MS + 100);
  expect(calls("forward_resume")).toEqual([{ id: forward.id, local: null }]);
  expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
});

test("Remove removes the forward and closes its tab", async () => {
  const { start, open, backend, forwards } = await mounted();
  const calls = recording(backend);
  const forward = await start(API, 80);
  await open(forward);
  fireEvent.click(button("Remove"));
  await settle(6);
  expect(calls("forward_remove")).toEqual([forward.id]);
  expect(forwards.get(forward.id)).toBeUndefined();
  expect(tabsIn("editor")).toEqual([]);
});

test("Change Local Port asks for the port and resumes the forward on it, and the tab follows", async () => {
  const { workbench, start, open, backend } = await mounted();
  const calls = recording(backend);
  const forward = await start(API, 80);
  const uri = await open(forward);
  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  const ask = workbench.quickAccess.session?.ask;
  expect(ask?.prompt).toBe("Forward auth-api:http on localhost port");
  expect(ask?.value).toBe("8080");
  expect(ask?.validate("0")).toBe("Type a port from 1 to 65535");
  expect(ask?.validate("70000")).toBe("Type a port from 1 to 65535");
  expect(ask?.validate("http")).toBe("Type a port from 1 to 65535");
  act(() => {
    workbench.quickAccess.setValue("8090");
    workbench.quickAccess.submit();
  });
  await later(READY_AFTER_MS + 100);
  expect(calls("forward_resume")).toEqual([{ id: forward.id, local: 8090 }]);
  expect(workbench.editors.title(uri)).toBe("auth-api:http → 8090");
  screen.getByText("localhost:8090");
});

test("a local port that is in use starts nothing on another by itself: the next free one is offered, and taken only when the person takes it", async () => {
  const { workbench, start, open, backend } = await mounted("forwardBusy");
  const forward = await start(API, 80, 8085);
  await open(forward);
  const calls = recording(backend);
  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  act(() => {
    workbench.quickAccess.setValue("8080");
    workbench.quickAccess.submit();
  });
  await settle(6);
  expect(live()).toEqual([
    "8080 is in use by another process or forward, so auth-api:http stays on 8085.Use 8081",
  ]);
  await later(5000);
  expect(calls("forward_resume")).toEqual([{ id: forward.id, local: 8080 }]);
  screen.getByText("localhost:8085");

  fireEvent.click(toastButton("Use 8081"));
  await settle(6);
  expect(calls("forward_resume")).toEqual([
    { id: forward.id, local: 8080 },
    { id: forward.id, local: 8081 },
  ]);
});

test("a stopped forward that is moved onto a busy port is not forwarded, and says so", async () => {
  const { workbench, start, open } = await mounted("forwardBusy");
  const forward = await start(API, 80, 8085);
  await open(forward);
  fireEvent.click(button("Stop"));
  await settle(6);
  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  act(() => {
    workbench.quickAccess.setValue("8080");
    workbench.quickAccess.submit();
  });
  await settle(6);
  expect(live()).toEqual([
    "8080 is in use by another process or forward, so auth-api:http is not forwarded.Use 8081",
  ]);
});

test("a start that fails says the target's own failure in a toast, which neither bind answer does", async () => {
  const { start, open } = await mounted("forwardFailed");
  const forward = await start(API, 80);
  await open(forward);
  fireEvent.click(button("Start"));
  await later(FAILS_AFTER_MS + 100);
  const [toast] = live();
  expect(toast).toMatch(
    /^auth-api:http → 8080 failed: pod \S+ refused the connection to port 8080: nothing listens on it/,
  );
  expect(toast).not.toContain("in use");
  expect(toast).not.toContain("below 1024");
});

test("a tab that opens before the core has answered does not say the forward is not found", async () => {
  const backend = createMockBackend("live");
  const workbench = await testWorkbench("live", backend);
  const held: Backend = {
    invoke: (command, request) => backend.invoke(command, request),
    subscribe: (command, request, onMessage) =>
      command === "forwards_watch"
        ? new Promise<never>(() => undefined)
        : backend.subscribe(command, request, onMessage),
  };
  registerForwards(workbench, new Forwards(held));
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("qa");
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  act(() => {
    workbench.editors.open(pfUri({ space: "qa", id: 1 }));
  });
  await settle(6);
  expect(screen.queryByText("Port-forward not found")).toBeNull();
  expect(document.querySelector("[aria-busy]")).not.toBeNull();
});

test("a busy port's toast that is dismissed moves nothing: the forward stays where it was, and no port is taken", async () => {
  const { workbench, start, open, backend, forwards } =
    await mounted("forwardBusy");
  const forward = await start(API, 80, 8085);
  await open(forward);
  const calls = recording(backend);
  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  act(() => {
    workbench.quickAccess.setValue("8080");
    workbench.quickAccess.submit();
  });
  await settle(6);
  expect(live()).toEqual([
    "8080 is in use by another process or forward, so auth-api:http stays on 8085.Use 8081",
  ]);
  fireEvent.click(toastButton("Dismiss"));
  await later(5000);
  expect(calls("forward_resume")).toEqual([{ id: forward.id, local: 8080 }]);
  expect(forwards.get(forward.id)?.local).toBe(8085);
  expect(live()).toEqual([]);
});

test("a resume that fails for another reason than a busy port or the mode is shown as an error in the core's words, from Start and from Change Local Port…", async () => {
  const mock = createMockBackend("live");
  let failing = false;
  const backend: Backend = {
    invoke: (command, request) =>
      failing && command === "forward_resume"
        ? Promise.reject(
            new IpcError("unavailable", "the cluster does not answer"),
          )
        : mock.invoke(command, request),
    subscribe: (command, request, onMessage) =>
      mock.subscribe(command, request, onMessage),
  };
  const workbench = await testWorkbench("live", backend);
  const forwards = new Forwards(backend);
  registerForwards(workbench, forwards);
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("qa");
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  const started = backend.invoke("forward_start", {
    target: API,
    port: 80,
    local: null,
  });
  await settle(2);
  const answer = await started;
  if (answer.outcome !== "started") throw new Error("the start was busy");
  await later(READY_AFTER_MS + 200);
  const { id } = answer.forward;
  act(() => {
    workbench.editors.open(pfUri({ space: "qa", id }));
  });
  await settle(6);
  fireEvent.click(button("Stop"));
  await settle(6);

  failing = true;
  fireEvent.click(button("Start"));
  await settle(8);
  expect(live().join("\n")).toContain("the cluster does not answer");
  expect(
    document
      .querySelector('[data-sonner-toast] svg[class*="text-"]')
      ?.getAttribute("class"),
  ).toContain("text-error");
  expect(forwards.get(id)?.state.state).toBe("stopped");
  for (const dismiss of document.querySelectorAll<HTMLElement>(
    '[data-sonner-toast] button[aria-label="Dismiss"]',
  ))
    dismiss.click();
  await settle(6);
  expect(live()).toEqual([]);

  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  act(() => {
    workbench.quickAccess.setValue("8090");
    workbench.quickAccess.submit();
  });
  await settle(8);
  expect(live().join("\n")).toContain("the cluster does not answer");
  expect(forwards.get(id)?.local).toBe(8080);
});

const BLOCKED =
  "qa is read-only by qa in /Library/Application Support/Twigo/policy.json, so Twigo did not send get pods/portforward in auth";

test("a forward that a policy file forbids says the mode's words, still listening, not that it failed", async () => {
  const { start, open } = await mounted("forwardBlocked");
  const forward = await start(API, 80);
  await open(forward);
  expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  await later(BLOCKED_AFTER_MS);
  expect(screen.getAllByText("Read-only").length).toBeGreaterThan(0);
  expect(screen.queryByText("Failed")).toBeNull();
  screen.getByText("qa is read-only");
  screen.getByText(
    new RegExp(`^${BLOCKED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  screen.getByText(
    "It still listens on localhost:8080 and closes every connection at once, until the mode lets forwards through.",
  );
});

test("a forward that waits after the mode's refusal was lifted does not say it was restored when Twigo started", async () => {
  const { start, open } = await mounted("forwardBlocked");
  const forward = await start(API, 80);
  await open(forward);
  await later(BLOCKED_AFTER_MS + LIFTS_AFTER_MS);
  expect(screen.getAllByText("Restored").length).toBeGreaterThan(0);
  screen.getByText("Restored.");
  expect(screen.queryByText(/when Twigo started/)).toBeNull();
  expect(screen.queryByText("Read-only")).toBeNull();
  button("Remove");
  button("Stop");
  absent("Start");
});

test("a start that the mode refuses says so as a warning in the gate's words, and the forward stays as it was", async () => {
  const { start, open, backend, forwards } = await mounted("forwardBlocked");
  const forward = await start(API, 80);
  await open(forward);
  fireEvent.click(button("Stop"));
  await settle(6);
  await later(BLOCKED_AFTER_MS);
  const calls = recording(backend);
  fireEvent.click(button("Start"));
  await later(READY_AFTER_MS + 100);
  expect(calls("forward_resume")).toEqual([{ id: forward.id, local: null }]);
  const [toast] = live();
  expect(toast).toMatch(
    /^auth-api:http is not forwarded: qa is read-only by qa in /,
  );
  expect(toast).not.toContain("failed");
  const icon = document.querySelector(
    '[data-sonner-toast] svg[class*="text-"]',
  );
  expect(icon?.getAttribute("class")).toContain("text-warn");
  expect(forwards.get(forward.id)?.state.state).toBe("stopped");
});

const REFUSED = (source: ModeSource): Forward["state"] => {
  const blocked: Blocked = {
    context: "qa",
    mode: "read-only",
    source,
    class: "forward",
    reason: "mode",
    verb: "get",
    target: "pods/portforward in auth",
  };
  return {
    state: "failed",
    error: { kind: "permissions", message: "qa is read-only", blocked },
  };
};

test("a forward that failed on a lock the person may lift keeps Start and Change Local Port…, and one a policy file or an unlisted context locks has neither", async () => {
  const { start, open } = await mounted("live", "qa", (forward) => ({
    ...forward,
    state: REFUSED({
      kind: "policyFile",
      file: "/etc/twigo/policy.json",
      pattern: null,
    }),
  }));
  await open(await start(API, 80));
  expect(screen.getAllByText("qa is read-only").length).toBeGreaterThan(0);
  absent("Start");
  absent("Change Local Port…");
  button("Stop");
  button("Remove");
});

test("a forward that listens nowhere says so: not on an address, and that Change Local Port… and Start are the way out", async () => {
  const { start, open } = await mounted("live", "qa", (forward) => ({
    ...forward,
    addresses: [],
    state: {
      state: "failed",
      error: {
        kind: "conflict",
        message: "port 8080 is held by another process",
      },
    },
  }));
  await open(await start(API, 80));
  screen.getByText("port 8080 is held by another process");
  screen.getByText(
    "Nothing listens on localhost:8080. Change Local Port… moves it to another port, and Start tries this one again.",
  );
  expect(screen.queryByText(/still listens/)).toBeNull();
  const address = screen.getByText("Local address", { selector: "dt" })
    .nextSibling?.textContent;
  expect(address).toBe("localhost:8080 not listening");
  button("Start");
  button("Change Local Port…");
});

test("a stopped forward's address line does not contradict its banner, whatever addresses the core still holds", async () => {
  const { start, open } = await mounted("live", "qa", (forward) => ({
    ...forward,
    state: { state: "stopped" },
    addresses: ["127.0.0.1", "::1"],
  }));
  await open(await start(API, 80));
  screen.getByText(/Nothing listens on localhost:8080; Start brings it back\./);
  const address = screen.getByText("Local address", { selector: "dt" })
    .nextSibling?.textContent;
  expect(address).toBe("localhost:8080 not listening");
});

test("the counters say that they count since Twigo started, and each shows its own bytes and the failure its own words", async () => {
  const { start, open } = await mounted("live", "qa", (forward) => ({
    ...forward,
    sent: 1536,
    received: 5 * 1024 * 1024,
    failure: "pod auth-api-1 refused the connection to port 8080",
  }));
  await open(await start(API, 80));
  const value = (label: string) =>
    screen.getByText(label, { selector: "dt" }).nextSibling?.textContent;
  expect(value("Sent")).toBe("1.5 KiB since Twigo started");
  expect(value("Received")).toBe("5 MiB since Twigo started");
  expect(value("Last failure")).toBe(
    "pod auth-api-1 refused the connection to port 8080",
  );
});

test("a tab whose address names another space shows nothing of that space's forward", async () => {
  const { workbench, start } = await mounted();
  const forward = await start(API, 80);
  await act(() => workbench.spaces.open("prod-eu"));
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  const other = pfUri({ space: "prod-eu", id: forward.id });
  act(() => {
    workbench.editors.open(other);
  });
  await settle(6);
  expect(tabsIn("editor")).toEqual([other]);
  screen.getByText("Port-forward not found");
  expect(
    screen.queryByText("auth-api:http → 8080", { selector: "h2" }),
  ).toBeNull();
  expect(workbench.editors.title(other)).toBe("Port forward");
  absent("Stop");
});
