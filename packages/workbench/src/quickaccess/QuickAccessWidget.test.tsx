import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Box } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import type { Workbench } from "../services";
import { QuickAccessWidget } from "./QuickAccessWidget";
import type { QuickAccessProvider, QuickPickItem } from "./registry";

afterEach(cleanup);

function provider(
  prefix: string,
  items: readonly QuickPickItem[],
  extra: Partial<QuickAccessProvider> = {},
) {
  const accept = vi.fn();
  const registered: QuickAccessProvider = {
    prefix,
    placeholder: "",
    help: "",
    items: () => items,
    accept,
    ...extra,
  };
  return { registered, accept };
}

async function opened(workbench: Workbench, value: string) {
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  await act(async () => {
    workbench.quickAccess.show(value);
    await Promise.resolve();
  });
}

const input = () => screen.getByRole("combobox");
const press = (code: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(input(), { key: code.replace(/^Key/, ""), code, ...init });
};
const selected = () =>
  document.getElementById(input().getAttribute("aria-activedescendant") ?? "")
    ?.textContent ?? undefined;
const footer = () => screen.getByLabelText("Keys").textContent;

test("a pick with a source is asked for the rows of each value typed, and shows them as they come", async () => {
  const workbench = await testWorkbench();
  const source = vi.fn((filter: string): QuickPickItem[] =>
    filter === ""
      ? [{ id: "a", label: "alpha" }]
      : [{ id: "z", label: "zulu" }],
  );
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  let picked: Promise<QuickPickItem | undefined> | undefined;
  await act(async () => {
    picked = workbench.quickAccess.pick("Compare with…", source);
    await Promise.resolve();
  });
  expect(screen.getByText("alpha")).toBeTruthy();

  await act(async () => {
    fireEvent.change(input(), { target: { value: "u" } });
    await Promise.resolve();
  });
  expect(source).toHaveBeenLastCalledWith("u");
  expect(screen.queryByText("alpha")).toBeNull();
  expect(screen.getByText("zulu")).toBeTruthy();

  press("Enter");
  await expect(picked).resolves.toEqual({ id: "z", label: "zulu" });
});

test("a pick that the accepted command opens holds the focus, and Escape gives it back to where it was", async () => {
  const workbench = await testWorkbench();
  const { registered } = provider(
    "!",
    [{ id: "compare", label: "Compare with…" }],
    {
      accept: () => {
        void workbench.quickAccess.pick("Compare with…", [
          { id: "a", label: "alpha" },
        ]);
      },
    },
  );
  workbench.quickAccess.register(registered);
  render(
    <>
      <textarea aria-label="Editor" />
      <QuickAccessWidget />
    </>,
    { wrapper: inWorkbench(workbench) },
  );
  const editor = screen.getByLabelText("Editor");
  editor.focus();
  await act(async () => {
    workbench.quickAccess.show("!");
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(input());

  press("Enter");
  await act(() => Promise.resolve());
  expect(workbench.quickAccess.session?.pick?.placeholder).toBe(
    "Compare with…",
  );
  expect(document.activeElement).toBe(input());

  press("Escape");
  expect(document.activeElement).toBe(editor);
});

test("a pick's notice says what its rows are, and shows with none", async () => {
  const workbench = await testWorkbench();
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  await act(async () => {
    void workbench.quickAccess.pick("Compare with…", () => ({
      items: [],
      notice: "Only your namespaces",
    }));
    await Promise.resolve();
  });
  expect(screen.getByRole("status").textContent).toBe("Only your namespaces");
  expect(screen.getByText("No results")).toBeTruthy();
});

test("items loaded for another value are neither shown nor accepted, and an Enter meanwhile takes the rows of its own value", async () => {
  const workbench = await testWorkbench();
  const pending = new Map<string, (items: QuickPickItem[]) => void>();
  const accept = vi.fn();
  workbench.quickAccess.register({
    prefix: "!",
    placeholder: "",
    help: "",
    items: (filter) =>
      new Promise((resolve) => {
        pending.set(filter, resolve);
      }),
    accept,
  });
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  act(() => {
    workbench.quickAccess.show("!a");
  });
  await act(async () => {
    pending.get("a")?.([{ id: "a", label: "alpha" }]);
    await Promise.resolve();
  });
  expect(screen.getByText("alpha")).toBeTruthy();

  fireEvent.change(input(), { target: { value: "!ab" } });
  expect(screen.queryByText("alpha")).toBeNull();
  press("Enter");
  expect(accept).not.toHaveBeenCalled();

  await act(async () => {
    pending.get("ab")?.([{ id: "ab", label: "alphabet" }]);
    await Promise.resolve();
  });
  expect(accept).toHaveBeenCalledTimes(1);
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "ab" }),
    "ab",
    expect.anything(),
    { side: false },
  );
});

