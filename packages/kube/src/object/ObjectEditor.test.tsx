import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Backend,
  ObjectBatch,
  ObjectParts,
  Overview,
  RequestOf,
  Span,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import type { Workbench } from "@twigo/workbench";
import { Cluster } from "../../../protocol/src/mock/cluster";
import { podGenerated } from "../../../protocol/src/mock/kinds";
import { ROLLOUT_STUCK } from "../../test/object";
import {
  mountKube,
  narrowHeaderCopies,
  settle,
  withScreenSize,
} from "../../test/workbench";

vi.mock("../edit/YamlEditor", () => ({ default: () => <div /> }));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const DEPLOYMENT = "k8s://prod-eu/apps/v1/deployments/payments/payments-api";
const POD = "k8s://prod-eu//v1/pods/payments/payments-api-7f9c8d6b5-h8lbx";

async function openEditor(
  uri: string,
  backend: Backend = createMockBackend("ready"),
): Promise<Workbench> {
  const workbench = await mountKube(backend);
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(12);
  return workbench;
}

const page = (kind: string) =>
  screen.getByRole("region", { name: new RegExp(`^${kind} `) });
const FULL_VERBS = ["Logs", "Forward", "Restart", "Scale…", "Delete"];
const INSPECTOR_VERBS = ["Logs", "Restart", "Scale…", "More"];
const strip = () =>
  document.querySelector<HTMLElement>('dl[aria-label="Vitals"]');
const containerCards = () =>
  document.querySelector('[data-section="core.containers"] .relative.grid');
const row = (kind: string) =>
  screen.getByRole("toolbar", { name: `${kind} actions` });
const verbs = (kind: string) =>
  within(row(kind))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
const sectionButton = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[data-section="${id}"] button[aria-expanded]`,
  );
  if (!found) throw new Error(`no section ${id}`);
  return found;
};

describe("from 900 px of the editor's own width", () => {
  const layout = withScreenSize(899);

  test("the editor draws the inspector's layout under 900 px, the full page from 900, and goes back only under 884", async () => {
    await openEditor(DEPLOYMENT);
    const editor = page("Deployment");
    expect(verbs("Deployment")).toEqual(INSPECTOR_VERBS);

    layout.resize(editor, 900);
    expect(verbs("Deployment")).toEqual(FULL_VERBS);

    layout.resize(editor, 884);
    expect(verbs("Deployment")).toEqual(FULL_VERBS);
    layout.resize(editor, 883);
    expect(verbs("Deployment")).toEqual(INSPECTOR_VERBS);
    layout.resize(editor, 899);
    expect(verbs("Deployment")).toEqual(INSPECTOR_VERBS);
    layout.resize(editor, 900);
    expect(verbs("Deployment")).toEqual(FULL_VERBS);
  });

  test("a tab that is hidden keeps the stage it held, and shows it again where it was", async () => {
    await openEditor(DEPLOYMENT);
    const editor = page("Deployment");
    layout.resize(editor, 900);
    expect(verbs("Deployment")).toEqual(FULL_VERBS);
    layout.resize(editor, 0);
    expect(verbs("Deployment")).toEqual(FULL_VERBS);
    layout.resize(editor, 890);
    expect(verbs("Deployment")).toEqual(FULL_VERBS);
  });

  test("the editor cuts a pod's name as the list does, its generated part from the object's header", async () => {
    const generated = new Cluster("prod-eu", 5000, Date.now()).pods
      .map((pod) => ({ pod, at: podGenerated(pod) }))
      .find(({ pod, at }) => at !== null && pod.name.length > at);
    if (!generated) throw new Error("prod-eu has a pod with a generated name");
    const { pod, at } = generated;
    await openEditor(`k8s://prod-eu//v1/pods/${pod.namespace}/${pod.name}`);
    narrowHeaderCopies(layout, page("Pod"));
    const name = within(page("Pod")).getByRole("heading");
    expect(name.textContent).toContain(pod.name);
    expect(name.querySelector(".text-quiet")?.textContent).toBe(
      pod.name.slice(at ?? 0, pod.name.lastIndexOf("-") + 1),
    );
  });

  test("the full page leads the where line with the space's name, and the inspector's layout does not", async () => {
    await openEditor(POD);
    const editor = page("Pod");
    const where = () =>
      within(editor).queryByText("prod-eu", { ignore: "[inert] *" });
    expect(where()).toBeNull();
    layout.resize(editor, 1130);
    expect(where()).not.toBeNull();
  });

  test("every section is open but the Metadata, and what the person chooses there is not what the inspector's layout keeps", async () => {
    await openEditor(DEPLOYMENT);
    const editor = page("Deployment");
    const expanded = (id: string) =>
      document
        .querySelector(`[data-section="${id}"] button[aria-expanded]`)
        ?.getAttribute("aria-expanded");
    expect(expanded("core.conditions")).toBe("false");
    layout.resize(editor, 1130);
    for (const id of [
      "core.rollout",
      "core.pods",
      "core.conditions",
      "core.strategy",
    ])
      expect(expanded(id), id).toBe("true");
    expect(expanded("core.metadata")).toBe("false");

    fireEvent.click(sectionButton("core.rollout"));
    expect(expanded("core.rollout")).toBe("false");
    layout.resize(editor, 700);
    expect(expanded("core.rollout")).toBe("true");
    expect(expanded("core.conditions")).toBe("false");
    layout.resize(editor, 1130);
    expect(expanded("core.rollout")).toBe("false");
  });
});

