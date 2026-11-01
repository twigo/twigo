import { afterEach, expect, test, vi } from "vitest";
import { ContextKeys } from "../contextkey/service";
import { QuickAccess, type QuickAccessProvider } from "./registry";

afterEach(() => {
  document.body.replaceChildren();
});

function provider(prefix: string, accept = vi.fn()): QuickAccessProvider {
  return {
    prefix,
    placeholder: prefix,
    help: prefix,
    items: (filter) => [{ id: filter, label: filter }],
    accept,
  };
}

test("the longest prefix wins and the empty prefix takes the rest", () => {
  const quick = new QuickAccess(new ContextKeys());
  for (const prefix of ["", ">", "ns ", "n"]) quick.register(provider(prefix));
  expect(quick.resolve("ns payments")).toMatchObject({
    provider: { prefix: "ns " },
    filter: "payments",
  });
  expect(quick.resolve("nginx")).toMatchObject({
    provider: { prefix: "n" },
    filter: "ginx",
  });
  expect(quick.resolve(">toggle")).toMatchObject({
    provider: { prefix: ">" },
    filter: "toggle",
  });
  expect(quick.resolve("api")).toMatchObject({
    provider: { prefix: "" },
    filter: "api",
  });
});

test("a prefix registers once", () => {
  const quick = new QuickAccess(new ContextKeys());
  quick.register(provider(">"));
  expect(() => quick.register(provider(">"))).toThrow();
});

test("the context is the focused element's at opening, and the focus comes back", async () => {
  const keys = new ContextKeys();
  document.body.innerHTML = `<div id="list" tabindex="0"></div><input id="input" />`;
  const list = document.getElementById("list");
  if (!list) throw new Error("no #list");
  keys.scope(list).set("listFocus", true);
  list.focus();
  const accept = vi.fn();
  const quick = new QuickAccess(keys);
  quick.register(provider(">", accept));
  quick.show(">");
  document.getElementById("input")?.focus();
  quick.setValue(">run");
  await quick.accept({ id: "x", label: "x" });
  expect(accept).toHaveBeenCalledOnce();
  const [, filter, context] = accept.mock.calls[0] as [
    unknown,
    string,
    { lookup: (key: string) => unknown },
  ];
  expect(filter).toBe("run");
  expect(context.lookup("listFocus")).toBe(true);
  expect(quick.session).toBeUndefined();
  expect(document.activeElement).toBe(list);
});

test("a pick resolves with the item, or undefined when dismissed", async () => {
  const quick = new QuickAccess(new ContextKeys());
  const items = [{ id: "a", label: "A" }];
  const picked = quick.pick("Pick", items);
  expect(quick.session?.pick?.items).toBe(items);
  await quick.accept({ id: "a", label: "A" });
  await expect(picked).resolves.toEqual({ id: "a", label: "A" });
  const dismissed = quick.pick("Pick", items);
  quick.hide();
  await expect(dismissed).resolves.toBeUndefined();
});

test("showing quick access over a pick dismisses the pick", async () => {
  const quick = new QuickAccess(new ContextKeys());
  quick.register(provider(">"));
  const picked = quick.pick("Pick", []);
  quick.show(">");
  await expect(picked).resolves.toBeUndefined();
  expect(quick.session?.value).toBe(">");
});
