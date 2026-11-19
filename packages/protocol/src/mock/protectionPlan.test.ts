import { expect, test } from "vitest";
import type { ContextAccess, Environment, Mode } from "../generated";
import { MockAccess, type Change, type Kubeconfigs } from "./access";
import { KUBECONFIG_READ_ONLY, KUBECONFIG_TYPES } from "./fixtures";
import { lowering, weigh, words } from "./protectionPlan";

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
    expect(
      lowering("kind-a", from, [{ from, to }]),
      `${from.mode} to ${to.mode}`,
    ).toEqual(expected);
  }
});

const KUBECONFIGS: Kubeconfigs = {
  readOnly: new Set([...KUBECONFIG_READ_ONLY, "qa"]),
  types: { ...KUBECONFIG_TYPES, qa: "production" },
};

const mark = (environment: Environment): Change => ({ environment });
const CLEAR_MODE: Change = { mode: null };
const CLEAR_TYPE: Change = { environment: null };

function asked(access: MockAccess, context: string, change: Change): unknown {
  const { from, to, beneath } = weigh(access, context, change);
  return lowering(context, from, [{ from, to }, ...beneath]);
}

test("a lasting change asks for the name where any set of the locks that can go shows it lowering, as Rust's modes test says", () => {
  const access = new MockAccess(false, KUBECONFIGS);
  access.setMode("prod-eu", "guarded");
  access.setMode("staging", "guarded");
  access.setMode("analytics", "read-only");
  access.setEnvironment("analytics", "development");
  const filed = new MockAccess(true, KUBECONFIGS);
  filed.setEnvironment("prod-eu", "staging");
  const pair = new MockAccess(false, KUBECONFIGS);
  pair.setMode("analytics", null);
  pair.lockByFile("analytics");
  const typed = (context: string) => ({ kind: "typed", text: context });

  const rows: [MockAccess, string, Change, unknown][] = [
    [access, "qa", mark("staging"), typed("qa")],
    [access, "qa", mark("production"), AT_ONCE],
    [access, "prod-eu", CLEAR_MODE, typed("prod-eu")],
    [access, "staging", CLEAR_MODE, typed("staging")],
    [access, "analytics", CLEAR_MODE, typed("analytics")],
    [access, "analytics", mark("local"), AT_ONCE],
    [filed, "prod-eu", CLEAR_TYPE, typed("prod-eu")],
    [filed, "prod-eu", mark("production"), AT_ONCE],
    [pair, "analytics", mark("development"), typed("analytics")],
    [pair, "analytics", mark("production"), AT_ONCE],
  ];
  for (const [from, context, change, expected] of rows) {
    expect(
      asked(from, context, change),
      `${context}: ${JSON.stringify(change)}`,
    ).toEqual(expected);
  }
});

test("a plan names every lock whose absence shows what a change gives, joined by and", () => {
  const access = new MockAccess(false);
  access.setMode("analytics", null);
  access.lockByFile("analytics");
  const change = { environment: "development" } as const;
  const { from, to, beneath } = weigh(access, "analytics", change);
  expect(beneath.map(({ gone }) => gone.map(({ kind }) => kind))).toEqual([
    ["policyFile"],
    ["kubeconfig"],
    ["policyFile", "kubeconfig"],
  ]);
  expect(words("analytics", change, from, to, beneath).consequences).toEqual([
    "It stays read-only by analytics in /Library/Application Support/Twigo/policy.json.",
    "When /Library/Application Support/Twigo/policy.json no longer sets its mode and its kubeconfig's lock goes, it will be read-write.",
  ]);
});

test("a plan names, of the sets of locks whose absence shows what a change gives, the one that leaves the context least strict, and of those the smallest", () => {
  const said = (kubeconfigs: Kubeconfigs, change: Change) => {
    const access = new MockAccess(false, kubeconfigs);
    const { from, to, beneath } = weigh(access, "qa", change);
    return words("qa", change, from, to, beneath).consequences;
  };
  const type = (environment: Environment): Kubeconfigs => ({
    readOnly: new Set(["qa"]),
    types: { qa: environment },
  });
  expect(said(type("production"), mark("development"))).toEqual([
    "It stays read-only as its kubeconfig says.",
    "When its kubeconfig's lock goes, it will be read-write.",
  ]);
  expect(said(type("production"), mark("staging"))).toEqual([
    "It stays read-only as its kubeconfig says.",
    "When its kubeconfig's lock goes, it will be guarded.",
  ]);
  expect(said(type("staging"), CLEAR_MODE)).toEqual([
    "It stays read-only as its kubeconfig says.",
    "When its kubeconfig's lock goes and its kubeconfig's type goes, its first write or exec asks what qa is.",
  ]);
});

test("a plan that asks for the name though it lowers nothing as it is names a set of locks under which it lowers, as Rust's words test says", () => {
  const cleared = (mode: Mode) => {
    const access = new MockAccess(false, {
      readOnly: new Set(["qa"]),
      types: { qa: "staging" },
    });
    access.setMode("qa", mode);
    const { from, to, beneath } = weigh(access, "qa", CLEAR_MODE);
    return words("qa", CLEAR_MODE, from, to, beneath).consequences;
  };
  const asks =
    "When its kubeconfig's lock goes and its kubeconfig's type goes, its first write or exec asks what qa is.";
  expect(cleared("guarded")).toEqual([
    "Every write, exec and shell is refused; reads, dry runs and port-forwards go on.",
    asks,
  ]);
  expect(
    cleared("read-only"),
    "of the sets that leave it guarded, the one that leaves it unmarked",
  ).toEqual(["It stays read-only as its kubeconfig says.", asks]);

  const production = new MockAccess(false, {
    readOnly: new Set(),
    types: { qa: "production" },
  });
  const { from, to, beneath } = weigh(production, "qa", mark("development"));
  expect(
    words("qa", mark("development"), from, to, beneath).consequences.some(
      (said) => said.startsWith("When"),
    ),
    "a change that lowers the context as it is says nothing its type's going would repeat",
  ).toBe(false);

  const file = "/etc/twigo/policy.json";
  const filed: ContextAccess = {
    ...chosen("read-write"),
    source: { kind: "policyFile", file, pattern: "kind-a" },
  };
  const development = typedAs("read-write", "development");
  expect(
    words("kind-a", mark("development"), filed, filed, [
      { gone: [{ kind: "policyFile", file }], from: UNMARKED, to: development },
    ]).consequences,
    "an admin's read-write entry over a context nobody marked, which the mock's policy file never sets",
  ).toEqual([
    `It stays read-write by kind-a in ${file}.`,
    `When ${file} no longer sets its mode, it will be read-write.`,
  ]);
});

test("an unlock's plan says nothing of the locks going, as it ends by itself before any does", () => {
  const access = new MockAccess(false);
  access.setMode("analytics", null);
  const { from, to, beneath } = weigh(access, "analytics", { unlock: true });
  expect(beneath).not.toEqual([]);
  const { consequences } = words(
    "analytics",
    { unlock: true },
    from,
    to,
    beneath,
  );
  expect(consequences.some((said) => said.startsWith("When"))).toBe(false);
});
