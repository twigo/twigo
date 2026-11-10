import type { ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(() => {
  cleanup();
});

function dialog(typed?: string) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      question="Delete namespace payments from prod-eu?"
      consequences={["Every object in it goes with it."]}
      command="kubectl --context prod-eu delete namespaces payments"
      {...(typed !== undefined && { typed })}
      choices={[
        {
          label: "Delete namespace",
          icon: Trash2,
          destructive: true,
          onSelect: onConfirm,
        },
      ]}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

test("the button names its action and waits for the name typed exactly", () => {
  const { onConfirm } = dialog("payments");
  const button = screen.getByRole("button", { name: "Delete namespace" });
  const field = screen.getByLabelText("Type payments to confirm");
  expect(document.activeElement).toBe(field);
  expect(button).toHaveProperty("disabled", true);
  for (const wrong of ["payment", "Payments", "payments "]) {
    fireEvent.change(field, { target: { value: wrong } });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.submit(field);
  }
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "payments" } });
  expect(button).toHaveProperty("disabled", false);
  fireEvent.click(button);
  expect(onConfirm).toHaveBeenCalledWith("payments");
});

test("focus starts on Cancel, so a stray Enter confirms nothing", () => {
  const { onConfirm, onCancel } = dialog();
  const cancel = screen.getByRole("button", { name: /Cancel/ });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  expect(
    screen.getByText("kubectl --context prod-eu delete namespaces payments"),
  ).toBeTruthy();
  expect(screen.getByText("Every object in it goes with it.")).toBeTruthy();
});

test("Escape cancels", () => {
  const { onCancel } = dialog("payments");
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  expect(onCancel).toHaveBeenCalledOnce();
});

test("each list says what happens to its objects, how many, and names them", () => {
  render(
    <ConfirmDialog
      question="Delete deployment web in shop from dev?"
      consequences={[]}
      lists={[
        {
          title: "With it go",
          items: [
            { key: "rs", kind: "ReplicaSet", name: "web-5d4f" },
            { key: "p1", kind: "Pod", name: "web-5d4f-x2kq9", detail: "shop" },
          ],
        },
      ]}
      choices={[
        { label: "Delete deployment", destructive: true, onSelect: vi.fn() },
      ]}
      onCancel={vi.fn()}
    />,
  );
  const list = screen.getByRole("region", { name: /With it go/ });
  expect(list.textContent).toBe(
    "With it go2ReplicaSetweb-5d4fPodweb-5d4f-x2kq9shop",
  );
});

function several(props: Partial<ComponentProps<typeof ConfirmDialog>> = {}) {
  const once = vi.fn();
  const lasting = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      question="Allow Terminal 2 to patch deployments/web in default on staging?"
      consequences={[]}
      cancel="Deny"
      choices={[
        { label: "Allow once", onSelect: once },
        { label: "Allow for 15 minutes", onSelect: lasting },
      ]}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { once, lasting, onCancel };
}

test("each choice is a button of its own, the first one is what Enter takes, and the decline names itself", () => {
  const { once, lasting, onCancel } = several();
  const deny = screen.getByRole("button", { name: /Deny/ });
  expect(document.activeElement).toBe(deny);
  expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Allow for 15 minutes" }));
  expect(lasting).toHaveBeenCalledWith(undefined);
  expect(once).not.toHaveBeenCalled();

  fireEvent.submit(screen.getByRole("button", { name: "Allow once" }));
  expect(once).toHaveBeenCalledWith(undefined);
  expect(onCancel).not.toHaveBeenCalled();
});

test("a typed name holds every choice back, and the choice that is picked gets it", () => {
  const { once, lasting } = several({ typed: "staging" });
  const field = screen.getByLabelText("Type staging to confirm");
  const buttons = ["Allow once", "Allow for 15 minutes"].map((name) =>
    screen.getByRole("button", { name }),
  );
  expect(buttons.map((button) => button.hasAttribute("disabled"))).toEqual([
    true,
    true,
  ]);
  fireEvent.change(field, { target: { value: "staging" } });
  fireEvent.click(buttons[1] ?? document.body);
  expect(lasting).toHaveBeenCalledWith("staging");
  expect(once).not.toHaveBeenCalled();
});

