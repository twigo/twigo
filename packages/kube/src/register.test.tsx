import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, Discovered } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { mountKube, settle } from "../test/workbench";
import { diffUri } from "./uri";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const dot = (space: string) => {
  const tile = within(screen.getByRole("navigation", { name: "Spaces" }))
    .getByRole("button", { name: space })
    .querySelector("[aria-hidden].rounded-full");
  if (!tile) return undefined;
  const { className } = tile;
  if (className.includes("bg-error")) return "error";
  if (className.includes("var(--warn)"))
    return className.includes("animate-pulse") ? "warn, pulsing" : "warn";
  if (className.includes("bg-ok")) return "ok";
  if (className.includes("bg-muted-foreground-2")) return "idle";
  return className;
};

function held(fail?: string) {
  const mock = createMockBackend("ready");
  const answers = new Map<string, () => void>();
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "resources_watch" || typeof request !== "string")
        return mock.subscribe(command, request, onMessage);
      const send = onMessage as (next: Discovered) => void;
      const space = request;
      answers.set(space, () => {
        if (space === fail)
          send({
            state: "failed",
            error: { kind: "unavailable", message: "no route" },
          });
        else void mock.subscribe(command, request, onMessage);
      });
      return Promise.resolve(null as never);
    },
  };
  return {
    backend,
    answer: async (space: string) => {
      act(() => {
        answers.get(space)?.();
      });
      await settle(1);
    },
  };
}

test("the active space's tile shows its connection from discovery, a space left behind idles", async () => {
  const { backend, answer } = held();
  const workbench = await mountKube(backend);
  expect(dot("prod-eu")).toBe("warn, pulsing");
  expect(dot("staging")).toBe("idle");
  await answer("prod-eu");
  expect(dot("prod-eu")).toBe("ok");

  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(1);
  expect(dot("staging")).toBe("warn, pulsing");
  expect(dot("prod-eu")).toBe("idle");
  await answer("staging");
  expect(dot("staging")).toBe("ok");
  expect(dot("dev")).toBe("idle");
});

test("a space whose discovery failed shows an error dot, active or not", async () => {
  const { backend, answer } = held("staging");
  const workbench = await mountKube(backend);
  await answer("prod-eu");
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(1);
  await answer("staging");
  expect(dot("staging")).toBe("error");
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  await settle(1);
  expect(dot("staging")).toBe("error");
  expect(dot("prod-eu")).toBe("ok");
});

test("an editor of another space waits for its space instead of opening in the one shown", async () => {
  const workbench = await mountKube();
  act(() => {
    workbench.editors.open("k8s-list://staging/v1/pods");
  });
  await settle();
  expect(workbench.editors.active).toBeUndefined();
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle();
  expect(workbench.editors.active).toBe("k8s-list://staging/v1/pods");
});

test("the tab of a diff names a new manifest as its own tab does, and an object by its name", async () => {
  const workbench = await mountKube();
  act(() => {
    workbench.editors.open(
      diffUri({ kind: "apply", editor: "untitled://prod-eu/manifest-2" }),
    );
    workbench.editors.open(
      diffUri({
        kind: "server",
        editor: "k8s://prod-eu//v1/pods/auth/auth-api-1a4uyl1-r2bkk",
      }),
    );
  });
  await settle();
  const titles = [...document.querySelectorAll(".dv-tab")].map(
    (tab) => tab.textContent,
  );
  expect(titles).toEqual([
    "Apply · Manifest 2",
    "Server · auth-api-1a4uyl1-r2bkk",
  ]);
});
