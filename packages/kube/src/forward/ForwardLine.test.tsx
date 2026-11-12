import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import type { Forward, ForwardState } from "@twigo/protocol";
import { ForwardLine } from "./ForwardLine";

const WORDS: Readonly<Record<string, number>> = {
  Restored: 50.7,
  Stopped: 47.9,
  Failed: 33.3,
};

let room = 0;
const unmeasured = globalThis.ResizeObserver;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly report: ResizeObserverCallback) {}
    observe(target: Element) {
      const width = target.firstElementChild
        ? room
        : (WORDS[target.textContent] ?? 0);
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

function shown(words: string, at: number, name: string, state: ForwardState) {
  room = at;
  render(<ForwardLine forward={forward(name, state)} />);
  const found = screen.getByText(words);
  return (
    found.getAttribute("aria-hidden") === null &&
    !found.classList.contains("invisible")
  );
}

test.each<[number, string, number, string, ForwardState, boolean]>([
  [260, "Restored", 8.5, "payments-api", RESTORED, false],
  [270, "Restored", 18.5, "payments-api", RESTORED, false],
  [280, "Restored", 28.5, "payments-api", RESTORED, false],
  [300, "Restored", 48.5, "payments-api", RESTORED, false],
  [320, "Restored", 68.5, "payments-api", RESTORED, true],
  [260, "Stopped", 0, "payments-gateway", STOPPED, false],
  [320, "Stopped", 15.7, "payments-gateway", STOPPED, false],
  [280, "Failed", 7, "payments-legacy", FAILED, false],
  [300, "Failed", 27, "payments-legacy", FAILED, false],
  [320, "Failed", 47, "payments-legacy", FAILED, true],
])(
  "in a side bar %i px wide %s leaves its row %f px: its words show whole or not at all",
  (_width, words, left, name, state, expected) => {
    expect(shown(words, left, name, state)).toBe(expected);
  },
);
