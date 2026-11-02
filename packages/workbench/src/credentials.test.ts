import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, ContextAuth } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { testWorkbench } from "./testing";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function untrusted(auth: ContextAuth): string {
  if (auth.state !== "untrusted")
    throw new Error(`not untrusted: ${auth.state}`);
  return auth.plugin.digest;
}

async function select(
  workbench: Awaited<ReturnType<typeof testWorkbench>>,
  space: string,
) {
  act(() => {
    workbench.spaces.select(space);
  });
  await vi.waitFor(() => {
    expect(workbench.credentials.context).toBe(space);
    expect(workbench.credentials.auth.state).not.toBe("none");
  });
}

async function started(scenario: MockScenario, backend?: Backend) {
  const workbench = await testWorkbench(scenario, backend);
  await act(() => workbench.credentials.start());
  await vi.waitFor(() => {
    expect(workbench.credentials.auth.state).not.toBe("none");
  });
  return workbench;
}

test("an untrusted plugin asks when its space opens, and connects once trusted", async () => {
  const { credentials } = await started("untrusted");
  expect(credentials.context).toBe("prod-eu");
  expect(credentials.auth.state).toBe("untrusted");
  expect(credentials.prompt).toBeDefined();
  const ready = credentials.ready;

  await credentials.trust(untrusted(credentials.auth));
  expect(credentials.prompt).toBeUndefined();
  expect(credentials.panelOpen).toBe(true);
  await vi.advanceTimersByTimeAsync(7000);
  expect(credentials.auth).toMatchObject({
    state: "plugin",
    status: { state: "ready" },
  });
  expect(credentials.panelOpen).toBe(false);
  expect(credentials.ready).toBe(ready + 1);
});

test("the first start's review asks instead of the prompt", async () => {
  const { credentials } = await started("review");
  expect(credentials.review.map((p) => p.contexts)).toEqual([
    ["prod-eu"],
    ["staging"],
    ["dev"],
    ["qa"],
  ]);
  expect(credentials.prompt).toBeUndefined();
  await credentials.answerReview([]);
  expect(credentials.review).toEqual([]);
  expect(credentials.prompt).toBeUndefined();
});

test("a sign-in that prints a code shows the panel at once, a silent one after a moment", async () => {
  const printing = await started("deviceCode");
  expect(printing.credentials.panelOpen).toBe(true);

  const silent = await started("browser");
  expect(silent.credentials.panelOpen).toBe(false);
  await vi.advanceTimersByTimeAsync(2100);
  expect(silent.credentials.panelOpen).toBe(true);
});

test("a cancelled sign-in stays on screen with its failure", async () => {
  const { credentials } = await started("deviceCode");
  await credentials.cancel();
  await vi.advanceTimersByTimeAsync(10);
  expect(credentials.auth).toMatchObject({
    state: "plugin",
    status: { state: "failed", error: "exec: kubelogin was cancelled" },
  });
  expect(credentials.panelOpen).toBe(true);
});

test("a prompt whose plugin changed since trusts nothing", async () => {
  const { credentials } = await started("untrusted");
  await credentials.trust("a digest the prompt never showed");
  expect(credentials.auth.state).toBe("untrusted");
  expect(credentials.prompt).toBeDefined();
});

test("trusting the active space's plugin in the review signs in with it", async () => {
  const { credentials } = await started("review");
  await credentials.answerReview(
    credentials.review.map(({ plugin }) => plugin.digest),
  );
  await vi.waitFor(() => {
    expect(credentials.auth).toMatchObject({
      state: "plugin",
      status: { state: "running" },
    });
  });
  expect(credentials.panelOpen).toBe(true);
  await vi.advanceTimersByTimeAsync(7000);
  expect(credentials.ready).toBe(1);
});

test("switching spaces drops the old space's messages and its panel", async () => {
  const workbench = await started("deviceCode");
  const { credentials, backend } = workbench;
  expect(credentials.panelOpen).toBe(true);
  await select(workbench, "staging");
  expect(credentials.panelOpen).toBe(false);
  await backend.invoke("context_sign_in_cancel", "prod-eu");
  await vi.advanceTimersByTimeAsync(10);
  expect(credentials.auth).toMatchObject({
    state: "plugin",
    plugin: { digest: "oidc-staging" },
    status: { state: "ready" },
  });
  expect(credentials.panelOpen).toBe(false);
});