test("while an answer is on its way no button works, and a refusal is read aloud above them", () => {
  const { once, lasting, onCancel } = several({
    busy: true,
    error: "The ask is gone.",
  });
  for (const name of [/Deny/, "Allow once", "Allow for 15 minutes"]) {
    const button = screen.getByRole("button", { name });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
  }
  expect(screen.getByRole("alert").textContent).toContain("The ask is gone.");
  expect(once).not.toHaveBeenCalled();
  expect(lasting).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});

test("what it is given to show comes after the question, and it widens when asked to", () => {
  several({ wide: true, children: <p>Changes go here.</p> });
  expect(screen.getByText("Changes go here.")).toBeTruthy();
  expect(screen.getByRole("dialog").className).toContain("max-w-[880px]");
});

async function clickOutside() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const overlay = document.querySelector('[data-slot="dialog-overlay"]');
  expect(overlay).not.toBeNull();
  const target = overlay ?? document.body;
  fireEvent.pointerDown(target);
  fireEvent.click(target);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test("a click outside cancels, unless the dialog is told it must not", async () => {
  const closing = several();
  await clickOutside();
  expect(closing.onCancel).toHaveBeenCalledOnce();
  cleanup();

  const staying = several({ outsideCancels: false });
  await clickOutside();
  expect(staying.onCancel).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("Escape pressed inside something marked as owning it is not the dialog's", () => {
  const { onCancel } = several({
    children: (
      <div data-owns-escape>
        <input aria-label="Find" />
      </div>
    ),
  });
  fireEvent.keyDown(screen.getByLabelText("Find"), { key: "Escape" });
  expect(onCancel).not.toHaveBeenCalled();

  fireEvent.keyDown(screen.getByRole("button", { name: /Deny/ }), {
    key: "Escape",
  });
  expect(onCancel).toHaveBeenCalledOnce();
});

function withBusy(busy: boolean, typed?: string) {
  return (
    <ConfirmDialog
      question="Allow Terminal 2 to patch deployments/web in default on staging?"
      consequences={[]}
      cancel="Deny"
      busy={busy}
      {...(typed !== undefined && { typed })}
      choices={[{ label: "Allow once", onSelect: vi.fn() }]}
      onCancel={vi.fn()}
    />
  );
}

test("focus stays in the dialog while the buttons are disabled, and goes back to the decline when they are not", () => {
  const { rerender } = render(withBusy(true));
  const dialog = screen.getByRole("dialog");
  expect(document.activeElement).toBe(dialog);

  rerender(withBusy(false));
  const deny = screen.getByRole("button", { name: /Deny/ });
  expect(document.activeElement).toBe(deny);

  const allow = screen.getByRole("button", { name: "Allow once" });
  allow.focus();
  rerender(withBusy(true));
  expect(document.activeElement).toBe(dialog);
  rerender(withBusy(false));
  expect(document.activeElement).toBe(deny);
});

test("the typed field keeps the focus through an answer, as it is not disabled", () => {
  const { rerender } = render(withBusy(true, "staging"));
  const field = screen.getByLabelText("Type staging to confirm");
  expect(document.activeElement).toBe(field);
  rerender(withBusy(false, "staging"));
  expect(document.activeElement).toBe(field);
});

test("the choices ignore activation for the guard time after it shows, and declining never waits", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { once, lasting, onCancel } = several({ guardMs: 500 });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.submit(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Allow for 15 minutes" }),
    );
    expect(once).not.toHaveBeenCalled();
    expect(lasting).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
    expect(onCancel).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(499);
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(once).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Allow for 15 minutes" }),
    );
    expect(once).toHaveBeenCalledOnce();
    expect(lasting).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