test("a row draws what its provider says: icon or tile, matches, description, state, kind and keys", async () => {
  const workbench = await testWorkbench();
  const { registered } = provider("!", [
    {
      id: "pod",
      label: "auth-api-7f9",
      matches: [{ start: 0, end: 4 }],
      description: "payments",
      icon: Box,
      state: { tone: "error", label: "CrashLoopBackOff" },
      kind: "Pod",
      group: "Pods",
    },
    {
      id: "space",
      label: "prod-eu",
      tile: { name: "prod-eu", color: "red" },
      keybinding: "⌘1",
      group: "Open spaces",
    },
  ]);
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");

  const pod = screen.getByRole("option", { name: /auth-api-7f9/ });
  expect(pod.querySelector("svg")).not.toBeNull();
  expect(
    [...pod.querySelectorAll("mark")].map((mark) => mark.textContent),
  ).toEqual(["auth"]);
  expect(screen.getByText("payments")).toBeTruthy();
  expect(
    screen.getByText("CrashLoopBackOff").parentElement?.className,
  ).toContain("text-error");
  expect(screen.getByText("Pod")).toBeTruthy();
  const space = screen.getByRole("option", { name: /prod-eu/ });
  expect(space.textContent).toBe("PEprod-eu⌘1");
  expect(screen.getByText("Pods")).toBeTruthy();
  expect(screen.getByText("Open spaces")).toBeTruthy();
  expect(screen.queryByText("No results")).toBeNull();
});

test("a state that is off draws a ring, and one that waits a filled dot", async () => {
  const workbench = await testWorkbench();
  const { registered } = provider("!", [
    {
      id: "off",
      label: "payments-api",
      state: { tone: "idle", label: "Stopped", hollow: true },
    },
    {
      id: "waiting",
      label: "payments-gateway",
      state: { tone: "idle", label: "Restored" },
    },
  ]);
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  const dot = (words: string) =>
    screen.getByText(words).previousElementSibling?.className ?? "";
  expect(dot("Stopped")).toContain("inset_0_0_0_1.5px_var(--quiet)");
  expect(dot("Stopped")).not.toContain("bg-quiet");
  expect(dot("Restored")).toContain("bg-quiet");
  expect(dot("Restored")).not.toContain("inset_0_0_0");
});

test("↓ and ↑ move through the rows and wrap, Enter accepts, all by their bindings", async () => {
  const workbench = await testWorkbench();
  const { registered, accept } = provider("!", [
    { id: "a", label: "alpha", group: "One" },
    { id: "b", label: "beta", group: "Two" },
    { id: "c", label: "gamma", group: "One" },
  ]);
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  expect(selected()).toBe("alpha");
  press("ArrowDown");
  expect(selected()).toBe("gamma");
  press("ArrowDown");
  expect(selected()).toBe("beta");
  press("ArrowDown");
  expect(selected()).toBe("alpha");
  press("ArrowUp");
  expect(selected()).toBe("beta");
  press("Enter");
  await act(() => Promise.resolve());
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "b" }),
    "",
    expect.anything(),
    { side: false },
  );
  expect(workbench.quickAccess.session).toBeUndefined();
});

