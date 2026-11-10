import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ApprovalDetail } from "@twigo/protocol";
import { ConfirmDialog } from "@twigo/ui";
import { RequestDetail } from "./RequestDetail";

const shown = vi.hoisted(() => ({
  views: [] as {
    original: string;
    modified: string;
    collapseUnchanged?: boolean;
    maxHeight?: number;
  }[],
}));

vi.mock("../edit/DiffView", () => ({
  default: (props: {
    original: string;
    modified: string;
    collapseUnchanged?: boolean;
    maxHeight?: number;
  }) => {
    shown.views.push(props);
    return (
      <div data-testid="diff">
        <textarea aria-label="Editor input" />
      </div>
    );
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
    maxHeight: 300,
  });
  expect(screen.queryByText(/values are hidden/)).toBeNull();
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

test("a Secret's diff says its values are masked, whichever side is a Secret", async () => {
  const secret = { apiVersion: "v1", kind: "Secret", data: { a: "<3 bytes>" } };
  draw({ kind: "diff", live: null, result: secret, warnings: [] });
  await waitFor(() => {
    expect(screen.getByTestId("diff")).toBeTruthy();
  });
  expect(
    screen.getByText(
      "A Secret's values are hidden, as their sizes: values of the same size may still differ.",
    ),
  ).toBeTruthy();
  cleanup();

  draw({
    kind: "diff",
    live: secret,
    result: { ...secret, data: { a: "<4 bytes>" } },
    warnings: [],
  });
  expect(
    screen.getByText(/values of the same size may still differ/),
  ).toBeTruthy();
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

test("a delete is a sentence with its propagation, and one that sets none, as clients other than kubectl send it, has its own", () => {
  draw({ kind: "delete", propagation: "Background" });
  expect(
    screen.getByText(
      "The object goes at once, and the garbage collector deletes its dependents after.",
    ),
  ).toBeTruthy();
  cleanup();

  draw({ kind: "delete", propagation: "Orphan" });
  expect(
    screen.getByText("The object goes and its dependents are left behind."),
  ).toBeTruthy();
  cleanup();

  draw({ kind: "delete", propagation: null });
  expect(
    screen.getByText(/^The request sets no propagation, so /),
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

test("Escape pressed in the diff editor is the editor's, and denies nothing", async () => {
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      question="Allow Terminal 2 to patch deployments/web?"
      consequences={[]}
      cancel="Deny"
      choices={[{ label: "Allow once", onSelect: vi.fn() }]}
      onCancel={onCancel}
    >
      <RequestDetail
        detail={{
          kind: "diff",
          live: { kind: "ConfigMap" },
          result: { kind: "ConfigMap" },
          warnings: [],
        }}
      />
    </ConfirmDialog>,
  );
  fireEvent.keyDown(await screen.findByLabelText("Editor input"), {
    key: "Escape",
  });
  expect(onCancel).not.toHaveBeenCalled();

  fireEvent.keyDown(screen.getByRole("button", { name: /Deny/ }), {
    key: "Escape",
  });
  expect(onCancel).toHaveBeenCalledOnce();
});
