import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import type { Forward, ForwardState } from "@twigo/protocol";
import { ForwardLine } from "./ForwardLine";

const WORDS: Readonly<Record<string, number>> = {
  Restored: 50.7 + 6,
  Stopped: 47.9 + 6,
  Failed: 33.3 + 6,
};

let room = 0;
const unmeasured = globalThis.ResizeObserver;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly report: ResizeObserverCallback) {}
    observe(target: Element) {
      const width = target.classList.contains("w-max")
        ? (WORDS[target.textContent] ?? 0)
        : room;
      this.report(
        [{ target, contentRect: { width } } as ResizeObserverEntry],
        this,
      );
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  };
});

afterAll(() => {
  globalThis.ResizeObserver = unmeasured;
});

afterEach(cleanup);

function forward(name: string, state: ForwardState): Forward {
  return {
    id: 1,
    target: {
      space: "prod-eu",
      gvr: { group: "apps", version: "v1", resource: "deployments" },
      namespace: "payments",
      name,
    },
    kind: "Deployment",
    port: 8080,
    portName: "http",
    appProtocol: null,
    local: 8081,
    addresses: ["127.0.0.1"],
    state,
    pod: null,
    podPort: null,
    connections: 0,
    queued: 0,
    sent: 0,
    received: 0,
    failure: null,
  };
}

const RESTORED: ForwardState = { state: "restored" };
const STOPPED: ForwardState = { state: "stopped" };
const FAILED: ForwardState = {
  state: "failed",
  error: { kind: "notFound", message: "gone" },
};

function line(words: string, at: number, name: string, state: ForwardState) {
  room = at;
  render(<ForwardLine forward={forward(name, state)} />);
  return screen.getByText(words);
}

test.each<[number, string, number, string, ForwardState, boolean]>([
  [260, "Restored", 46.5, "payments-api", RESTORED, false],
  [260, "Stopped", 0, "payments-gateway", STOPPED, false],
  [260, "Failed", 25, "payments-legacy", FAILED, false],
  [280, "Restored", 66.5, "payments-api", RESTORED, true],
  [280, "Stopped", 13.7, "payments-gateway", STOPPED, false],
  [280, "Failed", 45, "payments-legacy", FAILED, true],
  [300, "Restored", 86.5, "payments-api", RESTORED, true],
  [300, "Stopped", 33.7, "payments-gateway", STOPPED, false],
  [320, "Stopped", 53.7, "payments-gateway", STOPPED, true],
  [320, "Failed", 85, "payments-legacy", FAILED, true],
])(
  "in a side bar %i px wide %s leaves its row %f px: its words show whole or not at all, to the eye and to a screen reader alike",
  (_width, words, left, name, state, expected) => {
    const found = line(words, left, name, state);
    expect(found.getAttribute("aria-hidden") === "true").toBe(!expected);
    expect(found.classList.contains("invisible")).toBe(!expected);
  },
);

test.each<[string, ForwardState]>([
  ["Restored", RESTORED],
  ["Stopped", STOPPED],
  ["Failed", FAILED],
])(
  "where the room is too narrow for %s the dot says it, and where the words show the dot says nothing",
  (words, state) => {
    line(words, 0, "payments-api", state);
    expect(screen.getByRole("img", { name: words })).toBeTruthy();
    cleanup();

    line(words, 200, "payments-api", state);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(words).getAttribute("aria-hidden")).toBeNull();
  },
);

test("a stopped row's dot is a ring and a restored row's is filled, where the words show too", () => {
  const dot = () => document.querySelector(".rounded-full")?.className ?? "";
  line("Stopped", 200, "payments-api", STOPPED);
  expect(dot()).toContain("inset_0_0_0_1.5px_var(--muted-foreground-2)");
  expect(dot()).not.toContain("bg-muted-foreground-2");
  cleanup();
  line("Restored", 200, "payments-api", RESTORED);
  expect(dot()).toContain("bg-muted-foreground-2");
  expect(dot()).not.toContain("inset_0_0_0");
});
