import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  ArrowLeftRight,
  Cable,
  RotateCcw,
  ScrollText,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { resize } from "../../test/resize";
import {
  ActionRow,
  FullActionRow,
  type Action,
  type ActionGroups,
} from "./actions";

afterEach(cleanup);

function action(label: string, more: Partial<Action> = {}): Action {
  return { id: label, label, run: () => undefined, ...more };
}

function pod(changes: Record<string, Partial<Action>> = {}): ActionGroups {
  const with_ = (label: string, more: Partial<Action>) =>
    action(label, { ...more, ...changes[label] });
  return [
    [
      with_("Logs", { icon: ScrollText, keys: "L", pinned: true }),
      with_("Shell", { icon: SquareTerminal, keys: "S", pinned: true }),
      with_("Attach", { icon: Cable }),
      with_("Forward", { icon: ArrowLeftRight, keys: "F", pinned: true }),
    ],
    [with_("Delete", { icon: Trash2, keys: "⌘⌫", danger: true })],
  ];
}

const toolbar = () => screen.getByRole("toolbar", { name: "Pod actions" });
const buttons = () => within(toolbar()).getAllByRole("button");
const names = () =>
  buttons().map((button) => button.getAttribute("aria-label"));
const button = (index: number): HTMLElement => {
  const found = buttons()[index];
  if (!found) throw new Error(`no button ${String(index)}`);
  return found;
};

