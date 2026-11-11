import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { describeKind } from "./kind";
import { KindTip } from "./KindIcon";

afterEach(cleanup);

const ARN = "arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu-2";

function lines(words: ReturnType<typeof describeKind>): (string | null)[] {
  const { container } = render(<KindTip words={words} />);
  return [...(container.firstElementChild?.children ?? [])].flatMap((note) =>
    [...note.children].map((line) => line.textContent),
  );
}

test("the tooltip says what the person gets and why, then each warning", () => {
  const proxied = describeKind(
    {
      kind: { kind: "proxy", why: "mode" },
      shell: "sh",
      kubeconfigKept: false,
    },
    "staging",
    "guarded",
    [ARN],
  );
  expect(proxied.warnings).toHaveLength(2);
  expect(proxied.why).toContain("Through Twigo's proxy");
  expect(lines(proxied)).toEqual([
    proxied.short,
    proxied.why,
    ...proxied.warnings.flatMap(({ title, detail }) => [title, detail]),
  ]);
  cleanup();

  const own = describeKind(
    { kind: { kind: "kubeconfig" }, shell: "sh", kubeconfigKept: false },
    "dev",
    "guarded",
    [],
  );
  expect(own.warnings).toHaveLength(2);
  expect(own.why).toContain("With your own credentials");
  expect(lines(own)).toEqual([
    own.short,
    own.why,
    ...own.warnings.flatMap(({ title, detail }) => [title, detail]),
  ]);
});

test("a terminal with no warning says its kind and why alone", () => {
  const words = describeKind(
    { kind: { kind: "kubeconfig" }, shell: "zsh", kubeconfigKept: true },
    "dev",
    "read-write",
    [],
  );
  expect(lines(words)).toEqual([words.short, words.why]);
});
