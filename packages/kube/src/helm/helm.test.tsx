import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";
import { helmUri } from "../uri";
import { helmCommand } from "./commands";
import { isQuiet, statusTone } from "./status";
import { ReleaseStates } from "./states";

withScreenSize(1280);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const rows = () => screen.getAllByRole("row").slice(1);
const cellOf = (row: HTMLElement | undefined, column: string) =>
  row?.querySelector(`[data-column="${column}"]`)?.textContent ?? "";
const rowOf = (name: string, namespace: string) => {
  const found = rows().find(
    (row) =>
      cellOf(row, "Name") === name && cellOf(row, "Namespace") === namespace,
  );
  if (!found) throw new Error(`no row ${namespace}/${name}`);
  return found;
};

test("the list draws each release as a row of Helm's columns, and says why one cannot be read in place of its status", async () => {
  await openList(createMockBackend("ready"), "helm-list://prod-eu");
  const headers = screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent);
  expect(headers).toEqual(
    expect.arrayContaining([
      "Name",
      "Namespace",
      "Revision",
      "Status",
      "Chart",
      "App Version",
      "Updated",
    ]),
  );
  expect(headers).not.toContain("Problem");
  expect(rows()).toHaveLength(6);
  const alpha = rowOf("alpha", "payments");
  expect(cellOf(alpha, "Revision")).toBe("2");
  expect(cellOf(alpha, "Status")).toBe("deployed");
  expect(cellOf(alpha, "Chart")).toBe("demo-0.1.0");
  expect(cellOf(rowOf("epsilon", "payments"), "Status")).toBe("failed");
  const unreadable = cellOf(rowOf("trunc", "auth"), "Status");
  expect(unreadable).toBe("Truncated");
  expect(document.body.textContent).not.toContain("helm.truncated");
});

test("a release that cannot be read counts as failing in the health filter and the status bar, and its filter shows it", async () => {
  await openList(createMockBackend("ready"), "helm-list://prod-eu");
  const health = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}`) });
  expect(health("Failing").textContent).toBe("Failing2");
  expect(health("Healthy").textContent).toBe("Healthy3");
  expect(screen.getByText("2 failing")).toBeTruthy();
  fireEvent.click(health("Failing"));
  await settle(4);
  expect(
    rows()
      .map((row) => cellOf(row, "Name"))
      .sort(),
  ).toEqual(["epsilon", "trunc"]);
});

test("a refused list names the Secrets Helm keeps its releases in, and offers to choose namespaces", async () => {
  await openList(createMockBackend("forbidden"), "helm-list://prod-eu");
  expect(document.body.textContent).toContain(
    "These credentials may not list Secrets in every namespace at once, which Helm keeps its releases in.",
  );
  expect(
    screen.getByRole("button", { name: "Choose namespaces" }),
  ).toBeTruthy();
});

test("a release's page says what Helm wrote of a failed revision, whole only after a Reveal that Hide takes back", async () => {
  const workbench = await mountKube(createMockBackend("ready"));
  act(() => {
    workbench.editors.open(
      helmUri({ space: "prod-eu", namespace: "payments", name: "epsilon" }),
    );
  });
  await settle(8);
  expect(
    screen.getByRole("region", { name: "Helm release epsilon" }),
  ).toBeTruthy();
  expect(document.body.textContent).toContain("Revision 2 failed");
  expect(document.body.textContent).toContain("<hidden>");
  expect(document.body.textContent).not.toContain("ZXBzaWxvbi1w");

  fireEvent.click(
    screen.getByRole("button", { name: "Reveal what Helm wrote" }),
  );
  await settle(3);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain(
    "Reveal the description of release epsilon (revision 2) in payments from prod-eu?",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
  await settle(4);
  expect(document.body.textContent).toContain("ZXBzaWxvbi1w");
  expect(document.body.textContent).not.toContain("<hidden>");

  fireEvent.click(screen.getByRole("button", { name: "Hide what Helm wrote" }));
  await settle(2);
  expect(document.body.textContent).not.toContain("ZXBzaWxvbi1w");
  expect(document.body.textContent).toContain("<hidden>");
});

test("a revision Helm no longer keeps says so, and offers the latest", async () => {
  const workbench = await mountKube(createMockBackend("ready"));
  act(() => {
    workbench.editors.open(
      helmUri({
        space: "prod-eu",
        namespace: "payments",
        name: "alpha",
        revision: 9,
      }),
    );
  });
  await settle(8);
  expect(document.body.textContent).toContain("Revision 9 is no longer kept");
  expect(screen.getByRole("button", { name: "Open revision 2" })).toBeTruthy();
});

test("a status is healthy, quiet, waiting or failing as Helm's words say, and a word Helm does not know warns", () => {
  expect(statusTone("deployed")).toBeUndefined();
  expect(statusTone("superseded")).toBeUndefined();
  expect(isQuiet("superseded")).toBe(true);
  expect(isQuiet("uninstalled")).toBe(true);
  expect(isQuiet("deployed")).toBe(false);
  expect(statusTone("failed")).toBe("error");
  expect(statusTone("unreadable")).toBe("error");
  for (const word of [
    "pending-install",
    "pending-upgrade",
    "pending-rollback",
    "uninstalling",
    "unknown",
    "something-new",
  ]) {
    expect(statusTone(word)).toBe("warn");
  }
});

test("what a person revealed or marked belongs to one epoch of a view, and goes with another, with the page leaving it, with the editor's close, or with Hide", () => {
  const states = new ReleaseStates();
  const part = { kind: "notes" } as const;
  const answer = { part, value: "secret", binary: false };
  states.reveal("helm://a", 2, answer);
  expect([...states.shown("helm://a", 2).values()]).toEqual([answer]);
  expect(states.shown("helm://a", 3).size).toBe(0);
  expect(states.shown("helm://b", 2).size).toBe(0);
  states.hide("helm://a", 2, [JSON.stringify(part)]);
  expect(states.shown("helm://a", 2).size).toBe(0);

  states.reveal("helm://a", 2, answer);
  states.leave("helm://a", 2);
  expect(states.shown("helm://a", 2).size).toBe(0);
  states.reveal("helm://a", 2, answer);
  states.leave("helm://a", 3);
  expect(states.shown("helm://a", 2).size).toBe(1);
  states.closed("helm://a");
  expect(states.shown("helm://a", 2).size).toBe(0);

  states.mark("helm://a", 2, [1, 2], true);
  expect([...states.marks("helm://a", 2)]).toEqual([1, 2]);
  expect(states.marks("helm://a", 3).size).toBe(0);
  states.leave("helm://a", 2);
  expect(states.marks("helm://a", 2).size).toBe(0);
});

test("Copy helm Command prints what helm prints for the view shown, with the context and the namespace", () => {
  const release = { space: "prod-eu", namespace: "payments", name: "api" };
  const at = (tab: string, revision?: number) =>
    helmCommand(release, "prod-eu", tab, revision);
  expect(at("overview")).toBe(
    "helm status api --namespace payments --kube-context prod-eu",
  );
  expect(at("values", 4)).toBe(
    "helm get values api --namespace payments --kube-context prod-eu --revision 4",
  );
  expect(at("manifest", 4)).toContain("helm get manifest api");
  expect(at("page", 4)).toContain("helm get all api");
  expect(at("history", 4)).toBe(
    "helm history api --namespace payments --kube-context prod-eu",
  );
});