test("the row under the cursor scrolls into view as the cursor moves", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(
    provider("!", [
      { id: "a", label: "alpha" },
      { id: "b", label: "beta" },
    ]).registered,
  );
  let scrolled: string | null = null;
  const spy = vi
    .spyOn(Element.prototype, "scrollIntoView")
    .mockImplementation(function (this: Element) {
      scrolled = this.textContent;
    });
  await opened(workbench, "!");
  press("ArrowDown");
  expect(scrolled).toBe("beta");
  press("ArrowUp");
  expect(scrolled).toBe("alpha");
  spy.mockRestore();
});

test("a value typed puts the cursor on the best match, however the cursor moved before", async () => {
  const workbench = await testWorkbench();
  const rows: readonly QuickPickItem[] = [
    { id: "alpha", label: "alpha" },
    { id: "alpine", label: "alpine" },
    { id: "beta", label: "beta" },
  ];
  const { registered, accept } = provider("!", rows, {
    items: (filter) => rows.filter((row) => row.label.includes(filter)),
  });
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  press("ArrowDown");
  expect(selected()).toBe("alpine");

  fireEvent.change(input(), { target: { value: "!al" } });
  await act(() => Promise.resolve());
  expect(selected()).toBe("alpha");

  fireEvent.change(input(), { target: { value: "!" } });
  await act(() => Promise.resolve());
  expect(selected()).toBe("alpha");

  press("ArrowDown");
  fireEvent.change(input(), { target: { value: "!al" } });
  await act(() => Promise.resolve());
  press("Enter");
  await act(() => Promise.resolve());
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "alpha" }),
    "al",
    expect.anything(),
    { side: false },
  );
});

test("a key the user binds instead moves, and the unbound one does not", async () => {
  const workbench = await testWorkbench();
  workbench.keybindings.register("user", [
    { command: "-quickInput.next" },
    { key: "ctrl+j", command: "quickInput.next", when: "inQuickOpen" },
  ]);
  const { registered } = provider("!", [
    { id: "a", label: "alpha" },
    { id: "b", label: "beta" },
  ]);
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  press("ArrowDown");
  expect(selected()).toBe("alpha");
  press("KeyJ", { ctrlKey: true });
  expect(selected()).toBe("beta");
  expect(footer()).toContain("↑⌃JMove");
});

test("⌃N and ⌃P move as ↓ and ↑ do on macOS, which the footer still says, and ⌃N is not bound elsewhere", async () => {
  for (const [platform, moves] of [
    ["mac", true],
    ["linux", false],
  ] as const) {
    const workbench = await testWorkbench("ready", undefined, platform);
    workbench.quickAccess.register(
      provider("!", [
        { id: "a", label: "alpha" },
        { id: "b", label: "beta" },
        { id: "c", label: "gamma" },
      ]).registered,
    );
    await opened(workbench, "!");
    expect(selected()).toBe("alpha");
    press("KeyN", { ctrlKey: true });
    expect(selected()).toBe(moves ? "beta" : "alpha");
    if (moves) {
      press("KeyN", { ctrlKey: true });
      press("KeyP", { ctrlKey: true });
      expect(selected()).toBe("beta");
    }
    expect(footer()).toContain(moves ? "↑↓Move" : "UpDownMove");
    cleanup();
  }
});

test("⌘↵ opens to the side only where the provider can", async () => {
  const workbench = await testWorkbench();
  const side = provider("", [{ id: "a", label: "alpha" }], { toSide: true });
  const plain = provider("!", [{ id: "b", label: "beta" }]);
  workbench.quickAccess.register(side.registered);
  workbench.quickAccess.register(plain.registered);

  await opened(workbench, "!");
  press("Enter", { metaKey: true });
  await act(() => Promise.resolve());
  expect(plain.accept).not.toHaveBeenCalled();
  expect(footer()).not.toContain("Open to the side");

  act(() => {
    workbench.quickAccess.show("");
  });
  await act(() => Promise.resolve());
  expect(footer()).toContain("⌘↩Open to the side");
  press("Enter", { metaKey: true });
  await act(() => Promise.resolve());
  expect(side.accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "a" }),
    "",
    expect.anything(),
    { side: true },
  );
});

