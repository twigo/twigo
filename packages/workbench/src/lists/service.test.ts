import { afterEach, expect, test, vi } from "vitest";
import { Lists } from "./service";

afterEach(() => {
  document.body.innerHTML = "";
});

test("a list takes what it can do from the focus up, and what it keeps stops there", () => {
  const lists = new Lists();
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  inner.tabIndex = 0;
  outer.append(inner);
  document.body.append(outer);
  const peek = vi.fn();
  const close = vi.fn();
  lists.register(outer, { peek, close });
  const move = vi.fn();
  const unregister = lists.register(inner, { move, keeps: ["peek"] });
  inner.focus();
  lists.focused("move")?.move(1);
  expect(move).toHaveBeenCalledWith(1);
  expect(lists.focused("peek")).toBeUndefined();
  lists.focused("close")?.close();
  expect(close).toHaveBeenCalledOnce();
  unregister();
  lists.focused("peek")?.peek();
  expect(peek).toHaveBeenCalledOnce();
});
