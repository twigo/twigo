import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { KindChip } from "./KindChip";
import { describeKind } from "./kind";

afterEach(cleanup);

const ARN = "arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu-2";

const LONG = {
  "a warning of a context that is not read-write": describeKind(
    { kind: { kind: "kubeconfig" }, shell: "zsh", kubeconfigKept: true },
    "dev",
    "read-only",
    [],
  ),
  "a proxy file with a context a tool wrote, in a shell that loses KUBECONFIG":
    describeKind(
      {
        kind: { kind: "proxy", why: "mode" },
        shell: "sh",
        kubeconfigKept: false,
      },
      "staging",
      "guarded",
      [ARN],
    ),
};

test.each(Object.entries(LONG))(
  "the chip of %s takes its words' own width with no minimum, so it gives way before the tabs and its words are cut by an ellipsis",
  (_, words) => {
    render(<KindChip words={words} />);
    const chip = screen.getByRole("button");
    expect(chip.className).not.toMatch(/(^| )max-w-/);
    const label = screen.getByText(words.short);
    expect(label.className).toContain("truncate");
    expect(label.parentElement?.className).toContain(
      "grid-cols-[minmax(0,max-content)]",
    );
    expect(label.textContent).toBe(words.short);
  },
);
