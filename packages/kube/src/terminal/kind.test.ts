import { expect, test } from "vitest";
import { describeKind } from "./kind";

test("a terminal with the person's credentials says so, and warns once its context is not read-write", () => {
  const own = { kind: "kubeconfig" } as const;
  expect(describeKind(own, "dev", "read-write")).toMatchObject({
    credentials: "own",
    short: "Your credentials",
    warning: undefined,
  });
  expect(describeKind(own, "dev", undefined).warning).toBeUndefined();
  for (const mode of ["guarded", "read-only"] as const) {
    const words = describeKind(own, "dev", mode);
    expect(words.short).toBe(`Your credentials · ${mode} context`);
    expect(words.warning?.title).toBe(
      `Holds your real credentials, and dev is ${mode} now.`,
    );
    expect(words.warning?.detail).toContain(
      "Restart goes through Twigo's proxy",
    );
  }
});

test("a terminal through the proxy says the context's mode now, and what made it so", () => {
  const words = (why: "mode" | "provider" | "policyFile") =>
    describeKind({ kind: "proxy", why }, "prod-eu", "read-only");
  expect(words("mode")).toMatchObject({
    credentials: "proxy",
    short: "Proxy · read-only",
    warning: undefined,
  });
  expect(words("mode").why).toContain(
    "prod-eu was not read-write when this terminal started.",
  );
  expect(words("provider").why).toContain("prod-eu comes from a provider");
  expect(words("policyFile").why).toContain(
    "Your administrator's policy file sends prod-eu through the proxy.",
  );
  expect(
    describeKind({ kind: "proxy", why: "mode" }, "prod-eu", undefined).short,
  ).toBe("Proxy");
});

test("a terminal through the proxy has no warning in any mode", () => {
  for (const mode of ["read-write", "guarded", "read-only"] as const) {
    expect(
      describeKind({ kind: "proxy", why: "policyFile" }, "dev", mode).warning,
    ).toBeUndefined();
  }
});