test("the footer shows the keys from the registry and, on no prefix, the prefixes providers name", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(provider("", []).registered);
  workbench.quickAccess.register(
    provider("!", [], { hint: "Bangs", acceptLabel: "Bang" }).registered,
  );
  await opened(workbench, "");
  expect(footer()).toBe("↑↓Move↩Open>Commands?Help!Bangs");

  act(() => {
    workbench.quickAccess.show("!");
  });
  expect(footer()).toBe("↑↓Move↩Bang");
  act(() => {
    workbench.quickAccess.show(">");
  });
  expect(footer()).toBe("↑↓Move↩Run");
});

const space = () => fireEvent.keyDown(input(), { key: " ", code: "Space" });
const rowOf = (name: string) => screen.getByRole("option", { name });
const checkedOf = (name: string) => rowOf(name).getAttribute("aria-selected");
const hint = (words: string) => footer().includes(words);

const NAMESPACES: readonly QuickPickItem[] = [
  { id: "all", label: "All namespaces" },
  { id: "payments", label: "payments", group: "Selected", checked: true },
  { id: "auth", label: "auth", group: "Others", checked: false },
  { id: "batch", label: "batch", group: "Others", checked: false },
];

function ticking(
  items: readonly QuickPickItem[] = NAMESPACES,
  extra: Partial<QuickAccessProvider> = {},
) {
  const acceptChecked = vi.fn();
  return {
    ...provider("!", items, {
      acceptLabel: "Select",
      acceptAloneLabel: "Only this",
      checkedWords: (count) => `${String(count)} namespaces`,
      acceptChecked,
      ...extra,
    }),
    acceptChecked,
  };
}

test("rows with a box open ticked as they say, with no row under the cursor, so Enter at once changes nothing", async () => {
  const workbench = await testWorkbench();
  const { registered, accept, acceptChecked } = ticking();
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  expect(checkedOf("payments")).toBe("true");
  expect(checkedOf("auth")).toBe("false");
  expect(rowOf("All namespaces").getAttribute("aria-selected")).toBeNull();
  expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe(
    "true",
  );
  expect(selected()).toBeUndefined();
  expect(footer()).toContain("Space");
  expect(hint("Add or remove")).toBe(true);

  press("Enter");
  await act(() => Promise.resolve());
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(accept).not.toHaveBeenCalled();
  expect(acceptChecked).not.toHaveBeenCalled();
});

test("the footer says what Enter does to the row under the cursor: only this one for a row with a box before the first tick, then the ticked set", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(ticking().registered);
  await opened(workbench, "!");
  expect(hint("Close")).toBe(true);
  expect(hint("Select")).toBe(false);

  press("ArrowDown");
  expect(hint("Select")).toBe(true);
  expect(hint("Only this")).toBe(false);
  expect(hint("Close")).toBe(false);

  press("ArrowDown");
  expect(hint("Only this")).toBe(true);
  expect(hint("Select")).toBe(false);

  space();
  expect(hint("Apply · 0 namespaces")).toBe(true);
  expect(hint("Only this")).toBe(false);
});

test("the footer says Select, not Close, while the rows of a value typed come", async () => {
  const workbench = await testWorkbench();
  const { items, answer } = slow();
  workbench.quickAccess.register(ticking(undefined, { items }).registered);
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  act(() => {
    workbench.quickAccess.show("!");
  });
  expect(hint("Close")).toBe(false);
  await answer("", NAMESPACES);
  expect(hint("Close")).toBe(true);

  fireEvent.change(input(), { target: { value: "!pay" } });
  expect(hint("Close")).toBe(false);
  expect(hint("Select")).toBe(true);
});

