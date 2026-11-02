import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  StateStore,
  Workbench,
  WorkbenchView,
  type QuickAccessContext,
} from "@twigo/workbench";
import { PODS } from "./kinds";
import { registerKube } from "./register";
import { cellTone } from "./tones";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1000,
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function settle(steps = 6) {
  for (let i = 0; i < steps; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
    act(() => {
      vi.advanceTimersToNextFrame();
    });
  }
}

async function podsList(backend = createMockBackend("ready")) {
  const state = StateStore.load(backend, () => undefined);
  await act(() => vi.advanceTimersByTimeAsync(10));
  const workbench = new Workbench(
    backend,
    "mac",
    { id: "us", keys: {} },
    await state,
  );
  registerKube(workbench);
  const loaded = Promise.all([
    workbench.catalog.watch(),
    workbench.spaces.load(),
  ]);
  await act(() => vi.advanceTimersByTimeAsync(10));
  await loaded;
  render(<WorkbenchView workbench={workbench} />);
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  return workbench;
}

const NOWHERE: QuickAccessContext = { lookup: () => undefined };
const rows = () => screen.getAllByRole("row").slice(1);
const details = () =>
  screen.queryByRole("complementary", { name: "Pod details" });
const key = (code: string) => {
  fireEvent.keyDown(screen.getByRole("grid"), { code, key: code });
};

test("a click opens the row's details over the list, arrows follow, Escape closes", async () => {
  await podsList();
  expect(details()).toBeNull();
  const [first, second] = rows();
  if (!first || !second) throw new Error("no rows");
  fireEvent.click(first);
  expect(details()?.textContent).toContain(
    first.children[0]?.textContent ?? "?",
  );
  act(() => {
    screen.getByRole("grid").focus();
  });
  key("KeyJ");
  await settle(2);
  expect(details()?.textContent).toContain(
    second.children[0]?.textContent ?? "?",
  );
  key("Escape");
  expect(details()).toBeNull();
});

test("Enter on the selected row opens its details", async () => {
  await podsList();
  act(() => {
    screen.getByRole("grid").focus();
  });
  key("KeyJ");
  await settle(2);
  expect(details()).toBeNull();
  key("Enter");
  expect(details()).not.toBeNull();
});

test("the status bar counts the active list's rows", async () => {
  await podsList();
  expect(screen.getByText("5,000 pods")).toBeTruthy();
});

const statusOf = (row: HTMLElement) => row.children[3]?.textContent ?? "";
const chip = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

test("a health chip shows only its rows while every count stays", async () => {
  await podsList();
  const counts = () =>
    ["All", "Failing", "Pending", "Healthy"].map(
      (name) => chip(name).textContent,
    );
  const before = counts();
  fireEvent.click(chip("Failing"));
  await settle();
  expect(chip("Failing").getAttribute("aria-pressed")).toBe("true");
  expect(rows().length).toBeGreaterThan(0);
  expect(
    rows().filter((row) => cellTone(PODS, "Status", statusOf(row)) !== "error"),
  ).toEqual([]);
  expect(counts()).toEqual(before);
  fireEvent.click(chip("All"));
  await settle();
  expect(screen.getByText("5,000 pods")).toBeTruthy();
});

test("a count in the status bar shows only those rows", async () => {
  await podsList();
  fireEvent.click(screen.getByRole("button", { name: /pending:/ }));
  await settle();
  expect(chip("Pending").getAttribute("aria-pressed")).toBe("true");
  expect(
    rows().filter((row) => cellTone(PODS, "Status", statusOf(row)) !== "warn"),
  ).toEqual([]);
});

test("/ in the list focuses the filter field, and its text filters the rows", async () => {
  await podsList();
  act(() => {
    screen.getByRole("grid").focus();
  });
  key("Slash");
  const field = screen.getByRole("textbox", { name: "Filter rows" });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "ImagePullBackOff" } });
  await settle();
  expect(rows().length).toBeGreaterThan(0);
  expect(rows().filter((row) => statusOf(row) !== "ImagePullBackOff")).toEqual(
    [],
  );
});

const openMenu = (trigger: HTMLElement) => {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
};

test("a row's actions button and a right click run the resource commands on that row", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  await podsList();
  const second = rows()[1];
  if (!second) throw new Error("no rows");
  const name = second.children[0]?.textContent;
  const namespace = second.children[1]?.textContent;
  const trigger = within(second).getByRole("button", { name: "Row actions" });
  openMenu(trigger);
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Copy Namespace/Name" }),
  );
  await settle(1);
  expect(writeText).toHaveBeenCalledWith(`${namespace ?? ""}/${name ?? ""}`);

  const third = rows()[2];
  if (!third) throw new Error("no rows");
  fireEvent.contextMenu(third);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open Details" }));
  await settle(1);
  expect(details()?.textContent).toContain(third.children[0]?.textContent);
});

