import { expect, test } from "vitest";
import type { ContextAccess, Environment, Mode } from "../generated";
import { MockAccess } from "./access";
import { lowering, words, type Step } from "./protectionPlan";

const TYPED = { kind: "typed", text: "kind-a" };
const AT_ONCE = { kind: "atOnce" };

const chosen = (
  mode: Mode,
  environment: Environment | null = null,
): ContextAccess => ({
  mode,
  source: { kind: "user", overrides: null },
  environment,
  unlockedUntil: null,
});

const UNMARKED: ContextAccess = {
  mode: "guarded",
  source: { kind: "unmarked" },
  environment: null,
  unlockedUntil: null,
};

const UNLOCKED: ContextAccess = {
  ...chosen("guarded", "production"),
  unlockedUntil: 1,
};

const typedAs = (mode: Mode, environment: Environment): ContextAccess => ({
  mode,
  source: { kind: "environment", environment },
  environment,
  unlockedUntil: null,
});

test("lowering protection asks for the name, as Rust's friction table says", () => {
  const [readWrite, guarded, readOnly] = [
    chosen("read-write"),
    chosen("guarded"),
    chosen("read-only"),
  ] as const;
  const cases: [ContextAccess, ContextAccess, unknown][] = [
    [readOnly, readWrite, TYPED],
    [readOnly, guarded, TYPED],
    [guarded, readWrite, TYPED],
    [readWrite, readOnly, AT_ONCE],
    [readWrite, guarded, AT_ONCE],
    [guarded, guarded, AT_ONCE],
    [readOnly, readOnly, AT_ONCE],
    [UNMARKED, readWrite, AT_ONCE],
    [UNMARKED, readOnly, AT_ONCE],
    [readOnly, UNMARKED, TYPED],
    [guarded, UNMARKED, TYPED],
    [UNLOCKED, UNMARKED, TYPED],
    [readWrite, UNMARKED, AT_ONCE],
    [UNMARKED, UNMARKED, AT_ONCE],
    [UNLOCKED, guarded, TYPED],
    [UNLOCKED, readOnly, AT_ONCE],
  ];
  for (const [from, to, expected] of cases) {
    const step: Step = { from, to };
    expect(
      lowering("kind-a", from, step, step),
      `${from.mode} to ${to.mode}`,
    ).toEqual(expected);
  }
});

test("a change weighs the context as it would be with no lock but the person's choices and its type, as Rust's friction table says", () => {
  const locked: ContextAccess = {
    ...chosen("read-only"),
    source: { kind: "kubeconfig" },
  };
  const held: Step = { from: locked, to: locked };
  const development = typedAs("read-write", "development");
  const staging = typedAs("guarded", "staging");
  const production = typedAs("read-only", "production");
  const cases: [ContextAccess, ContextAccess, unknown][] = [
    [UNMARKED, development, TYPED],
    [UNMARKED, staging, AT_ONCE],
    [UNMARKED, production, AT_ONCE],
    [UNMARKED, UNMARKED, AT_ONCE],
    [production, development, TYPED],
    [production, staging, TYPED],
    [production, UNMARKED, TYPED],
    [staging, UNMARKED, TYPED],
    [staging, production, AT_ONCE],
    [development, UNMARKED, AT_ONCE],
  ];
  for (const [from, to, expected] of cases) {
    expect(
      lowering("kind-a", locked, held, { from, to }),
      `${from.mode} to ${to.mode} beneath the lock`,
    ).toEqual(expected);
  }
  const guarded = chosen("guarded");
  expect(
    lowering(
      "kind-a",
      locked,
      { from: locked, to: guarded },
      { from: UNMARKED, to: guarded },
    ),
  ).toEqual(TYPED);
});

test("a plan names every lock that hides what a type gives, joined by and", () => {
  const access = new MockAccess(false);
  access.lockByFile("analytics");
  const locks = access.locks("analytics");
  expect(locks).toEqual([
    {
      kind: "policyFile",
      file: "/Library/Application Support/Twigo/policy.json",
    },
    { kind: "kubeconfig" },
  ]);
  const change = { environment: "development" } as const;
  const { consequences } = words(
    "analytics",
    change,
    access.of("analytics"),
    access.would("analytics", change),
    {
      locks,
      from: access.bare("analytics"),
      to: access.bare("analytics", change),
    },
  );
  expect(consequences).toEqual([
    "It stays read-only by analytics in /Library/Application Support/Twigo/policy.json.",
    "When /Library/Application Support/Twigo/policy.json no longer sets its mode and its kubeconfig's lock goes, it will be read-write.",
  ]);
});