test("the input is a combobox on the list and names the row under the cursor, and none where no row is", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(ticking().registered);
  await opened(workbench, "!");
  const list = screen.getByRole("listbox");
  expect(input().getAttribute("aria-controls")).toBe(list.id);
  expect(input().getAttribute("aria-autocomplete")).toBe("list");
  expect(input().getAttribute("aria-expanded")).toBe("true");
  expect(input().getAttribute("aria-activedescendant")).toBeNull();

  press("ArrowDown");
  press("ArrowDown");
  const active = input().getAttribute("aria-activedescendant");
  expect(active).toBe(rowOf("payments").id);
  expect(document.getElementById(active ?? "")?.textContent).toBe("payments");
  expect(list.contains(rowOf("payments"))).toBe(true);

  const group = screen.getByRole("group", { name: "Selected" });
  expect(group.contains(rowOf("payments"))).toBe(true);
  expect(group.contains(rowOf("auth"))).toBe(false);
});

test("a listbox that takes several rows says which are selected and never where the cursor is, as the APG's multi-select listbox does", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(ticking().registered);
  await opened(workbench, "!");
  press("ArrowDown");
  press("ArrowDown");
  press("ArrowDown");
  expect(selected()).toBe("auth");
  expect(rowOf("auth").hasAttribute("data-cursor")).toBe(true);
  expect(rowOf("payments").hasAttribute("data-cursor")).toBe(false);
  expect(checkedOf("auth")).toBe("false");
  expect(checkedOf("payments")).toBe("true");
  expect(checkedOf("batch")).toBe("false");
  expect(rowOf("All namespaces").hasAttribute("aria-selected")).toBe(false);
  expect(document.querySelector("[aria-checked]")).toBeNull();

  space();
  expect(checkedOf("auth")).toBe("true");
});

test("a listbox of one row to take says aria-selected where the cursor is, where selection follows focus", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(
    provider("!", [
      { id: "a", label: "alpha" },
      { id: "b", label: "beta" },
    ]).registered,
  );
  await opened(workbench, "!");
  const states = () => [
    rowOf("alpha").getAttribute("aria-selected"),
    rowOf("beta").getAttribute("aria-selected"),
  ];
  expect(states()).toEqual(["true", "false"]);
  expect(screen.getByRole("listbox").hasAttribute("aria-multiselectable")).toBe(
    false,
  );
  press("ArrowDown");
  expect(states()).toEqual(["false", "true"]);
  expect(selected()).toBe("beta");
});

test("↓ from no row goes to the first row, and ↑ to the last", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(ticking().registered);
  await opened(workbench, "!");
  press("ArrowDown");
  expect(selected()).toBe("All namespaces");

  act(() => {
    workbench.quickAccess.hide();
  });
  act(() => {
    workbench.quickAccess.show("!");
  });
  await act(() => Promise.resolve());
  expect(selected()).toBeUndefined();
  press("ArrowUp");
  expect(selected()).toBe("batch");
});

test("a pointer over a row puts the cursor on it where no row was under it", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(ticking().registered);
  await opened(workbench, "!");
  expect(selected()).toBeUndefined();
  fireEvent.pointerMove(rowOf("auth"));
  expect(selected()).toBe("auth");
});

test("Space ticks the row under the cursor and Enter applies the ticked set, which the footer and a status say", async () => {
  const workbench = await testWorkbench();
  const { registered, accept, acceptChecked } = ticking();
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  press("ArrowDown");
  space();
  expect(checkedOf("payments")).toBe("true");
  expect(screen.getByRole("status").textContent).toBe("");

  press("ArrowDown");
  space();
  expect(checkedOf("payments")).toBe("false");
  press("ArrowDown");
  space();
  expect(checkedOf("auth")).toBe("true");
  expect(screen.getByRole("status").textContent).toBe("1 namespaces selected");
  expect(hint("Apply · 1 namespaces")).toBe(true);

  press("Enter");
  await act(() => Promise.resolve());
  expect(acceptChecked).toHaveBeenCalledWith(["auth"], "", expect.anything());
  expect(accept).not.toHaveBeenCalled();
  expect(workbench.quickAccess.session).toBeUndefined();
});

