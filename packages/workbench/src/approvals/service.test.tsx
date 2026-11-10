import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import {
  IpcError,
  type ApprovalAsk,
  type ApprovalEvent,
  type Backend,
  type Plan,
  type PlanRequest,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { notify } from "@twigo/ui";
import { ConfirmHost } from "../operations/ConfirmHost";
import { inWorkbench, testWorkbench } from "../testing";
import { ApprovalHost } from "./ApprovalHost";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function ask(id: number, over: Partial<ApprovalAsk> = {}): ApprovalAsk {
  return {
    id,
    context: "staging",
    process: `Terminal ${String(id)}`,
    command: null,
    verb: "patch",
    class: "write",
    target: "deployments/web in default",
    impersonate: null,
    detail: { kind: "diff", live: {}, result: {}, warnings: [] },
    typed: false,
    lastingMinutes: 15,
    ...over,
  };
}

const REQUEST: PlanRequest = {
  action: "delete",
  space: "dev",
  targets: [
    {
      gvr: { group: "", version: "v1", resource: "pods" },
      namespaced: true,
      namespace: "default",
      name: "web-1",
    },
  ],
};

const PLAN: Plan = {
  id: 7,
  context: "dev",
  environment: "development",
  mode: "read-write",
  friction: { kind: "confirm" },
  question: "Delete pod web-1 in default from dev?",
  confirm: "Delete pod",
  destructive: true,
  consequences: [],
  affected: [],
  kubectl: "kubectl --context dev delete pods web-1 -n default",
  doing: "Deleting pod web-1",
};

const DELETE = ask(9, {
  context: "prod-eu",
  verb: "delete",
  target: "pods/web-1 in default",
  detail: { kind: "delete", propagation: null },
  typed: true,
  lastingMinutes: null,
});

async function broker() {
  const mock = createMockBackend("ready");
  const answers: unknown[] = [];
  const control: {
    emit: (event: ApprovalEvent) => void;
    refuse: IpcError | undefined;
    hold: Promise<void> | undefined;
  } = { emit: () => undefined, refuse: undefined, hold: undefined };
  const backend: Backend = {
    async invoke(command, request) {
      if (command === "command_plan") return PLAN;
      if (command === "command_cancel") return null;
      if (command !== "approval_answer") return mock.invoke(command, request);
      answers.push(request);
      await control.hold;
      if (control.refuse) throw control.refuse;
      return null;
    },
    subscribe(command, request, onMessage) {
      if (command !== "approvals_watch") {
        return mock.subscribe(command, request, onMessage);
      }
      control.emit = onMessage;
      return Promise.resolve(null);
    },
  };
  const workbench = await testWorkbench("ready", backend);
  workbench.approvals.registerDetails({
    component: ({ detail }) => <p>Detail of a {detail.kind}</p>,
    wide: ({ kind }) => kind === "diff",
  });
  await act(() => workbench.approvals.watch());
  render(
    <>
      <ConfirmHost />
      <ApprovalHost />
    </>,
    { wrapper: inWorkbench(workbench) },
  );
  const raise = (...asks: ApprovalAsk[]) => {
    act(() => {
      for (const next of asks) control.emit({ event: "asked", ask: next });
    });
  };
  const withdraw = (id: number) => {
    act(() => {
      control.emit({ event: "withdrawn", id });
    });
  };
  return { workbench, answers, control, raise, withdraw };
}

const dialog = (name: string | RegExp) => screen.getByRole("dialog", { name });
const button = (name: string | RegExp) => screen.getByRole("button", { name });

test("asks come one at a time in the order they came, saying how many wait", async () => {
  const { raise, answers } = await broker();
  expect(screen.queryByRole("dialog")).toBeNull();

  raise(ask(1), ask(2), ask(3));
  expect(
    dialog("Allow Terminal 1 to patch deployments/web in default on staging?"),
  ).toBeTruthy();
  expect(screen.getByText("1 of 3")).toBeTruthy();

  fireEvent.click(button("Allow once"));
  await waitFor(() => {
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });
  expect(dialog(/^Allow Terminal 2 /)).toBeTruthy();

  fireEvent.click(button(/^Deny/));
  await waitFor(() => {
    expect(dialog(/^Allow Terminal 3 /)).toBeTruthy();
  });
  expect(screen.queryByText(/^\d+ of \d+$/)).toBeNull();

  fireEvent.click(button("Allow once"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answers).toEqual([
    { id: 1, answer: "once", typed: null },
    { id: 2, answer: "deny", typed: null },
    { id: 3, answer: "once", typed: null },
  ]);
});

test("an ask withdrawn on screen closes the dialog and says so; one that waits leaves without a word", async () => {
  const { raise, withdraw } = await broker();
  const info = vi.spyOn(notify, "info");
  raise(ask(1), ask(2), ask(3));

  withdraw(3);
  expect(info).not.toHaveBeenCalled();
  expect(screen.getByText("1 of 2")).toBeTruthy();
  withdraw(77);
  expect(info).not.toHaveBeenCalled();

  withdraw(1);
  expect(info).toHaveBeenCalledExactlyOnceWith(
    "Terminal 1 no longer asks to patch deployments/web in default on staging",
  );
  expect(dialog(/^Allow Terminal 2 /)).toBeTruthy();
  expect(screen.queryByText(/^\d+ of \d+$/)).toBeNull();

  withdraw(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(info).toHaveBeenCalledTimes(2);
});

test("an ask sent again, as after a new watch, waits once", async () => {
  const { raise } = await broker();
  raise(ask(1), ask(1, { process: "Terminal 1 again" }));
  expect(dialog(/^Allow Terminal 1 again /)).toBeTruthy();
  expect(screen.queryByText(/^\d+ of \d+$/)).toBeNull();
});

test("the typed field holds the delete's button back, takes the focus, and sends what was typed", async () => {
  const { raise, answers } = await broker();
  raise(DELETE);
  const field = screen.getByLabelText("Type prod-eu to confirm");
  expect(document.activeElement).toBe(field);
  const allow = button("Allow delete");
  expect(allow.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: /^Allow for / })).toBeNull();

  for (const wrong of ["prod", "Prod-eu", "prod-eu "]) {
    fireEvent.change(field, { target: { value: wrong } });
    expect(allow.hasAttribute("disabled")).toBe(true);
    fireEvent.click(allow);
  }
  expect(answers).toEqual([]);

  fireEvent.change(field, { target: { value: "prod-eu" } });
  expect(allow.hasAttribute("disabled")).toBe(false);
  fireEvent.click(allow);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answers).toEqual([{ id: 9, answer: "once", typed: "prod-eu" }]);
});