test("the trust prompt opens again when its space opens again", async () => {
  const workbench = await started("untrusted");
  workbench.credentials.setTrustOpen(false);
  await select(workbench, "staging");
  await select(workbench, "prod-eu");
  expect(workbench.credentials.prompt).toBeDefined();
});

test("a panel the person closed stays closed for that run, and a failure shows anyway", async () => {
  const { credentials } = await started("browser");
  credentials.setPanelOpen(false);
  await vi.advanceTimersByTimeAsync(2100);
  expect(credentials.panelOpen).toBe(false);

  const quiet = await started("browser");
  expect(quiet.credentials.panelOpen).toBe(false);
  await quiet.credentials.cancel();
  await vi.advanceTimersByTimeAsync(10);
  expect(quiet.credentials.panelOpen).toBe(true);
});

test("a failure seen live opens the panel once; one found on a space's return does not", async () => {
  const workbench = await started("browser");
  const { credentials } = workbench;
  await credentials.cancel();
  await vi.advanceTimersByTimeAsync(10);
  expect(credentials.panelOpen).toBe(true);
  credentials.setPanelOpen(false);
  await select(workbench, "staging");
  await select(workbench, "prod-eu");
  expect(credentials.auth).toMatchObject({ status: { state: "failed" } });
  expect(credentials.panelOpen).toBe(false);
});

test("a panel closed for a run stays closed when its space comes back", async () => {
  const workbench = await started("deviceCode");
  workbench.credentials.setPanelOpen(false);
  await select(workbench, "staging");
  await select(workbench, "prod-eu");
  expect(workbench.credentials.auth).toMatchObject({
    status: { state: "running" },
  });
  expect(workbench.credentials.panelOpen).toBe(false);
});

test("the panel's timer belongs to the space it started in", async () => {
  const workbench = await started("browser");
  await select(workbench, "staging");
  await vi.advanceTimersByTimeAsync(2100);
  expect(workbench.credentials.panelOpen).toBe(false);
});

test("a prompt whose plugin the kubeconfig changes closes", async () => {
  const mock = createMockBackend("untrusted");
  const pushes: ((auth: ContextAuth) => void)[] = [];
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "context_auth_watch") {
        pushes.push(onMessage);
      }
      return mock.subscribe(command, request, onMessage);
    },
  };
  const { credentials } = await started("untrusted", backend);
  const shown = credentials.prompt;
  expect(shown).toBeDefined();
  const push = pushes[pushes.length - 1];
  if (!shown || !push) throw new Error("no prompt");
  act(() => {
    push({
      state: "untrusted",
      plugin: {
        ...shown,
        args: [...shown.args, "--login", "interactive"],
        digest: "changed",
      },
    });
  });
  expect(credentials.prompt).toBeUndefined();
  await credentials.trust(shown.digest);
  expect(credentials.auth.state).toBe("untrusted");
});

test("a failed trust is reported", async () => {
  const mock = createMockBackend("untrusted");
  const backend: Backend = {
    invoke: (command, request) =>
      command === "exec_trust"
        ? Promise.reject(new Error("disk full"))
        : mock.invoke(command, request),
    subscribe: (command, request, onMessage) =>
      mock.subscribe(command, request, onMessage),
  };
  const workbench = await started("untrusted", backend);
  const report = vi.spyOn(workbench, "report");
  await workbench.credentials.trust(untrusted(workbench.credentials.auth));
  expect(report).toHaveBeenCalledWith(new Error("disk full"));
});

test("trusting signs in for the space the prompt was shown in", async () => {
  const workbench = await started("untrusted");
  const invoke = vi.spyOn(workbench.backend, "invoke");
  const trusting = workbench.credentials.trust(
    untrusted(workbench.credentials.auth),
  );
  act(() => {
    workbench.spaces.select("staging");
  });
  await trusting;
  expect(invoke).toHaveBeenCalledWith("context_sign_in", "prod-eu");
});