test("a value typed leaves no row under the cursor when the filter is empty again, and puts it on the first row otherwise, after a tick too", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(
    ticking(undefined, {
      items: (filter) =>
        NAMESPACES.filter((item) => item.label.includes(filter)),
    }).registered,
  );
  await opened(workbench, "!");
  press("ArrowDown");
  press("ArrowDown");
  space();
  expect(selected()).toBe("payments");

  fireEvent.change(input(), { target: { value: "!a" } });
  await act(() => Promise.resolve());
  expect(selected()).toBe("All namespaces");
  expect(checkedOf("payments")).toBe("false");

  fireEvent.change(input(), { target: { value: "!" } });
  await act(() => Promise.resolve());
  expect(selected()).toBeUndefined();
});

function slow() {
  const pending = new Map<string, (items: readonly QuickPickItem[]) => void>();
  const items = (filter: string) =>
    new Promise<readonly QuickPickItem[]>((resolve) => {
      pending.set(filter, resolve);
    });
  const answer = (filter: string, rows: readonly QuickPickItem[]) =>
    act(async () => {
      pending.get(filter)?.(rows);
      await Promise.resolve();
    });
  return { items, answer };
}

test("an Enter before the rows of the value typed have come acts on the cursor's row once they do", async () => {
  const workbench = await testWorkbench();
  const { items, answer } = slow();
  const { registered, accept } = ticking(undefined, { items });
  workbench.quickAccess.register(registered);
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  act(() => {
    workbench.quickAccess.show("!");
  });
  await answer("", NAMESPACES);
  fireEvent.change(input(), { target: { value: "!pay" } });
  press("Enter");
  await act(() => Promise.resolve());
  expect(workbench.quickAccess.session).toBeDefined();
  expect(accept).not.toHaveBeenCalled();

  await answer(
    "pay",
    NAMESPACES.filter((item) => item.id === "payments"),
  );
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "payments" }),
    "pay",
    expect.anything(),
    { side: false },
  );
  expect(workbench.quickAccess.session).toBeUndefined();
});

test("a value typed after an Enter that waits for rows withdraws it", async () => {
  const workbench = await testWorkbench();
  const { items, answer } = slow();
  const { registered, accept } = ticking(undefined, { items });
  workbench.quickAccess.register(registered);
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  act(() => {
    workbench.quickAccess.show("!");
  });
  await answer("", NAMESPACES);
  fireEvent.change(input(), { target: { value: "!pay" } });
  press("Enter");
  fireEvent.change(input(), { target: { value: "!paym" } });
  await answer("pay", NAMESPACES);
  await answer("paym", NAMESPACES);
  expect(accept).not.toHaveBeenCalled();
  expect(workbench.quickAccess.session).toBeDefined();
});

test("a row the filter hides keeps its tick, and is applied", async () => {
  const workbench = await testWorkbench();
  const { registered, acceptChecked } = ticking(undefined, {
    items: (filter) =>
      NAMESPACES.filter((item) => item.label.startsWith(filter)),
  });
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  expect(screen.queryByText("payments")).not.toBeNull();

  fireEvent.change(input(), { target: { value: "!au" } });
  await act(() => Promise.resolve());
  expect(screen.queryByText("payments")).toBeNull();
  space();
  press("Enter");
  await act(() => Promise.resolve());
  expect(acceptChecked).toHaveBeenCalledWith(
    ["payments", "auth"],
    "au",
    expect.anything(),
  );
});

test("a load that the next value outdated still seeds the ticks of its rows", async () => {
  const workbench = await testWorkbench();
  const pending = new Map<string, (items: readonly QuickPickItem[]) => void>();
  const { registered, acceptChecked } = ticking(undefined, {
    items: (filter) =>
      new Promise((resolve) => {
        pending.set(filter, resolve);
      }),
  });
  workbench.quickAccess.register(registered);
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  act(() => {
    workbench.quickAccess.show("!");
  });
  fireEvent.change(input(), { target: { value: "!au" } });
  await act(async () => {
    pending.get("")?.(NAMESPACES);
    pending.get("au")?.(NAMESPACES.filter((item) => item.id === "auth"));
    await Promise.resolve();
  });
  space();
  press("Enter");
  await act(() => Promise.resolve());
  expect(acceptChecked).toHaveBeenCalledWith(
    ["payments", "auth"],
    "au",
    expect.anything(),
  );
});