describe("in the full page", () => {
  const layout = withScreenSize(1130);

  test("the full page has the vitals strip on the Overview only, the sections open but the Metadata, two property columns and two cards", async () => {
    await openEditor(POD);
    const bar = strip();
    if (!bar) throw new Error("no vitals strip");
    expect(
      within(bar)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["Ready", "Restarts", "CPU", "Memory"]);
    expect(bar.className).toContain("grid-cols-4");
    const views = screen.getByRole("tablist", { name: "Views of the object" });
    const panel = screen.getByRole("tabpanel", { name: "Overview" });
    expect(views.compareDocumentPosition(bar)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(bar.compareDocumentPosition(panel)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    const sections = [...panel.querySelectorAll("[data-section]")];
    expect(sections.length).toBeGreaterThanOrEqual(5);
    expect(
      sections
        .filter(
          (section) =>
            section
              .querySelector("button[aria-expanded]")
              ?.getAttribute("aria-expanded") === "false",
        )
        .map((section) => section.getAttribute("data-section")),
    ).toEqual(["core.metadata"]);
    expect(containerCards()?.className).toContain("grid-cols-2");

    fireEvent.click(within(views).getByRole("tab", { name: /^YAML/ }));
    await settle(2);
    expect(strip()).toBeNull();
  });

  test("under 900 px the editor is the inspector's layout: the strip under the views, one column", async () => {
    await openEditor(POD);
    layout.resize(page("Pod"), 700);
    expect(strip()).not.toBeNull();
    expect(containerCards()?.className).not.toContain("grid-cols-2");
  });

  test("the header's owner opens its Deployment", async () => {
    const workbench = await openEditor(POD);
    fireEvent.click(
      within(page("Pod")).getByRole("button", { name: /^Deployment / }),
    );
    await settle(2);
    expect(workbench.editors.active).toMatch(
      /^k8s:\/\/prod-eu\/apps\/v1\/deployments\//,
    );
  });

  test("links followed from one object open tabs of their own, none replacing another", async () => {
    const workbench = await openEditor(POD);
    fireEvent.click(
      within(page("Pod")).getByRole("button", { name: /^Deployment / }),
    );
    await settle(2);
    act(() => {
      workbench.editors.open(POD);
    });
    await settle(2);
    fireEvent.click(
      within(page("Pod")).getByRole("button", {
        name: "ConfigMap kube-root-ca.crt",
      }),
    );
    await settle(2);
    expect(
      [...document.querySelectorAll<HTMLElement>(".twigo-tab-title")].map(
        (title) => [title.textContent.trim(), title.dataset.preview],
      ),
    ).toEqual([
      [POD.split("/").pop(), "false"],
      ["web", "false"],
      ["kube-root-ca.crt", "false"],
    ]);
  });

  test("a link followed from a preview tab pins it and opens the object in a tab of its own", async () => {
    const workbench = await mountKube();
    act(() => {
      workbench.editors.open(POD, { preview: true });
    });
    await settle(12);
    const tabs = () =>
      [...document.querySelectorAll<HTMLElement>(".twigo-tab-title")].map(
        (title) => [title.textContent.trim(), title.dataset.preview],
      );
    expect(tabs()).toEqual([[POD.split("/").pop(), "true"]]);
    fireEvent.click(
      within(page("Pod")).getByRole("button", { name: /^Deployment / }),
    );
    await settle(2);
    expect(tabs()).toEqual([
      [POD.split("/").pop(), "false"],
      ["web", "false"],
    ]);
  });

  test("a pod's Logs button opens the logs of this pod", async () => {
    const workbench = await openEditor(POD);
    const execute = vi.spyOn(workbench.commands, "execute");
    fireEvent.click(within(page("Pod")).getByRole("button", { name: "Logs" }));
    await settle(4);
    expect(execute).toHaveBeenCalledWith(
      "k8s.logs.open",
      expect.anything(),
      expect.objectContaining({
        space: "prod-eu",
        gvr: { group: "", version: "v1", resource: "pods" },
        namespace: "payments",
        name: "payments-api-7f9c8d6b5-h8lbx",
      }),
    );
  });

  test("a Deployment's Restart, Scale and Delete run on the editor's own object", async () => {
    const workbench = await openEditor(DEPLOYMENT);
    const run = vi
      .spyOn(workbench.operations, "run")
      .mockResolvedValue({ state: "done" });
    const target = {
      gvr: { group: "apps", version: "v1", resource: "deployments" },
      namespaced: true,
      namespace: "payments",
      name: "payments-api",
    };
    const press = (name: string) => {
      fireEvent.click(within(row("Deployment")).getByRole("button", { name }));
    };
    press("Restart");
    await settle(2);
    expect(run).toHaveBeenLastCalledWith(
      { action: "restart", space: "prod-eu", target },
      expect.anything(),
    );
    press("Delete");
    await settle(2);
    expect(run).toHaveBeenLastCalledWith(
      { action: "delete", space: "prod-eu", targets: [target] },
      expect.anything(),
    );
    press("Scale…");
    await settle(2);
    expect(workbench.quickAccess.session?.ask?.prompt).toMatch(
      /^Scale deployment payments-api, now at \d+$/,
    );
  });

  test("its verbs are no longer in the group's title", async () => {
    const workbench = await openEditor(POD);
    const title = workbench
      .actions("editor/title", () => true, { uri: POD })
      .flat()
      .map((action) => action.id);
    expect(title).not.toContain("k8s.logs.open");
    expect(title).not.toContain("k8s.shell.open");
    expect(title).not.toContain("k8s.forward.open");
  });
});

function changing() {
  const mock = createMockBackend("ready");
  let send: ((batch: ObjectBatch) => void) | undefined;
  let last: Overview | undefined;
  let seq = 0;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "object_open")
        return mock.subscribe(command, request, onMessage);
      const forward = onMessage as (batch: ObjectBatch) => void;
      send = forward;
      return mock.subscribe(command, request, (message) => {
        const batch = message as ObjectBatch;
        last = batch.overview ?? last;
        seq = batch.seq;
        forward(batch);
      });
    },
  };
  return {
    backend,
    change: (edit: (overview: Overview) => Overview) => {
      if (!send || !last) throw new Error("no object batches");
      last = edit(last);
      seq += 1;
      act(() => {
        send?.({
          seq,
          status: { state: "ready" },
          exists: true,
          overview: last ?? null,
          manifest: null,
          events: null,
          related: null,
          usage: null,
        });
      });
    },
  };
}