test("a deny sends no name, though one was typed", async () => {
  const { raise, answers } = await broker();
  raise(DELETE);
  fireEvent.change(screen.getByLabelText("Type prod-eu to confirm"), {
    target: { value: "prod-eu" },
  });
  fireEvent.click(button(/^Deny/));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answers).toEqual([{ id: 9, answer: "deny", typed: null }]);
});

test("each button sends its answer, and a typed name goes with the allowing ones", async () => {
  const { raise, answers } = await broker();
  raise(ask(1), ask(2), ask(3, { typed: true }));

  fireEvent.click(button("Allow for 15 minutes"));
  await waitFor(() => {
    expect(dialog(/^Allow Terminal 2 /)).toBeTruthy();
  });
  fireEvent.click(button(/^Deny/));
  await waitFor(() => {
    expect(dialog(/^Allow Terminal 3 /)).toBeTruthy();
  });

  fireEvent.change(screen.getByLabelText("Type staging to confirm"), {
    target: { value: "staging" },
  });
  fireEvent.click(button("Allow for 15 minutes"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answers).toEqual([
    { id: 1, answer: "lasting", typed: null },
    { id: 2, answer: "deny", typed: null },
    { id: 3, answer: "lasting", typed: "staging" },
  ]);
});

test("the lasting button names the minutes the ask offers, and none is offered without them", async () => {
  const { raise } = await broker();
  raise(ask(1, { lastingMinutes: 1 }), ask(2, { lastingMinutes: null }));
  expect(button("Allow for 1 minute")).toBeTruthy();
  fireEvent.click(button("Allow once"));
  await waitFor(() => {
    expect(dialog(/^Allow Terminal 2 /)).toBeTruthy();
  });
  expect(screen.queryByRole("button", { name: /^Allow for / })).toBeNull();
});

test("Escape denies, and focus starts on Deny, so a stray Enter allows nothing", async () => {
  const { raise, answers } = await broker();
  raise(ask(1), ask(2));
  expect(document.activeElement).toBe(button(/^Deny/));

  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await waitFor(() => {
    expect(dialog(/^Allow Terminal 2 /)).toBeTruthy();
  });
  expect(answers).toEqual([{ id: 1, answer: "deny", typed: null }]);
  expect(document.activeElement).toBe(button(/^Deny/));
});

test("a refused answer shows its words in the dialog, which stays, and the next try goes through", async () => {
  const { raise, control, answers } = await broker();
  raise(DELETE);
  fireEvent.change(screen.getByLabelText("Type prod-eu to confirm"), {
    target: { value: "prod-eu" },
  });
  control.refuse = new IpcError("invalidInput", "type prod-eu to confirm");
  fireEvent.click(button("Allow delete"));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toContain(
      "type prod-eu to confirm",
    );
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(button("Allow delete").hasAttribute("disabled")).toBe(false);

  control.refuse = undefined;
  fireEvent.click(button("Allow delete"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answers).toHaveLength(2);
});

test("while an answer is on its way nothing else answers, and a withdrawal then says nothing", async () => {
  const { raise, control, withdraw, answers } = await broker();
  const info = vi.spyOn(notify, "info");
  let release: () => void = () => undefined;
  control.hold = new Promise((resolve) => {
    release = resolve;
  });
  raise(ask(1), ask(2));
  fireEvent.click(button("Allow once"));
  await waitFor(() => {
    expect(button("Allow once").hasAttribute("disabled")).toBe(true);
  });
  fireEvent.click(button("Allow for 15 minutes"));
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  expect(answers).toHaveLength(1);

  withdraw(1);
  expect(info).not.toHaveBeenCalled();
  release();
  await waitFor(() => {
    expect(dialog(/^Allow Terminal 2 /)).toBeTruthy();
  });
  expect(button("Allow once").hasAttribute("disabled")).toBe(false);
});

test("the dialog says whose context it is, what the client claims and the detail the feature draws", async () => {
  const { raise } = await broker();
  raise(
    ask(1, {
      command: "kubectl set image",
      impersonate: "system:serviceaccount:default:deployer",
    }),
    DELETE,
  );
  expect(screen.getByText("Staging")).toBeTruthy();
  expect(screen.getByText("staging")).toBeTruthy();
  expect(screen.getByText("The client says it runs")).toBeTruthy();
  expect(screen.getByText("kubectl set image")).toBeTruthy();
  expect(screen.getByText("Acting as")).toBeTruthy();
  expect(
    screen.getByText("system:serviceaccount:default:deployer"),
  ).toBeTruthy();
  expect(screen.getByText("Detail of a diff")).toBeTruthy();
  expect(screen.getByRole("dialog").className).toContain("max-w-[880px]");

  fireEvent.click(button("Allow once"));
  await waitFor(() => {
    expect(screen.getByText("Production")).toBeTruthy();
  });
  expect(screen.getByText("Detail of a delete")).toBeTruthy();
  expect(screen.queryByText("The client says it runs")).toBeNull();
  expect(screen.getByRole("dialog").className).toContain("max-w-[480px]");
});

const planned = (workbench: Awaited<ReturnType<typeof broker>>["workbench"]) =>
  workbench.operations.run(REQUEST, { icon: Trash2 });

const titles = () =>
  [...document.querySelectorAll('[data-slot="dialog-content"] h2')].map(
    (title) => title.textContent,
  );

test("an ask that arrives while a plan's confirmation is open waits, and takes neither its focus nor its Escape", async () => {
  const { workbench, raise, answers } = await broker();
  const outcome = planned(workbench);
  await waitFor(() => {
    expect(titles()).toEqual(["Delete pod web-1 in default from dev?"]);
  });
  expect(document.activeElement).toBe(button(/^Cancel/));

  raise(ask(1));
  expect(titles()).toEqual(["Delete pod web-1 in default from dev?"]);
  expect(document.activeElement).toBe(button(/^Cancel/));

  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await expect(outcome).resolves.toEqual({ state: "cancelled" });
  expect(answers).toEqual([]);
  await waitFor(() => {
    expect(titles()).toEqual([
      "Allow Terminal 1 to patch deployments/web in default on staging?",
    ]);
  });
  expect(document.activeElement).toBe(button(/^Deny/));
  expect(answers).toEqual([]);
});

test("a plan's confirmation that opens over an ask takes the screen, and the ask comes back after it, unanswered", async () => {
  const { workbench, raise, answers } = await broker();
  raise(ask(1));
  expect(titles()).toHaveLength(1);

  const outcome = planned(workbench);
  await waitFor(() => {
    expect(titles()).toEqual(["Delete pod web-1 in default from dev?"]);
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(button(/^Cancel/));
  });

  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await expect(outcome).resolves.toEqual({ state: "cancelled" });
  await waitFor(() => {
    expect(titles()).toEqual([
      "Allow Terminal 1 to patch deployments/web in default on staging?",
    ]);
  });
  expect(document.activeElement).toBe(button(/^Deny/));
  expect(screen.getByText("Allow once")).toBeTruthy();
  expect(answers).toEqual([]);
});