test("after a tick the filter's text is selected and the prefix is not", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(
    ticking(undefined, {
      items: (filter) =>
        NAMESPACES.filter((item) => item.label.startsWith(filter)),
    }).registered,
  );
  await opened(workbench, "!au");
  await act(() => Promise.resolve());
  space();
  const field = input() as HTMLInputElement;
  expect([field.selectionStart, field.selectionEnd]).toEqual([1, 3]);
  expect(document.activeElement).toBe(field);
});

test("Enter and a click take one row alone until the first tick, and a click ticks after it", async () => {
  const workbench = await testWorkbench();
  const { registered, accept, acceptChecked } = ticking();
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  press("ArrowDown");
  press("ArrowDown");
  press("ArrowDown");
  press("Enter");
  await act(() => Promise.resolve());
  expect(accept).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "auth" }),
    "",
    expect.anything(),
    { side: false },
  );

  act(() => {
    workbench.quickAccess.show("!");
  });
  await act(() => Promise.resolve());
  fireEvent.click(rowOf("batch"));
  await act(() => Promise.resolve());
  expect(accept).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "batch" }),
    "",
    expect.anything(),
    { side: false },
  );

  accept.mockClear();
  act(() => {
    workbench.quickAccess.show("!");
  });
  await act(() => Promise.resolve());
  press("ArrowDown");
  press("ArrowDown");
  space();
  fireEvent.click(rowOf("batch"));
  expect(checkedOf("batch")).toBe("true");
  expect(accept).not.toHaveBeenCalled();
  expect(acceptChecked).not.toHaveBeenCalled();
  expect(workbench.quickAccess.session).toBeDefined();
});

test("a click on a row's box ticks it and does not accept it, and so does ⌘-click on the row", async () => {
  const workbench = await testWorkbench();
  const { registered, accept } = ticking();
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  fireEvent.click(rowOf("batch"), { metaKey: true });
  expect(checkedOf("batch")).toBe("true");
  expect(accept).not.toHaveBeenCalled();

  act(() => {
    workbench.quickAccess.hide();
  });
  act(() => {
    workbench.quickAccess.show("!");
  });
  await act(() => Promise.resolve());
  const box = rowOf("auth").querySelector("span[class*='pl-2']");
  if (!box) throw new Error("no box");
  fireEvent.click(box);
  expect(checkedOf("auth")).toBe("true");
  expect(accept).not.toHaveBeenCalled();
  expect(hint("Apply · 2 namespaces")).toBe(true);
});

test("a row with no box is taken alone whatever is ticked", async () => {
  const workbench = await testWorkbench();
  const { registered, accept, acceptChecked } = ticking();
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  press("ArrowDown");
  press("ArrowDown");
  space();
  expect(hint("Apply · 0 namespaces")).toBe(true);
  press("ArrowUp");
  expect(hint("Select")).toBe(true);
  expect(hint("Apply")).toBe(false);
  press("Enter");
  await act(() => Promise.resolve());
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "all" }),
    "",
    expect.anything(),
    { side: false },
  );
  expect(acceptChecked).not.toHaveBeenCalled();
});

test("Space types the space that ends a prefix and ticks nothing, and ticks once the provider takes ticks", async () => {
  const workbench = await testWorkbench();
  const { registered } = ticking(undefined, { prefix: "ns " });
  workbench.quickAccess.register(registered);
  workbench.quickAccess.register(
    provider("", [{ id: "a", label: "alpha" }]).registered,
  );
  await opened(workbench, "ns");
  expect(space()).toBe(true);
  expect(footer()).not.toContain("Add or remove");

  fireEvent.change(input(), { target: { value: "ns " } });
  await act(() => Promise.resolve());
  press("ArrowDown");
  press("ArrowDown");
  expect(space()).toBe(false);
  expect(checkedOf("payments")).toBe("false");
});