test("the column chooser shows a wide column, and the kind keeps the choice", async () => {
  const backend = createMockBackend("ready");
  await podsList(backend);
  expect(screen.queryByRole("columnheader", { name: "IP" })).toBeNull();
  openMenu(screen.getByRole("button", { name: "Choose columns" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "IP" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await settle(1);
  expect(screen.getByRole("columnheader", { name: "IP" })).toBeTruthy();

  cleanup();
  await podsList(backend);
  expect(screen.getByRole("columnheader", { name: "IP" })).toBeTruthy();
});

const nameOf = (row: HTMLElement | undefined) =>
  row?.children[0]?.textContent ?? "?";

test("two lists of a space keep their own selected row for the details and the row commands", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const workbench = await podsList();
  const all = nameOf(rows()[0]);
  fireEvent.click(rows()[0] ?? document.body);
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods?ns=payments");
  });
  await settle();
  const payments = nameOf(rows()[1]);
  fireEvent.click(rows()[1] ?? document.body);
  expect(details()?.textContent).toContain(payments);

  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  expect(details()?.textContent).toContain(all);
  await act(() =>
    workbench.commands.execute("k8s.resource.copyName", (key) =>
      key === "listFocus" ? true : undefined,
    ),
  );
  expect(writeText).toHaveBeenCalledWith(all);
});

test("a list reopened with a health chip picked subscribes with that health's values", async () => {
  const backend = createMockBackend("ready");
  const workbench = await podsList(backend);
  fireEvent.click(chip("Failing"));
  await settle();
  act(() => {
    workbench.editors.close("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  const subscribe = vi.spyOn(backend, "subscribe");
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  const values = subscribe.mock.calls.flatMap(([command, query]) =>
    command === "list_subscribe" &&
    typeof query === "object" &&
    query !== null &&
    "values" in query
      ? [query.values?.values]
      : [],
  );
  expect(values).toEqual([["CrashLoopBackOff", "Error", "ImagePullBackOff"]]);
  expect(rows().length).toBeGreaterThan(0);
});

test("going to a pod again shows its details again after they were closed", async () => {
  const workbench = await podsList();
  const provider = workbench.quickAccess.resolve("auth-api-1a4")?.provider;
  if (!provider) throw new Error("no provider");
  const goTo = async () => {
    const pending = provider.items("auth-api-1a4", NOWHERE);
    await settle();
    const [first] = await pending;
    if (!first) throw new Error("no pods");
    await act(() => provider.accept(first, "auth-api-1a4", NOWHERE));
    await settle();
    return first.label;
  };
  const name = await goTo();
  expect(details()?.textContent).toContain(name);
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  expect(details()).toBeNull();
  await goTo();
  expect(details()?.textContent).toContain(name);

  fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
    target: { value: "" },
  });
  await settle();
  const other = rows().find((row) => nameOf(row) !== name);
  fireEvent.click(other ?? document.body);
  expect(details()?.textContent).toContain(nameOf(other));
  await goTo();
  expect(details()?.textContent).toContain(name);
  const selected = rows().filter(
    (row) => row.getAttribute("aria-selected") === "true",
  );
  expect(selected.map(nameOf)).toEqual([name]);
});

test("a list subscribes with the scope discovery gives, and waits for it", async () => {
  const mock = createMockBackend("ready");
  const queries: unknown[] = [];
  let answer: (() => void) | undefined;
  const backend: typeof mock = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "list_subscribe") queries.push(request);
      if (command !== "resources_watch") {
        return mock.subscribe(command, request, onMessage);
      }
      answer = () => void mock.subscribe(command, request, onMessage);
      return Promise.resolve(null as never);
    },
  };
  await podsList(backend);
  expect(queries).toEqual([]);
  act(() => answer?.());
  await settle();
  expect(queries).toMatchObject([{ namespaced: true }]);
  expect(rows().length).toBeGreaterThan(0);
});

test("a kind the cluster does not serve says so instead of a list", async () => {
  const workbench = await podsList();
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/example.com/v1/widgets");
  });
  await settle();
  expect(
    screen.getByText("The cluster does not serve widgets.example.com"),
  ).toBeDefined();
});

test("a list of a version discovery does not prefer subscribes with that resource's scope", async () => {
  const mock = createMockBackend("ready");
  const queries: unknown[] = [];
  const backend: typeof mock = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "list_subscribe") queries.push(request);
      return mock.subscribe(command, request, onMessage);
    },
  };
  const workbench = await podsList(backend);
  queries.length = 0;
  act(() => {
    workbench.editors.open(
      "k8s-list://prod-eu/autoscaling/v1/horizontalpodautoscalers",
    );
  });
  await settle();
  expect(queries).toMatchObject([
    {
      gvr: { group: "autoscaling", version: "v1" },
      namespaced: true,
    },
  ]);
});

test("a failed discovery shows its error instead of a list", async () => {
  const mock = createMockBackend("ready");
  const backend: typeof mock = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "resources_watch") {
        return mock.subscribe(command, request, onMessage);
      }
      setTimeout(() => {
        (onMessage as (message: unknown) => void)({
          state: "failed",
          error: { kind: "unavailable", message: "no route to the cluster" },
        });
      }, 0);
      return Promise.resolve(null as never);
    },
  };
  await podsList(backend);
  const title = screen.getByText("Could not load pods");
  const state = title.parentElement ?? title;
  expect(within(state).getByText("no route to the cluster")).toBeDefined();
  expect(screen.queryByRole("grid", { name: "Pods" })).toBeNull();
});