const printing = (
  overview: Overview,
  cells: Record<string, string>,
  sentence?: Span[],
): Overview => ({
  ...overview,
  header: {
    ...overview.header,
    printed: overview.header.printed.map((cell) =>
      cell.column in cells
        ? { ...cell, value: cells[cell.column] ?? cell.value }
        : cell,
    ),
    ...(sentence && { sentence }),
  },
});

const view = (name: string) =>
  within(
    screen.getByRole("tablist", { name: "Views of the object" }),
  ).getByRole("tab", { name: new RegExp(`^${name}`) });

function followed(backend: Backend): () => ObjectParts {
  const subscribe = vi.spyOn(backend, "subscribe");
  const invoke = vi.spyOn(backend, "invoke");
  return () => {
    const sent = invoke.mock.calls.filter(
      ([command]) => command === "object_set_parts",
    );
    const last = sent[sent.length - 1];
    if (last) return (last[1] as RequestOf<"object_set_parts">).parts;
    const opened = subscribe.mock.calls.filter(
      ([command]) => command === "object_open",
    );
    return (opened[opened.length - 1]?.[1] as RequestOf<"object_open">).parts;
  };
}

describe("one header on every view", () => {
  withScreenSize(1130);

  test("the editor follows the Overview on every view, and the usage on the Overview alone", async () => {
    const backend = createMockBackend("ready");
    const parts = followed(backend);
    await openEditor(POD, backend);
    expect(parts()).toMatchObject({ overview: true, usage: true });
    for (const [name, own] of [
      ["YAML", { manifest: true }],
      ["Events", { events: true }],
      ["Related", { related: true }],
    ] as const) {
      fireEvent.click(view(name));
      await settle(3);
      expect(parts(), name).toMatchObject({
        overview: true,
        usage: false,
        ...own,
      });
    }
    fireEvent.click(view("Overview"));
    await settle(3);
    expect(parts()).toMatchObject({ overview: true, usage: true });
  });

  test("the header says what the object says now, whichever view shows, and the verdict is its printed cell's", async () => {
    const { backend, change } = changing();
    await openEditor(POD, backend);
    const verdict = () =>
      within(page("Pod")).getByRole("group", { name: "Verdict" }).textContent;
    expect(verdict()).toMatch(/^Running/);
    for (const name of ["YAML", "Events", "Related", "Overview"]) {
      fireEvent.click(view(name));
      await settle(4);
      expect(verdict(), name).toMatch(/^Running/);
    }
    for (const name of ["YAML", "Events", "Related", "Overview"]) {
      fireEvent.click(view(name));
      await settle(2);
      change((overview) =>
        printing(overview, { Status: name }, [
          { type: "text", text: `${name} now` },
        ]),
      );
      await settle(2);
      expect(verdict(), name).toBe(`${name}${name} now`);
    }
  });

  test("the pill of a Deployment that is 4/4 and past its progress deadline takes the tone of the core's finding", async () => {
    const { backend, change } = changing();
    await openEditor(DEPLOYMENT, backend);
    const pill = () =>
      within(
        within(page("Deployment")).getByRole("group", { name: "Verdict" }),
      ).getByText(/^\d+\/\d+$/);
    expect(pill().className).not.toContain("text-error");
    change((overview) => ({
      ...printing(overview, { Ready: "4/4" }),
      sections: [ROLLOUT_STUCK, ...overview.sections],
    }));
    await settle(2);
    expect(pill().textContent).toBe("4/4");
    expect(pill().className).toContain("text-error");
  });

  test("the sentence keeps its whole text in a tooltip, its times as they read now", async () => {
    const { backend, change } = changing();
    await openEditor(POD, backend);
    change((overview) =>
      printing(overview, {}, [
        { type: "text", text: "Back-off, last " },
        {
          type: "ago",
          at: new Date(Date.now() - 10 * 86_400_000 - 3_600_000).toISOString(),
        },
      ]),
    );
    await settle(2);
    const group = within(page("Pod")).getByRole("group", { name: "Verdict" });
    expect(group.querySelector(":scope > [title]")?.getAttribute("title")).toBe(
      "Back-off, last 10d ago",
    );
  });

  test("the verbs follow the live object on every view: a node that is cordoned offers Uncordon, a CronJob that is suspended Resume", async () => {
    const cluster = new Cluster("prod-eu", 5000, Date.now());
    const node = cluster.nodes[0]?.name;
    const job = cluster.cronJobs[0];
    if (!node || !job) throw new Error("prod-eu has a node and a cron job");
    const nodes = changing();
    await openEditor(`k8s://prod-eu//v1/nodes/${node}`, nodes.backend);
    expect(verbs("Node")).toContain("Cordon");
    nodes.change((overview) =>
      printing(overview, { Status: "Ready,SchedulingDisabled" }),
    );
    for (const name of ["Overview", "YAML", "Events", "Related"]) {
      fireEvent.click(view(name));
      await settle(3);
      expect(verbs("Node"), name).toContain("Uncordon");
      expect(verbs("Node"), name).not.toContain("Cordon");
    }
    cleanup();
    const jobs = changing();
    await openEditor(
      `k8s://prod-eu/batch/v1/cronjobs/${job.namespace}/${job.name}`,
      jobs.backend,
    );
    expect(verbs("CronJob")).toContain("Suspend");
    jobs.change((overview) => printing(overview, { Suspend: "True" }));
    for (const name of ["Overview", "YAML", "Events", "Related"]) {
      fireEvent.click(view(name));
      await settle(3);
      expect(verbs("CronJob"), name).toContain("Resume");
      expect(verbs("CronJob"), name).not.toContain("Suspend");
    }
  });
});

