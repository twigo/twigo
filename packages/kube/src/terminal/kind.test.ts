import { expect, test } from "vitest";
import { describeKind } from "./kind";

test("a terminal with the person's credentials says so, and warns once its context is not read-write", () => {
  const own = { kind: "kubeconfig" } as const;
  expect(describeKind(own, "dev", "read-write", [])).toMatchObject({
    credentials: "own",
    short: "Your credentials",
    warnings: [],
    restartable: false,
  });
  expect(describeKind(own, "dev", undefined, []).warnings).toEqual([]);
  for (const mode of ["guarded", "read-only"] as const) {
    const words = describeKind(own, "dev", mode, []);
    expect(words.short).toBe(`Your credentials · ${mode} context`);
    expect(words.warnings).toHaveLength(1);
    expect(words.warnings[0]?.title).toBe(
      `Holds your real credentials, and dev is ${mode} now.`,
    );
    expect(words.warnings[0]?.detail).toContain(
      "Restart goes through Twigo's proxy",
    );
    expect(words.restartable).toBe(true);
  }
});

test("a terminal through the proxy says the context's mode now, and what made it so", () => {
  const words = (why: "mode" | "provider" | "policyFile") =>
    describeKind({ kind: "proxy", why }, "prod-eu", "read-only", []);
  expect(words("mode")).toMatchObject({
    credentials: "proxy",
    short: "Proxy · read-only",
    warnings: [],
  });
  expect(words("mode").why).toContain(
    "prod-eu was not read-write when this terminal started.",
  );
  expect(words("provider").why).toContain("prod-eu comes from a provider");
  expect(words("policyFile").why).toContain(
    "Your administrator's policy file sends prod-eu through the proxy.",
  );
  expect(
    describeKind({ kind: "proxy", why: "mode" }, "prod-eu", undefined, [])
      .short,
  ).toBe("Proxy");
});

test("a terminal through the proxy has no warning in any mode, and offers no Restart", () => {
  for (const mode of ["read-write", "guarded", "read-only"] as const) {
    const words = describeKind(
      { kind: "proxy", why: "policyFile" },
      "dev",
      mode,
      [],
    );
    expect(words.warnings).toEqual([]);
    expect(words.restartable).toBe(false);
  }
});

test("a proxy terminal whose file a tool wrote a context into names it in the chip, with a warning that says what it means", () => {
  const words = describeKind(
    { kind: "proxy", why: "mode" },
    "staging",
    "guarded",
    ["prod-eu"],
  );
  expect(words.short).toBe("Proxy · guarded, prod-eu direct");
  expect(words.credentials).toBe("proxy");
  expect(words.warnings).toEqual([
    {
      title:
        "prod-eu reaches its cluster with your credentials, not through the proxy.",
      detail:
        "A tool wrote it into this terminal's own kubeconfig. Everything else here still goes through Twigo's proxy, and kubectl config use-context back to a proxy context goes through it again.",
    },
  ]);
  expect(words.restartable).toBe(false);
});

test("several direct contexts are counted in the chip and named in the warning", () => {
  const words = describeKind(
    { kind: "proxy", why: "mode" },
    "staging",
    "read-only",
    ["a", "b", "c"],
  );
  expect(words.short).toBe("Proxy · read-only, 3 contexts direct");
  expect(words.warnings[0]?.title).toBe(
    "3 contexts reach their clusters with your credentials, not through the proxy.",
  );
  expect(words.warnings[0]?.detail).toContain(
    "A tool wrote them into this terminal's own kubeconfig: a, b, c.",
  );
});
