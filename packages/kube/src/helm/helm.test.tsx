import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { GitCompare, History } from "lucide-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, Column, ListBatch } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";
import { diffUri, helmUri } from "../uri";
import { helmCommand, printsCommand } from "./commands";
import { isQuiet, statusTone } from "./status";
import { ReleaseStates } from "./states";

vi.mock("../edit/DiffView", () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="diff" data-original={original} data-modified={modified} />
  ),
}));

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

test("a pending status is cut at its last dash where its column narrows: the tail stays whole, and the word is in its tooltip", async () => {
  await openList(createMockBackend("ready"), "helm-list://prod-eu");
  const word = within(rowOf("stuck", "auth")).getByTitle("pending-upgrade");
  const [head, tail] = [...word.children];
  expect(head?.textContent).toBe("pending-");
  expect(head?.className).toContain("truncate");
  expect(tail?.textContent).toBe("upgrade");
  expect(tail?.className).toContain("shrink-0");
});

function failingRequests(...names: readonly string[]): Backend {
  const mock = createMockBackend("ready");
  let columns: readonly Column[] = [];
  return {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: ((
      command: string,
      request: never,
      onMessage: (message: unknown) => void,
    ) => {
      if (command !== "helm_list_subscribe") {
        return mock.subscribe(command as never, request, onMessage);
      }
      return mock.subscribe(command as never, request, (batch: ListBatch) => {
        if (batch.columns) columns = batch.columns;
        const at = columns.findIndex((column) => column.name === "Problem");
        onMessage({
          ...batch,
          upserts: batch.upserts.map((row) =>
            names.some((name) => row.id.endsWith(`/${name}`))
              ? {
                  ...row,
                  cells: row.cells.map((cell, index) =>
                    index === at ? "server.forbidden" : cell,
                  ),
                }
              : row,
          ),
        });
      });
    }) as Backend["subscribe"],
  };
}

test("a release whose request failed keeps the label's status and tone, with a mark that says the request failed", async () => {
  await openList(
    failingRequests("payments/alpha", "payments/epsilon"),
    "helm-list://prod-eu",
  );
  for (const [name, status] of [
    ["alpha", "deployed"],
    ["epsilon", "failed"],
  ] as const) {
    const row = rowOf(name, "payments");
    expect(cellOf(row, "Status")).toBe(status);
    const mark = within(row).getByRole("img", {
      name: "Could not fetch this release's latest revision",
    });
    expect(mark.closest('[data-column="Status"]')).not.toBeNull();
    expect(mark.parentElement?.title).toContain(
      "could not fetch this release's latest revision (server.forbidden)",
    );
  }
  expect(rowOf("alpha", "payments").dataset.tone).toBeUndefined();
  expect(rowOf("epsilon", "payments").dataset.tone).toBe("error");
});

test("a release that cannot be read counts as failing in the health filter and the status bar, and its filter shows it", async () => {
  await openList(createMockBackend("ready"), "helm-list://prod-eu");
  const health = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}`) });
  expect(health("Failing").textContent).toBe("Failing2");
  expect(health("Healthy").textContent).toBe("Healthy3");
  expect(screen.getByText("2 failing")).toBeTruthy();
  expect(screen.getByText("6 Helm releases")).toBeTruthy();
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
    screen.getByRole("button", { name: "Reveal the description" }),
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

  fireEvent.click(screen.getByRole("button", { name: "Hide the description" }));
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

test("what a person revealed belongs to one epoch of a view and goes with another, with the page leaving it, with the editor's close or with Hide, and History's marks belong to one life of the release", () => {
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

  states.mark("helm://a", 7, [1, 2], true);
  expect([...states.marks("helm://a", 7)]).toEqual([1, 2]);
  expect(states.marks("helm://a", 8).size).toBe(0);
  states.leave("helm://a", 7);
  expect([...states.marks("helm://a", 7)]).toEqual([1, 2]);
  states.closed("helm://a");
  expect(states.marks("helm://a", 7).size).toBe(0);
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
  expect(at("history", 4)).toBe(
    "helm history api --namespace payments --kube-context prod-eu",
  );
});

test("no command is copied for a view that none prints: the chart's defaults", () => {
  const release = { space: "prod-eu", namespace: "payments", name: "api" };
  expect(helmCommand(release, "prod-eu", "defaults", 4)).toBeUndefined();
  expect(printsCommand("defaults")).toBe(false);
  expect(printsCommand("values")).toBe(true);
});

async function compared(from: number, to: number) {
  const workbench = await mountKube(createMockBackend("ready"));
  act(() => {
    workbench.editors.open(
      diffUri({
        kind: "release",
        release: { space: "prod-eu", namespace: "payments", name: "alpha" },
        from,
        to,
        part: "values",
      }),
    );
  });
  await settle(6);
  const diff = screen.getByTestId("diff");
  const sides = {
    left: diff.dataset.original ?? "",
    right: diff.dataset.modified ?? "",
    said: document.body.textContent,
  };
  cleanup();
  return sides;
}

test("a comparison says that a value that changed reads before in the older revision and after in the newer, whichever it is asked first", async () => {
  const straight = await compared(1, 2);
  expect(straight.said).toContain(
    "A value that changed reads “before” in the older revision and “after” in the newer.",
  );
  expect(straight.left).toContain("password: <16 bytes, before>");
  expect(straight.right).toContain("password: <16 bytes, after>");
  const reversed = await compared(2, 1);
  expect(reversed.left).toContain("password: <16 bytes, after>");
  expect(reversed.right).toContain("password: <16 bytes, before>");
});

test("a comparison of two revisions asks the core once, however often the editor area draws again", async () => {
  const mock = createMockBackend("ready");
  let compares = 0;
  const backend: Backend = {
    invoke: (command: string, request: never) => {
      if (command === "helm_compare") compares++;
      return mock.invoke(command as never, request);
    },
    subscribe: mock.subscribe.bind(mock),
  };
  const workbench = await mountKube(backend);
  const diff = diffUri({
    kind: "release",
    release: { space: "prod-eu", namespace: "payments", name: "alpha" },
    from: 1,
    to: 2,
    part: "values",
  });
  act(() => {
    workbench.editors.open(diff);
  });
  await settle(6);
  expect(compares).toBe(1);
  for (const other of ["helm-list://prod-eu", "k8s-list://prod-eu/v1/pods"]) {
    act(() => {
      workbench.editors.open(other, { preview: false });
    });
    await settle(6);
    act(() => {
      workbench.editors.open(diff);
    });
    await settle(6);
  }
  expect(compares).toBe(1);
});

test("the commands that compare revisions take the compare icon, and the one that opens a revision History's", async () => {
  const { commands } = await mountKube(createMockBackend("ready"));
  for (const id of [
    "helm.revision.compareWithPrevious",
    "helm.revision.compareWithCurrent",
    "helm.revisions.values",
    "helm.revisions.defaults",
    "helm.revisions.manifest",
  ]) {
    expect(commands.get(id)?.icon).toBe(GitCompare);
  }
  expect(commands.get("helm.revision.open")?.icon).toBe(History);
});
