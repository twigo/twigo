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
import { mountKube, settle, withScreenSize } from "../../test/workbench";

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
const summary = () => screen.queryByRole("complementary", { name: "Summary" });
const row = (kind: string) =>
  screen.getByRole("toolbar", { name: `${kind} actions` });
const verbs = (kind: string) =>
  within(row(kind))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
const column = () =>
  within(screen.getByRole("complementary", { name: "Summary" }));
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
    expect(summary()).toBeNull();
    expect(verbs("Deployment")).toEqual(["Logs", "Restart", "Scale…", "More"]);

    layout.resize(editor, 900);
    expect(summary()).not.toBeNull();
    expect(verbs("Deployment")).toEqual([
      "Logs",
      "Forward",
      "Forward Port…",
      "Restart",
      "Scale…",
      "Delete",
    ]);

    layout.resize(editor, 884);
    expect(summary()).not.toBeNull();
    layout.resize(editor, 883);
    expect(summary()).toBeNull();
    layout.resize(editor, 899);
    expect(summary()).toBeNull();
    layout.resize(editor, 900);
    expect(summary()).not.toBeNull();
  });

  test("a tab that is hidden keeps the stage it held, and shows it again where it was", async () => {
    await openEditor(DEPLOYMENT);
    const editor = page("Deployment");
    layout.resize(editor, 900);
    expect(summary()).not.toBeNull();
    layout.resize(editor, 0);
    expect(summary()).not.toBeNull();
    layout.resize(editor, 890);
    expect(summary()).not.toBeNull();
  });

  test("the two property columns are decided by the main column's width once the summary column has taken its own, and come at 750 px", async () => {
    await openEditor(POD);
    const main = screen.getByRole("tabpanel", { name: "Overview" })
      .parentElement?.parentElement;
    if (!main) throw new Error("no main column");
    const cards = () =>
      document.querySelector('[data-section="core.containers"] .relative.grid');
    layout.resize(main, 749);
    layout.resize(page("Pod"), 1069);
    expect(cards()?.className).not.toContain("grid-cols-2");
    layout.resize(main, 750);
    expect(cards()?.className).toContain("grid-cols-2");
    layout.resize(main, 734);
    expect(cards()?.className).toContain("grid-cols-2");
    layout.resize(main, 733);
    expect(cards()?.className).not.toContain("grid-cols-2");
  });

  test("the main column is read once the summary column is drawn, never as it was before, when it spanned the editor", async () => {
    await openEditor(POD);
    const main = screen.getByRole("tabpanel", { name: "Overview" })
      .parentElement?.parentElement;
    if (!main) throw new Error("no main column");
    Object.defineProperty(main, "clientWidth", {
      configurable: true,
      get: () => (summary() ? 749 : 1068),
    });
    layout.resize(page("Pod"), 1069);
    expect(summary()).not.toBeNull();
    expect(
      document.querySelector('[data-section="core.containers"] .relative.grid')
        ?.className,
    ).not.toContain("grid-cols-2");
  });

  test("the editor cuts a pod's name as the list does, its generated part from the object's header", async () => {
    const generated = new Cluster("prod-eu", 5000, Date.now()).pods
      .map((pod) => ({ pod, at: podGenerated(pod) }))
      .find(({ pod, at }) => at !== null && pod.name.length > at);
    if (!generated) throw new Error("prod-eu has a pod with a generated name");
    const { pod, at } = generated;
    await openEditor(`k8s://prod-eu//v1/pods/${pod.namespace}/${pod.name}`);
    const name = within(page("Pod")).getByRole("heading");
    expect(name.textContent).toContain(pod.name);
    expect(name.querySelector(".text-quiet")?.textContent).toBe(
      pod.name.slice(at ?? 0, pod.name.lastIndexOf("-") + 1),
    );
  });

  test("the full page leads the where line with the space's name, and the inspector's layout does not", async () => {
    await openEditor(POD);
    const editor = page("Pod");
    const where = () => within(editor).queryByText("prod-eu");
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

  test("the summary column holds the vitals and the sections as an index of what each says, and a click opens the section and scrolls to it", async () => {
    await openEditor(POD);
    const index = column();
    expect(index.getAllByRole("term").map((term) => term.textContent)).toEqual([
      "Ready",
      "Restarts",
      "CPU",
      "Memory",
    ]);
    expect(index.getAllByRole("listitem").length).toBeGreaterThanOrEqual(5);
    const metadata = index.getByRole("button", { name: /^Metadata/ });
    expect(metadata.textContent).toMatch(/^Metadata.+/);

    const panel = screen.getByRole("tabpanel", { name: "Overview" });
    let top = 0;
    Object.defineProperty(panel, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (to: number) => {
        top = to;
      },
    });
    panel.getBoundingClientRect = () => new DOMRect(0, 100, 600, 500);
    const target = panel.querySelector('[data-section="core.metadata"]');
    if (!target) throw new Error("no metadata section");
    target.getBoundingClientRect = () => new DOMRect(0, 700, 600, 30);
    expect(
      within(target as HTMLElement).getByRole("button", { expanded: false }),
    ).toBeTruthy();

    fireEvent.click(metadata);
    await settle(2);
    expect(
      within(screen.getByRole("region", { name: "Metadata" })).getByRole(
        "button",
        {
          expanded: true,
        },
      ),
    ).toBeTruthy();
    expect(top).toBe(600);
  });

  test("under the page's filter the index lists the sections the filter keeps, and a click on one writes no fold of the kind", async () => {
    await openEditor(POD);
    const panel = screen.getByRole("tabpanel", { name: "Overview" });
    act(() => {
      panel.focus();
    });
    fireEvent.keyDown(panel, { code: "Slash", key: "/" });
    await settle(2);
    const field = screen.getByRole("textbox", { name: "Filter this page" });
    const entries = () =>
      within(column().getByRole("list", { name: "Sections" }))
        .getAllByRole("button")
        .map((entry) => entry.textContent);
    const all = entries();
    expect(all.length).toBeGreaterThanOrEqual(5);
    fireEvent.change(field, { target: { value: "metadata" } });
    await settle(2);
    expect(entries().length).toBeLessThan(all.length);
    expect(entries().some((entry) => entry.startsWith("Metadata"))).toBe(true);
    expect(entries().some((entry) => entry.startsWith("Conditions"))).toBe(
      false,
    );
    fireEvent.click(column().getByRole("button", { name: /^Metadata/ }));
    await settle(2);
    expect(sectionButton("core.metadata").getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.change(field, { target: { value: "" } });
    await settle(2);
    expect(entries()).toEqual(all);
    expect(sectionButton("core.metadata").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  test("the containers sit two side by side where the property rows run in two columns, and one under the other where they do not", async () => {
    await openEditor(POD);
    const cards = () =>
      document.querySelector('[data-section="core.containers"] .relative.grid');
    const column = summary();
    if (!column) throw new Error("no summary column");
    layout.resize(column, 320);
    expect(cards()?.className).toContain("grid-cols-2");
    layout.resize(page("Pod"), 700);
    expect(summary()).toBeNull();
    expect(cards()?.className).not.toContain("grid-cols-2");
  });

  test("a click on the index while another view shows brings the Overview", async () => {
    await openEditor(POD);
    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Views of the object" }),
      ).getByRole("tab", { name: /^YAML/ }),
    );
    await settle(2);
    expect(screen.queryByRole("tabpanel", { name: "Overview" })).toBeNull();
    fireEvent.click(column().getByRole("button", { name: /^Containers/ }));
    await settle(2);
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeTruthy();
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
  const layout = withScreenSize(1130);

  test("the editor follows the Overview on every view, and the usage while its summary column shows", async () => {
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
        usage: true,
        ...own,
      });
    }
    layout.resize(page("Pod"), 700);
    await settle(3);
    expect(parts()).toMatchObject({ overview: true, usage: false });
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
