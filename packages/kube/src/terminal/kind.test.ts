import { expect, test } from "vitest";
import type { TerminalKind } from "@twigo/protocol";
import { describeKind } from "./kind";

const zsh = (kind: TerminalKind) =>
  ({ kind, shell: "zsh", kubeconfigKept: true }) as const;
const sh = (kind: TerminalKind) =>
  ({ kind, shell: "sh", kubeconfigKept: false }) as const;

test("a terminal with the person's credentials says so, and warns once its context is not read-write", () => {
  const own = zsh({ kind: "kubeconfig" });
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
    describeKind(zsh({ kind: "proxy", why }), "prod-eu", "read-only", []);
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
    describeKind(zsh({ kind: "proxy", why: "mode" }), "prod-eu", undefined, [])
      .short,
  ).toBe("Proxy");
});

test("a terminal through the proxy has no warning in any mode, and offers no Restart", () => {
  for (const mode of ["read-write", "guarded", "read-only"] as const) {
    const words = describeKind(
      zsh({ kind: "proxy", why: "policyFile" }),
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
    zsh({ kind: "proxy", why: "mode" }),
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
    zsh({ kind: "proxy", why: "mode" }),
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

const ARN = "arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu-2";

test("a long direct name is cut in the middle at its own colons and slashes, and the tooltip holds it whole", () => {
  const words = describeKind(
    zsh({ kind: "proxy", why: "mode" }),
    "staging",
    "guarded",
    [ARN],
  );
  expect(words.short).toBe("Proxy · guarded, arn:aws:eks:…/prod-eu-2 direct");
  expect(words.warnings[0]?.title).toBe(
    `${ARN} reaches its cluster with your credentials, not through the proxy.`,
  );
  expect(words.credentials).toBe("proxy");
});

test("a direct name that fits is shown whole, and one with no colon or slash near the middle is cut by its characters", () => {
  const short = (name: string) =>
    describeKind(zsh({ kind: "proxy", why: "mode" }), "staging", "guarded", [
      name,
    ]).short;
  expect(short("prod-eu")).toBe("Proxy · guarded, prod-eu direct");
  expect(short("a".repeat(24))).toBe(
    `Proxy · guarded, ${"a".repeat(24)} direct`,
  );
  const gke = "gke_my-long-project-name-123456_europe-west1-b_production-eu-1";
  expect(short(gke)).toBe("Proxy · guarded, gke_my-long-…uction-eu-1 direct");
  expect(short(`a:${"b".repeat(40)}`)).toBe(
    `Proxy · guarded, a:…${"b".repeat(21)} direct`,
  );
});

test("the name is cut before the not-kept suffix is added, and several contexts still count", () => {
  expect(
    describeKind(sh({ kind: "proxy", why: "mode" }), "staging", "guarded", [
      ARN,
    ]).short,
  ).toBe(
    "Proxy · guarded, arn:aws:eks:…/prod-eu-2 direct, KUBECONFIG not kept",
  );
  expect(
    describeKind(zsh({ kind: "proxy", why: "mode" }), "staging", "guarded", [
      ARN,
      `${ARN}-b`,
    ]).short,
  ).toBe("Proxy · guarded, 2 contexts direct");
});

const NOT_KEPT = "A startup file of sh may replace this terminal's KUBECONFIG.";

test("a proxy terminal in a shell Twigo cannot keep KUBECONFIG in warns that a startup file may replace it, and it could then reach clusters with the person's credentials", () => {
  const words = describeKind(
    sh({ kind: "proxy", why: "mode" }),
    "staging",
    "guarded",
    [],
  );
  expect(words.short).toBe("Proxy · guarded, KUBECONFIG not kept");
  expect(words.warnings).toEqual([
    {
      title: NOT_KEPT,
      detail:
        "Twigo sets KUBECONFIG again after the startup files of zsh, bash, fish and pwsh, not of sh. If one of them sets it, this terminal could reach clusters with your credentials, not through the proxy.",
    },
  ]);
  expect(words.restartable).toBe(false);
});

test("a kubeconfig terminal in such a shell warns that it may no longer be pinned to its context", () => {
  const words = describeKind(
    sh({ kind: "kubeconfig" }),
    "dev",
    "read-write",
    [],
  );
  expect(words.short).toBe("Your credentials, KUBECONFIG not kept");
  expect(words.warnings).toEqual([
    {
      title: NOT_KEPT,
      detail:
        "Twigo sets KUBECONFIG again after the startup files of zsh, bash, fish and pwsh, not of sh. If one of them sets it, this terminal may no longer be pinned to dev.",
    },
  ]);
  expect(words.restartable).toBe(false);
});

test("the shell's warning comes after the others, and only the mode's offers Restart", () => {
  const own = describeKind(sh({ kind: "kubeconfig" }), "dev", "guarded", []);
  expect(own.short).toBe(
    "Your credentials · guarded context, KUBECONFIG not kept",
  );
  expect(own.warnings.map(({ title }) => title)).toEqual([
    "Holds your real credentials, and dev is guarded now.",
    NOT_KEPT,
  ]);
  expect(own.restartable).toBe(true);

  const proxied = describeKind(
    sh({ kind: "proxy", why: "mode" }),
    "staging",
    "guarded",
    ["prod-eu"],
  );
  expect(proxied.short).toBe(
    "Proxy · guarded, prod-eu direct, KUBECONFIG not kept",
  );
  expect(proxied.warnings).toHaveLength(2);
  expect(proxied.restartable).toBe(false);
});
