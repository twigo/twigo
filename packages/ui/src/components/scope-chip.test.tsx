import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Folder } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { ScopeChip } from "./scope-chip";

afterEach(cleanup);

test("a click on the name opens, and the close mark takes the narrowing off, each on its own", () => {
  const onOpen = vi.fn();
  const onClear = vi.fn();
  render(
    <ScopeChip
      icon={Folder}
      name="payments"
      more={2}
      label="Namespaces: payments, auth, default"
      onOpen={onOpen}
      clearLabel="Show all namespaces"
      onClear={onClear}
    />,
  );
  const open = screen.getByRole("button", {
    name: "Namespaces: payments, auth, default",
  });
  expect(open.textContent).toMatch(/^payments\s*\+2$/);
  fireEvent.click(open);
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onClear).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Show all namespaces" }));
  expect(onClear).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledOnce();
});

test("a chip without onOpen is a label, and the room its owner leaves it is its maxWidth", () => {
  render(
    <ScopeChip
      icon={Folder}
      name="checkout"
      label="Namespace: checkout"
      clearLabel="Clear"
      onClear={vi.fn()}
      maxWidth={112}
    />,
  );
  const label = screen.getByRole("group", { name: "Namespace: checkout" });
  expect(
    screen.queryByRole("button", { name: "Namespace: checkout" }),
  ).toBeNull();
  expect(label.textContent).toBe("checkout");
  expect(label.parentElement?.style.maxWidth).toBe("112px");
});

test("a folded chip keeps the glyph, with the count or alone, drops the name and the close mark, and still opens on a click, its label naming everything", () => {
  const onOpen = vi.fn();
  const names = "Namespaces: payments, auth, default";
  const chip = (fold: "count" | "glyph") => (
    <ScopeChip
      icon={Folder}
      name="payments"
      more={2}
      label={names}
      onOpen={onOpen}
      clearLabel="Show all namespaces"
      onClear={vi.fn()}
      fold={fold}
    />
  );
  const { rerender } = render(chip("count"));
  const open = screen.getByRole("button", { name: names });
  expect(open.textContent).toMatch(/^\s*\+2$/);
  expect(screen.queryByRole("button", { name: "Show all namespaces" })).toBe(
    null,
  );
  fireEvent.click(open);
  expect(onOpen).toHaveBeenCalledOnce();

  rerender(chip("glyph"));
  expect(screen.getByRole("button", { name: names }).textContent).toBe("");
  expect(screen.queryByRole("button", { name: "Show all namespaces" })).toBe(
    null,
  );
});
