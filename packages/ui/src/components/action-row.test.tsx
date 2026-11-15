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
import { ActionRow, type Action, type ActionGroups } from "./actions";

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

/** Lays the row out at `width`, each stage of a copy needing what `needs` says. */
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

/** What each pinned button shows: its keys too, its label, or its icon alone. */
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
