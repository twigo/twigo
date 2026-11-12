import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, Forward, ForwardTarget } from "@twigo/protocol";
import {
  BLOCKED_AFTER_MS,
  createMockBackend,
  FAILS_AFTER_MS,
  LOSES_POD_AFTER_MS,
  READY_AFTER_MS,
  type MockScenario,
} from "@twigo/protocol/mock";
import { WorkbenchView, type Workbench } from "@twigo/workbench";
import { tabsIn, testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { objectUri, pfUri } from "../uri";
import { registerForwards } from "./register";
import { Forwards } from "./service";

withScreenSize(1400);

const NAMESPACE = "auth";
const SERVICES = { group: "", version: "v1", resource: "services" };
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
  history.replaceState(null, "", "/");
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
): Promise<Mounted> {
  const backend = createMockBackend(scenario);
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
});

test("the counters of a ready forward move while the tab is open", async () => {
  const { start, open } = await mounted();
  const forward = await start(API, 80);
  await open(forward);
  const sent = () => screen.getByText("Sent").nextSibling?.textContent;
  expect(sent()).toBe("0 B");
  await later(3000);
  expect(sent()).not.toBe("0 B");
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

test("a forward that loses its pod says it is reconnecting, why, and then shows the other pod", async () => {
  const { start, open } = await mounted("forwardReconnecting");
  const forward = await start(API, 80);
  await open(forward);
  const first = screen.getByText("Pod", { selector: "dt" }).nextSibling
    ?.textContent;
  await later(LOSES_POD_AFTER_MS - READY_AFTER_MS);
  expect(screen.getAllByText("Reconnecting").length).toBeGreaterThan(0);
  screen.getByText(/ is gone; waiting for another ready pod$/);
  expect(
    screen.getByText("Pod", { selector: "dt" }).nextSibling?.textContent,
  ).toBe("Not chosen yet");
  await later(5500);
  expect(screen.queryByText("Reconnecting")).toBeNull();
  const second = screen.getByText("Pod", { selector: "dt" }).nextSibling
    ?.textContent;
  expect(second).not.toBe(first);
  expect(second).toMatch(/port 8080$/);
});

test("a forward that failed says the target's own failure, and that it still listens", async () => {
  const { start, open } = await mounted("forwardFailed");
  const forward = await start(API, 80);
  await open(forward);
  expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  screen.getByText(
    /refused the connection to port 8080: nothing listens on it$/,
  );
  screen.getByText(
    /It still listens on localhost:8080 and closes every connection/,
  );
});

test("restored, stopped and failed forwards of an earlier run say so, each in its words", async () => {
  const { forwards, workbench } = await mounted("forwardRestored", "prod-eu");
  const tab = async (id: number) => {
    act(() => {
      workbench.editors.open(pfUri({ space: "prod-eu", id }));
    });
    await settle(6);
  };
  expect(forwards.ofSpace("prod-eu").map(({ id }) => id)).toEqual([1, 2, 3]);

  await tab(1);
  screen.getByText("Restored when Twigo started.");
  screen.getByText(/its cluster is asked at the first connection/);
  expect(screen.getAllByText("Restored").length).toBeGreaterThan(0);

  await tab(2);
  screen.getByText("Stopped.");
  screen.getByText(/Nothing listens on localhost:9090; Start brings it back\./);

  await tab(3);
  screen.getByText('deployments.apps "payments-legacy" not found');
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

test("a ready forward in another scenario shows no wait", async () => {
  const { start, open } = await mounted();
  await open(await start(API, 80));
  expect(
    screen.queryByText(/Waiting for a place among the context's/),
  ).toBeNull();
});

test("a tab a restored layout brings back for a forward the core lacks says so and offers to close, and one the core removes while it shows does the same", async () => {
  const { workbench, start, open, backend } = await mounted();
  const gone = pfUri({ space: "qa", id: 41 });
  act(() => {
    workbench.editors.open(gone);
  });
  await settle(6);
  screen.getByText("This port-forward is gone");
  fireEvent.click(button("Close"));
  await settle(4);
  expect(tabsIn("editor")).toEqual([]);

  const forward = await start(API, 80);
  const uri = await open(forward);
  screen.getByText("auth-api:http → 8080", { selector: "h2" });
  await act(() => backend.invoke("forward_remove", forward.id));
  await settle(4);
  screen.getByText("This port-forward is gone");
  expect(tabsIn("editor")).toEqual([uri]);
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
  const forward = await start(API, 80, 8081);
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
    "8080 is in use by another process or forward, so auth-api:http is not forwarded.Use 8081",
  ]);
  await later(5000);
  expect(calls("forward_resume")).toEqual([{ id: forward.id, local: 8080 }]);
  screen.getByText("localhost:8081");

  fireEvent.click(toastButton("Use 8081"));
  await settle(6);
  expect(calls("forward_resume")).toEqual([
    { id: forward.id, local: 8080 },
    { id: forward.id, local: 8081 },
  ]);
});

test("a port below 1024 says that Twigo cannot listen on it, not that it is in use", async () => {
  const { workbench, start, open } = await mounted();
  const forward = await start(API, 80, 8085);
  await open(forward);
  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  act(() => {
    workbench.quickAccess.setValue("80");
    workbench.quickAccess.submit();
  });
  await settle(6);
  const [toast] = live();
  expect(toast).toContain(
    "Twigo cannot listen on 80: ports below 1024 need privileges it does not have, so auth-api:http is not forwarded.",
  );
  expect(toast).not.toContain("in use");
  toastButton("Use 1024");
});

test("with the input variant a busy port asks again with the free port filled in and why", async () => {
  history.replaceState(null, "", "/?variant=busy:input");
  const { workbench, start, open, backend } = await mounted("forwardBusy");
  const forward = await start(API, 80, 8081);
  await open(forward);
  const calls = recording(backend);
  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  act(() => {
    workbench.quickAccess.setValue("8080");
    workbench.quickAccess.submit();
  });
  await settle(6);
  const ask = workbench.quickAccess.session?.ask;
  expect(ask?.prompt).toBe(
    "8080 is in use by another process or forward. Enter forwards auth-api:http on the port above.",
  );
  expect(ask?.value).toBe("8081");
  expect(live()).toEqual([]);
  expect(calls("forward_resume")).toHaveLength(1);

  act(() => {
    workbench.quickAccess.submit();
  });
  await settle(6);
  expect(calls("forward_resume")).toEqual([
    { id: forward.id, local: 8080 },
    { id: forward.id, local: 8081 },
  ]);
});

test("with the input variant a port below 1024 says why in the prompt, whole, under the field", async () => {
  history.replaceState(null, "", "/?variant=busy:input");
  const { workbench, start, open } = await mounted();
  const forward = await start(API, 80, 8085);
  await open(forward);
  fireEvent.click(button("Change Local Port…"));
  await settle(4);
  act(() => {
    workbench.quickAccess.setValue("80");
    workbench.quickAccess.submit();
  });
  await settle(6);
  const prompt =
    "Twigo cannot listen on 80: ports below 1024 need privileges it does not have. Enter forwards auth-api:http on the port above.";
  expect(workbench.quickAccess.session?.ask?.prompt).toBe(prompt);
  expect(workbench.quickAccess.session?.ask?.value).toBe("1024");
  expect(screen.getByText(prompt).className).not.toContain("truncate");
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

test("a tab that opens before the core has answered shows no forward is gone", async () => {
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
  expect(screen.queryByText("This port-forward is gone")).toBeNull();
  expect(document.querySelector("[aria-busy]")).not.toBeNull();
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

test("a start that the mode refuses says so as a warning in the gate's words, and the forward stays as it was", async () => {
  const { start, open, backend, forwards } = await mounted("forwardBlocked");
  const forward = await start(API, 80);
  await open(forward);
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
  expect(forwards.get(forward.id)?.state.state).toBe("failed");
  expect(screen.getAllByText("Read-only").length).toBeGreaterThan(0);
});