describe("the keys and the palette of an object editor", () => {
  withScreenSize(1130);

  const press = (code: string) => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      code,
      key: code.slice(-1).toLowerCase(),
    });
  };

  test("a verb's key acts on the editor's object, as its button does", async () => {
    const workbench = await openEditor(POD);
    const execute = vi.spyOn(workbench.commands, "execute");
    act(() => {
      screen.getByRole("tabpanel", { name: "Overview" }).focus();
    });
    press("KeyL");
    await settle(4);
    expect(execute).toHaveBeenCalledWith(
      "k8s.logs.open",
      expect.anything(),
      expect.objectContaining({
        space: "prod-eu",
        namespace: "payments",
        name: "payments-api-7f9c8d6b5-h8lbx",
      }),
    );
  });

  test("⌘⌫ asks to delete the object from the Overview, and means the text's own in the page's filter", async () => {
    const workbench = await openEditor(DEPLOYMENT);
    const run = vi
      .spyOn(workbench.operations, "run")
      .mockResolvedValue({ state: "done" });
    const deletes = () =>
      run.mock.calls.filter(([request]) => request.action === "delete");
    const chord = () => {
      const target = document.activeElement ?? document.body;
      const event = new KeyboardEvent("keydown", {
        code: "Backspace",
        key: "Backspace",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };
    act(() => {
      screen.getByRole("tabpanel", { name: "Overview" }).focus();
    });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      code: "Slash",
      key: "/",
    });
    await settle(3);
    const field = screen.getByRole("textbox", { name: "Filter this page" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "replicas" } });
    await settle(2);
    expect(chord().defaultPrevented).toBe(false);
    await settle(4);
    expect(deletes()).toEqual([]);
    act(() => {
      screen.getByRole("tabpanel", { name: "Overview" }).focus();
    });
    expect(chord().defaultPrevented).toBe(true);
    await settle(4);
    expect(deletes()).toHaveLength(1);
  });

  test("an object that discovery has not yet named is no selected resource, and its commands are off, until it has", async () => {
    const mock = createMockBackend("ready");
    const held: (() => void)[] = [];
    const backend: Backend = {
      invoke: mock.invoke.bind(mock),
      subscribe: (command, request, onMessage) =>
        mock.subscribe(
          command,
          request,
          command === "resources_watch"
            ? (message) => {
                held.push(() => {
                  onMessage(message);
                });
              }
            : onMessage,
        ),
    };
    const workbench = await openEditor(POD, backend);
    const region = () =>
      screen.getByRole("region", {
        name: /^(pods|Pod) payments-api-7f9c8d6b5-h8lbx$/,
      });
    const lookup = () => workbench.keys.lookup(region());
    expect(lookup()("resource.selected")).toBe(false);
    expect(workbench.commands.enabled("k8s.resource.copyName", lookup())).toBe(
      false,
    );
    act(() => {
      for (const deliver of held.splice(0)) deliver();
    });
    await settle(6);
    expect(lookup()("resource.selected")).toBe(true);
    expect(workbench.commands.enabled("k8s.resource.copyName", lookup())).toBe(
      true,
    );
  });

  test("the palette's Resource commands act on it, and those that need a list are not offered", async () => {
    const workbench = await openEditor(POD);
    act(() => {
      screen.getByRole("tabpanel", { name: "Overview" }).focus();
    });
    const lookup = workbench.keys.lookup(document.activeElement);
    const resolved = workbench.quickAccess.resolve(">");
    const items = (await resolved?.provider.items("", { lookup })) ?? [];
    const ids = items.map((item) => item.id);
    expect(ids).toContain("k8s.resource.logs");
    expect(ids).toContain("k8s.resource.copyName");
    for (const needing of [
      "k8s.resource.details",
      "k8s.resource.yaml",
      "k8s.resource.openEditor",
    ])
      expect(ids, needing).not.toContain(needing);
    const execute = vi.spyOn(workbench.commands, "execute");
    const logs = items.find((item) => item.id === "k8s.resource.logs");
    if (!logs) throw new Error("no Logs in the palette");
    await resolved?.provider.accept(logs, "", { lookup });
    await settle(4);
    expect(execute).toHaveBeenCalledWith(
      "k8s.logs.open",
      expect.anything(),
      expect.objectContaining({ name: "payments-api-7f9c8d6b5-h8lbx" }),
    );
  });

  test("on a view other than the Overview the keys leave typing alone, and the palette still acts", async () => {
    const workbench = await openEditor(POD);
    fireEvent.click(view("Events"));
    await settle(3);
    const execute = vi.spyOn(workbench.commands, "execute");
    act(() => {
      screen.getByRole("tabpanel", { name: "Events" }).focus();
    });
    press("KeyL");
    await settle(2);
    expect(execute).not.toHaveBeenCalledWith(
      "k8s.logs.open",
      expect.anything(),
      expect.anything(),
    );
    const lookup = workbench.keys.lookup(document.activeElement);
    const items =
      (await workbench.quickAccess.resolve(">")?.provider.items("", {
        lookup,
      })) ?? [];
    expect(items.map((item) => item.id)).toContain("k8s.resource.logs");
  });
});
