import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ApprovalDetail } from "@twigo/protocol";
import { RequestDetail } from "./RequestDetail";

const shown = vi.hoisted(() => ({
  views: [] as {
    original: string;
    modified: string;
    collapseUnchanged?: boolean;
  }[],
}));

vi.mock("../edit/DiffView", () => ({
  default: (props: {
    original: string;
    modified: string;
    collapseUnchanged?: boolean;
  }) => {
    shown.views.push(props);
    return <div data-testid="diff" />;
  },
}));

afterEach(() => {
  cleanup();
  shown.views.length = 0;
});

const draw = (detail: ApprovalDetail) =>
  render(<RequestDetail detail={detail} />);

test("a diff sets the live object's YAML against the dry run's, with what the server warned", async () => {
  draw({
    kind: "diff",
    live: { kind: "ConfigMap", data: { mode: "fast" } },
    result: { kind: "ConfigMap", data: { mode: "slow" } },
    warnings: ["a warning of the server"],
  });
  await waitFor(() => {
    expect(screen.getByTestId("diff")).toBeTruthy();
  });
  expect(shown.views[shown.views.length - 1]).toEqual({
    original: "kind: ConfigMap\ndata:\n  mode: fast\n",
    modified: "kind: ConfigMap\ndata:\n  mode: slow\n",
    collapseUnchanged: true,
  });
  expect(screen.getByText("Live")).toBeTruthy();
  expect(screen.getByText("the result of a dry run")).toBeTruthy();
  expect(screen.getByText("The server warns")).toBeTruthy();
  expect(screen.getByText("a warning of the server")).toBeTruthy();
});

test("a create has no live object, and no warning means no callout", async () => {
  draw({
    kind: "diff",
    live: null,
    result: { kind: "ConfigMap" },
    warnings: [],
  });
  await waitFor(() => {
    expect(screen.getByTestId("diff")).toBeTruthy();
  });
  expect(shown.views[shown.views.length - 1]?.original).toBe("");
  expect(screen.getByText("Not on the cluster yet")).toBeTruthy();
  expect(screen.queryByText("Live")).toBeNull();
  expect(screen.queryByText("The server warns")).toBeNull();
});

test("a session shows the command line and container, and whether it takes input", () => {
  draw({
    kind: "session",
    container: "app",
    command: ["sh", "-c", "tail -n 50 app.log"],
    tty: true,
    stdin: true,
  });
  expect(screen.getByText("sh -c 'tail -n 50 app.log'")).toBeTruthy();
  expect(screen.getByText("app")).toBeTruthy();
  expect(screen.getByText("What is typed, in a terminal.")).toBeTruthy();
  cleanup();

  draw({
    kind: "session",
    container: null,
    command: [],
    tty: false,
    stdin: false,
  });
  expect(
    screen.getByText("The process the container already runs."),
  ).toBeTruthy();
  expect(screen.getByText("The pod's default container.")).toBeTruthy();
  expect(screen.getByText("None: it only shows output.")).toBeTruthy();
});

test("a delete is a sentence with its propagation", () => {
  draw({ kind: "delete", propagation: "Orphan" });
  expect(
    screen.getByText("The object goes and its dependents are left behind."),
  ).toBeTruthy();
});

test("an unknown detail says why, and shows the body as code only when it comes", () => {
  draw({
    kind: "unknown",
    reason: { reason: "refused", message: "webhook does not support dry run" },
    body: '{"spec":{"replicas":5}}',
  });
  expect(screen.getByText("Twigo cannot show what this changes.")).toBeTruthy();
  expect(
    screen.getByText(
      "The server refused the dry run: webhook does not support dry run",
    ),
  ).toBeTruthy();
  const body = screen.getByText('{"spec":{"replicas":5}}');
  expect(body.tagName).toBe("PRE");
  expect(screen.getByRole("region", { name: "Request body" })).toBeTruthy();
  cleanup();

  draw({ kind: "unknown", reason: { reason: "aggregated" }, body: null });
  expect(screen.getByText(/aggregated API server serves it/)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Request body" })).toBeNull();
});