test("the pinned actions keep their order, then More, always last, holds the rest in their groups with Delete last behind a separator", () => {
  render(<ActionRow label="Pod actions" actions={pod()} />);
  expect(names()).toEqual(["Logs", "Shell", "Forward", "More"]);
  expect(buttons()[0]?.querySelector("kbd")?.textContent).toBe("L");

  fireEvent.pointerDown(
    within(toolbar()).getByRole("button", { name: "More" }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
  const menu = screen.getByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Attach", "Delete⌘⌫"]);
  const last = menu.lastElementChild;
  expect(last?.textContent).toBe("Delete⌘⌫");
  expect(last?.previousElementSibling?.getAttribute("role")).toBe("separator");
});

test("a pinned action that cannot run keeps its place, says why in its tooltip and does nothing", () => {
  const run = vi.fn();
  render(
    <ActionRow
      label="Pod actions"
      actions={pod({
        Shell: { disabled: true, reason: "No container runs", run },
      })}
    />,
  );
  expect(names()).toEqual(["Logs", "Shell", "Forward", "More"]);
  const shell = within(toolbar()).getByRole("button", { name: "Shell" });
  expect(shell.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(shell);
  expect(run).not.toHaveBeenCalled();
  act(() => {
    shell.focus();
  });
  expect(screen.getByRole("tooltip").textContent).toContain(
    "No container runs",
  );
});

test("an action the context's mode will refuse says so and still runs, so that the refusal can offer the unlock", () => {
  const run = vi.fn();
  render(
    <ActionRow
      label="Pod actions"
      actions={[
        [
          action("Restart", {
            icon: RotateCcw,
            pinned: true,
            locked: true,
            reason: "prod-eu is read-only",
            run,
          }),
        ],
      ]}
    />,
  );
  const restart = within(toolbar()).getByRole("button", { name: "Restart" });
  expect(restart.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(restart);
  expect(run).toHaveBeenCalledOnce();
  act(() => {
    restart.focus();
  });
  expect(screen.getByRole("tooltip").textContent).toContain(
    "prod-eu is read-only",
  );
});

function layOut(width: number, needs: readonly number[]) {
  const sized = (element: Element, value: number) => {
    Object.defineProperty(element, "clientWidth", {
      configurable: true,
      value,
    });
  };
  sized(toolbar(), width);
  for (const copy of document.querySelectorAll("[data-stage]"))
    sized(copy, needs[Number(copy.getAttribute("data-stage"))] ?? 0);
  act(() => {
    resize();
  });
}

const forms = () =>
  buttons()
    .slice(0, -1)
    .map((button) =>
      button.querySelector("kbd")
        ? "keys"
        : button.textContent === button.getAttribute("aria-label")
          ? "label"
          : "icon",
    );

test("as the row narrows the keys go first, then the labels from the last pinned back, and a stage comes back only with 16 px to spare", () => {
  render(<ActionRow label="Pod actions" actions={pod()} />);
  const needs = [300, 250, 220, 190, 160];
  layOut(320, needs);
  expect(forms()).toEqual(["keys", "keys", "keys"]);
  layOut(299, needs);
  expect(forms()).toEqual(["label", "label", "label"]);
  layOut(315, needs);
  expect(forms()).toEqual(["label", "label", "label"]);
  layOut(316, needs);
  expect(forms()).toEqual(["keys", "keys", "keys"]);
  layOut(249, needs);
  expect(forms()).toEqual(["label", "label", "icon"]);
  layOut(200, needs);
  expect(forms()).toEqual(["label", "icon", "icon"]);
  layOut(150, needs);
  expect(forms()).toEqual(["icon", "icon", "icon"]);
  layOut(205, needs);
  expect(forms()).toEqual(["icon", "icon", "icon"]);
  layOut(206, needs);
  expect(forms()).toEqual(["label", "icon", "icon"]);
  layOut(400, needs);
  expect(forms()).toEqual(["keys", "keys", "keys"]);
});

test("an icon alone says its label and keys in its tooltip", () => {
  render(<ActionRow label="Pod actions" actions={pod()} />);
  layOut(150, [300, 250, 220, 190, 160]);
  const forward = within(toolbar()).getByRole("button", { name: "Forward" });
  act(() => {
    forward.focus();
  });
  expect(screen.getByRole("tooltip").textContent).toBe("ForwardF");
});

test("the row is one tab stop, and the arrows, Home and End move along it, past a disabled action too", () => {
  render(
    <ActionRow
      label="Pod actions"
      actions={pod({ Shell: { disabled: true, reason: "No container runs" } })}
    />,
  );
  const stops = () =>
    buttons()
      .filter((button) => button.tabIndex === 0)
      .map((button) => button.getAttribute("aria-label"));
  const focused = () => document.activeElement?.getAttribute("aria-label");
  const press = (key: string) => {
    fireEvent.keyDown(document.activeElement ?? toolbar(), { key });
  };
  expect(stops()).toEqual(["Logs"]);
  act(() => {
    buttons()[0]?.focus();
  });
  press("ArrowRight");
  expect(focused()).toBe("Shell");
  expect(stops()).toEqual(["Shell"]);
  press("End");
  expect(focused()).toBe("More");
  press("ArrowRight");
  expect(focused()).toBe("Logs");
  press("ArrowLeft");
  expect(focused()).toBe("More");
  press("Home");
  expect(focused()).toBe("Logs");
  expect(stops()).toEqual(["Logs"]);
});

test("a pinned action's tooltip stays shut while it has nothing to tell, and opens only once it has, never switching between controlled and uncontrolled", () => {
  const warn = vi.spyOn(console, "warn");
  const row = (reason?: string) => (
    <ActionRow
      label="Pod actions"
      actions={pod({
        Shell: reason === undefined ? {} : { disabled: true, reason },
      })}
    />
  );
  const { rerender } = render(row());
  const shell = () => within(toolbar()).getByRole("button", { name: "Shell" });
  act(() => {
    shell().focus();
  });
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => {
    shell().blur();
  });
  rerender(row("No container runs"));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => {
    shell().focus();
  });
  expect(screen.getByRole("tooltip").textContent).toContain(
    "No container runs",
  );
  rerender(row());
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(warn).not.toHaveBeenCalled();
});

test("the full row holds every action inline with its label and keys, in its groups, Delete last behind its own spacer, with no More", () => {
  render(<FullActionRow label="Pod actions" actions={pod()} />);
  expect(names()).toEqual(["Logs", "Shell", "Attach", "Forward", "Delete"]);
  expect(buttons()[0]?.querySelector("kbd")?.textContent).toBe("L");
  expect(buttons()[3]?.querySelector("kbd")?.textContent).toBe("F");
  expect(buttons()[4]?.className).toContain("text-error");
  expect(buttons()[4]?.previousElementSibling?.className).toContain("ml-auto");
});

test("a group that does not destroy is set off from the one before it by a separator", () => {
  render(
    <FullActionRow
      label="Pod actions"
      actions={[
        [action("Logs", { icon: ScrollText })],
        [action("Restart", { icon: RotateCcw })],
        [action("Delete", { icon: Trash2, danger: true })],
      ]}
    />,
  );
  expect(button(0).nextElementSibling).toBe(button(1).previousElementSibling);
  expect(button(1).previousElementSibling?.getAttribute("aria-hidden")).toBe(
    "true",
  );
});

test("the full row is one tab stop, and the arrows, Home and End move along it", () => {
  render(<FullActionRow label="Pod actions" actions={pod()} />);
  expect(buttons().map((button) => button.tabIndex)).toEqual([
    0, -1, -1, -1, -1,
  ]);
  act(() => {
    buttons()[0]?.focus();
  });
  fireEvent.keyDown(button(0), { key: "ArrowRight" });
  expect(document.activeElement).toBe(buttons()[1]);
  fireEvent.keyDown(button(1), { key: "End" });
  expect(document.activeElement).toBe(buttons()[4]);
  expect(buttons().map((button) => button.tabIndex)).toEqual([
    -1, -1, -1, -1, 0,
  ]);
  fireEvent.keyDown(button(4), { key: "Home" });
  expect(document.activeElement).toBe(buttons()[0]);
});

test("a disabled action of the full row keeps its place, says why and does nothing", () => {
  const run = vi.fn();
  render(
    <FullActionRow
      label="Pod actions"
      actions={pod({
        Shell: { disabled: true, reason: "No container runs", run },
      })}
    />,
  );
  const shell = within(toolbar()).getByRole("button", { name: "Shell" });
  expect(shell.getAttribute("aria-disabled")).toBe("true");
  act(() => {
    shell.focus();
  });
  expect(screen.getByRole("tooltip").textContent).toContain(
    "No container runs",
  );
  fireEvent.click(shell);
  expect(run).not.toHaveBeenCalled();
});
