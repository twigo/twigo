import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  IpcError,
  type Backend,
  type KubeconfigOffer,
  type KubeconfigOfferEvent,
} from "@twigo/protocol";
import { createMockBackend, OFFER_AFTER_MS } from "@twigo/protocol/mock";
import { WorkbenchView, type Workbench } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { withTerminalLayout } from "../../test/terminal";
import { terminalUri } from "../uri";
import { KubeconfigOffers } from "./offers";
import { createTerminalTabs, registerTerminals } from "./register";
import type { TerminalTabs } from "./tabs";

withScreenSize(1400);
withTerminalLayout();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

/** Sonner keeps its toasts between tests, so each test takes down the offers it left. */
const withdrawals: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const withdraw of withdrawals.splice(0)) await act(withdraw);
  history.replaceState(null, "", "/");
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ARN = "arn:aws:eks:eu-west-1:123456789012:cluster";

function offer(
  id: number,
  more: Partial<KubeconfigOffer> = {},
): KubeconfigOffer {
  return {
    id,
    terminal: "Terminal 1",
    session: 1,
    context: "dev",
    contexts: [`${ARN}/a`],
    clusters: [`${ARN}/a`],
    users: [`${ARN}/a`],
    target: "~/.kube/config",
    leftOut: { contexts: [], clusters: [], users: [] },
    ...more,
  };
}

function fakeCore() {
  const calls: { command: string; request: unknown }[] = [];
  let send: (event: KubeconfigOfferEvent) => void = () => undefined;
  let answer: (waiting: KubeconfigOffer[]) => void = () => undefined;
  let refuse: Error | undefined;
  let hold: Promise<void> | undefined;
  const backend: Backend = {
    invoke(command, request) {
      calls.push({ command, request });
      if (refuse !== undefined) return Promise.reject(refuse);
      return (hold ?? Promise.resolve()).then(() => null as never);
    },
    subscribe(_command, _request, onMessage) {
      send = onMessage;
      return new Promise((resolve) => {
        answer = (waiting) => {
          resolve(waiting);
        };
      });
    },
  };
  return {
    backend,
    calls,
    send: (event: KubeconfigOfferEvent) => {
      send(event);
    },
    answerWatch: (waiting: KubeconfigOffer[]) => {
      answer(waiting);
    },
    refuseWith: (error: Error) => {
      refuse = error;
    },
    holdAnswers: () => {
      let release: () => void = () => undefined;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function followed(waiting: KubeconfigOffer[] = []) {
  const core = fakeCore();
  const report = vi.fn();
  const offers = new KubeconfigOffers(core.backend, report);
  const watching = offers.watch();
  core.answerWatch(waiting);
  await watching;
  return { core, offers, report };
}

const ids = (offers: KubeconfigOffers) => offers.offers.map(({ id }) => id);

test("the offers that wait are known at once, and each new one, replaced one and withdrawn one follows", async () => {
  const { core, offers } = await followed([offer(1), offer(2)]);
  expect(ids(offers)).toEqual([1, 2]);
  core.send({ event: "offered", offer: offer(3) });
  expect(ids(offers)).toEqual([1, 2, 3]);
  const more = offer(2, { contexts: [`${ARN}/a`, `${ARN}/b`] });
  core.send({ event: "offered", offer: more });
  expect(ids(offers)).toEqual([1, 2, 3]);
  expect(offers.offers[1]).toBe(more);
  core.send({ event: "withdrawn", id: 1 });
  expect(ids(offers)).toEqual([2, 3]);
  core.send({ event: "withdrawn", id: 99 });
  expect(ids(offers)).toEqual([2, 3]);
});

test("what the core tells before it answers the watch is newer than the answer", async () => {
  const core = fakeCore();
  const offers = new KubeconfigOffers(core.backend, vi.fn());
  const watching = offers.watch();
  const newer = offer(2, { users: [`${ARN}/b`] });
  core.send({ event: "withdrawn", id: 1 });
  core.send({ event: "offered", offer: newer });
  core.answerWatch([offer(1), offer(2), offer(3)]);
  await watching;
  expect(ids(offers)).toEqual([3, 2]);
  expect(offers.offers[1]).toBe(newer);
});

test("an answer goes to the core with the offer's id, takes the offer away once it is taken, and is sent once", async () => {
  const { core, offers } = await followed([offer(1), offer(2)]);
  const release = core.holdAnswers();
  const first = offers.answer(1, "move");
  const second = offers.answer(1, "move");
  expect(offers.answering(1)).toBe(true);
  expect(core.calls).toEqual([
    {
      command: "kubeconfig_offer_answer",
      request: { id: 1, answer: "move" },
    },
  ]);
  release();
  await Promise.all([first, second]);
  expect(offers.answering(1)).toBe(false);
  expect(ids(offers)).toEqual([2]);
  await offers.answer(1, "dismiss");
  expect(core.calls).toHaveLength(1);
});

test("an answer the core refuses is reported and leaves the offer to answer again", async () => {
  const { core, offers, report } = await followed([offer(1)]);
  const error = new Error("~/.kube/config is read-only");
  core.refuseWith(error);
  await offers.answer(1, "move");
  expect(report).toHaveBeenCalledWith(error);
  expect(ids(offers)).toEqual([1]);
  expect(offers.answering(1)).toBe(false);
});

test("an offer withdrawn while its answer is on its way is gone, and a refusal of that answer is no news", async () => {
  const { core, offers, report } = await followed([offer(1)]);
  core.refuseWith(new Error("the offer 1 is gone"));
  const answering = offers.answer(1, "move");
  core.send({ event: "withdrawn", id: 1 });
  await answering;
  expect(ids(offers)).toEqual([]);
  expect(report).not.toHaveBeenCalled();
});

test("a move the core refuses as a conflict is reported though the core withdrew its offer meanwhile", async () => {
  const { core, offers, report } = await followed([offer(1)]);
  const conflict = new IpcError(
    "conflict",
    "Nothing was moved into ~/.kube/config: your kubeconfig files changed since the offer was made, and a move would now also leave out the context prod, so nothing in the offer would move now.",
  );
  core.refuseWith(conflict);
  const answering = offers.answer(1, "move");
  core.send({ event: "withdrawn", id: 1 });
  await answering;
  expect(ids(offers)).toEqual([]);
  expect(report).toHaveBeenCalledWith(conflict);
});

interface Mounted {
  readonly workbench: Workbench;
  readonly tabs: TerminalTabs;
  readonly backend: Backend;
}

async function mounted(
  space = "dev",
  query = "",
  backend: Backend = createMockBackend("terminalOffer"),
): Promise<Mounted & { create: () => Promise<void> }> {
  history.replaceState(null, "", query === "" ? "/" : `/?variant=${query}`);
  const scenario = "terminalOffer";
  const workbench = await testWorkbench(scenario, backend, "mac");
  const tabs = createTerminalTabs(workbench);
  registerTerminals(workbench, tabs);
  await act(() => workbench.spaces.open(space));
  act(() => {
    workbench.spaces.select(space);
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  return {
    workbench,
    tabs,
    backend,
    create: async () => {
      const run = workbench.commands.execute(
        "k8s.terminal.new",
        workbench.keys.lookup(null),
      );
      await settle(10);
      await run;
    },
  };
}

function leave(backend: Backend) {
  withdrawals.push(async () => {
    for (const id of [1, 2]) {
      await backend
        .invoke("kubeconfig_offer_answer", { id, answer: "dismiss" })
        .catch(() => undefined);
    }
    await settle(4);
  });
}

const live = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-sonner-toast][data-removed="false"]',
    ),
  ].map((toast) => toast.textContent);

const toastButton = (name: string) => {
  const toast = document.querySelector<HTMLElement>(
    '[data-sonner-toast][data-removed="false"]',
  );
  if (!toast) throw new Error("no toast");
  return within(toast).getByRole("button", { name });
};

const FIRST =
  "Terminal 1 in dev added 2 contexts, 2 clusters and 2 users to its own kubeconfig.";
const SECOND =
  "Terminal 1 in dev added a context, a cluster and a user to its own kubeconfig.";

async function later(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await settle(2);
}

test("an offer comes as a toast that says what came and what a move leaves out, and stays until it is answered", async () => {
  const { backend, create } = await mounted();
  const invoke = vi.spyOn(backend, "invoke");
  await create();
  expect(live()).toEqual([]);
  await later(OFFER_AFTER_MS);
  const [toast, ...more] = live();
  expect(more).toEqual([]);
  expect(toast).toContain(FIRST);
  expect(toast).toContain(`${ARN}/prod-eu-2`);
  expect(toast).toContain(`${ARN}/prod-eu-3`);
  expect(toast).toContain("A move writes");
  expect(toast).toContain("A move leaves out");
  expect(toast).toContain(
    "Your files have a context of that name, or the cluster or user it names is another one there.",
  );
  expect(toast).toContain(
    "Your files have a cluster of that name, or only contexts left out name it.",
  );
  expect(toast).toContain(
    "Your files have a user of that name, or only contexts left out name it.",
  );
  await later(10 * 60_000);
  expect(live()).toHaveLength(1);

  fireEvent.click(toastButton("Move to ~/.kube/config"));
  await settle(4);
  expect(
    invoke.mock.calls.find(
      ([command]) => command === "kubeconfig_offer_answer",
    )?.[1],
  ).toEqual({ id: 1, answer: "move" });
  expect(live()).toEqual([]);
});

test("the second offer comes once the first is answered, and Dismiss answers it so", async () => {
  const { backend, create } = await mounted();
  const invoke = vi.spyOn(backend, "invoke");
  await create();
  await later(OFFER_AFTER_MS);
  fireEvent.click(toastButton("Dismiss"));
  await later(OFFER_AFTER_MS);
  const [toast, ...more] = live();
  expect(more).toEqual([]);
  expect(toast).toContain(SECOND);
  expect(toast).not.toContain("A move leaves out");
  fireEvent.click(toastButton("Dismiss"));
  await settle(4);
  expect(
    invoke.mock.calls
      .filter(([command]) => command === "kubeconfig_offer_answer")
      .map(([, request]) => request),
  ).toEqual([
    { id: 1, answer: "dismiss" },
    { id: 2, answer: "dismiss" },
  ]);
  expect(live()).toEqual([]);
});

test("an offer withdrawn by the core takes its toast down", async () => {
  const { backend, create } = await mounted();
  await create();
  await later(OFFER_AFTER_MS);
  expect(live()).toHaveLength(1);
  await act(() =>
    backend.invoke("kubeconfig_offer_answer", { id: 1, answer: "dismiss" }),
  );
  await settle(4);
  expect(live()).toEqual([]);
  leave(backend);
});

test("an offer replaced by the core shows its new words in the same toast", async () => {
  const core = fakeCore();
  const mock = createMockBackend("terminalOffer");
  await mounted("dev", "", {
    invoke: (command, request) =>
      command === "kubeconfig_offer_answer"
        ? core.backend.invoke(command, request)
        : mock.invoke(command, request),
    subscribe: (command, request, onMessage) =>
      command === "kubeconfig_offers_watch"
        ? core.backend.subscribe(command, request, onMessage)
        : mock.subscribe(command, request, onMessage),
  });
  core.answerWatch([]);
  await settle(4);
  act(() => {
    core.send({ event: "offered", offer: offer(7) });
  });
  await settle(4);
  expect(live()).toHaveLength(1);
  expect(live()[0]).toContain(
    "Terminal 1 in dev added a context, a cluster and a user",
  );
  act(() => {
    core.send({
      event: "offered",
      offer: offer(7, { users: [`${ARN}/a`, `${ARN}/b`] }),
    });
  });
  await settle(4);
  expect(live()).toHaveLength(1);
  expect(live()[0]).toContain("a context, a cluster and 2 users");
  withdrawals.push(async () => {
    core.send({ event: "withdrawn", id: 7 });
    await settle(4);
  });
});

test("an offer outlives the tab it came from, and still moves", async () => {
  const { workbench, backend, create } = await mounted();
  const invoke = vi.spyOn(backend, "invoke");
  await create();
  await later(OFFER_AFTER_MS);
  act(() => {
    workbench.editors.close(terminalUri({ space: "dev", n: 1 }));
  });
  await settle(6);
  expect(live()).toHaveLength(1);
  fireEvent.click(toastButton("Move to ~/.kube/config"));
  await settle(4);
  expect(
    invoke.mock.calls.find(
      ([command]) => command === "kubeconfig_offer_answer",
    )?.[1],
  ).toEqual({ id: 1, answer: "move" });
});

test("offer:bar shows the offer in a bar over its terminal, no toast, and a toast once the tab is closed", async () => {
  const { workbench, backend, create } = await mounted("dev", "offer:bar");
  await create();
  await later(OFFER_AFTER_MS);
  expect(live()).toEqual([]);
  const panel = document.querySelector('[aria-label="Panel"]');
  expect(panel?.textContent).toContain(FIRST);
  expect(panel?.textContent).toContain("Move to ~/.kube/config");

  act(() => {
    workbench.editors.close(terminalUri({ space: "dev", n: 1 }));
  });
  await settle(6);
  expect(
    document.querySelector('[aria-label="Panel"]')?.textContent,
  ).not.toContain(FIRST);
  expect(live()).toHaveLength(1);
  expect(live()[0]).toContain(FIRST);
  leave(backend);
});

test("offer:bar answers from the bar, which goes with the offer", async () => {
  const { backend, create } = await mounted("dev", "offer:bar");
  const invoke = vi.spyOn(backend, "invoke");
  await create();
  await later(OFFER_AFTER_MS);
  const panel = document.querySelector<HTMLElement>('[aria-label="Panel"]');
  if (!panel) throw new Error("no panel");
  fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
  await settle(4);
  expect(
    invoke.mock.calls.find(
      ([command]) => command === "kubeconfig_offer_answer",
    )?.[1],
  ).toEqual({ id: 1, answer: "dismiss" });
  expect(panel.textContent).not.toContain(FIRST);
  expect(live()).toEqual([]);
});

async function createIn(workbench: Workbench, space: string) {
  await act(() => workbench.spaces.open(space));
  act(() => {
    workbench.spaces.select(space);
  });
  await settle(6);
  const run = workbench.commands.execute(
    "k8s.terminal.new",
    workbench.keys.lookup(null),
  );
  await settle(10);
  await run;
}

const panelText = () =>
  document.querySelector('[aria-label="Panel"]')?.textContent ?? "";

test("offer:bar finds the tab by the session, so another space's terminal of the same label is not it", async () => {
  const { workbench, backend, create } = await mounted("dev", "offer:bar");
  await create();
  await createIn(workbench, "staging");
  await later(OFFER_AFTER_MS);
  expect(live()).toEqual([]);
  expect(panelText()).not.toContain(FIRST);

  act(() => {
    workbench.spaces.select("dev");
  });
  await settle(6);
  expect(live()).toEqual([]);
  expect(panelText()).toContain(FIRST);
  leave(backend);
});

test("offer:bar falls back to a toast once its terminal's tab is closed, and a later terminal of the same label in another space is not its tab", async () => {
  const { workbench, backend, create } = await mounted("dev", "offer:bar");
  await create();
  await later(OFFER_AFTER_MS);
  expect(panelText()).toContain(FIRST);

  act(() => {
    workbench.editors.close(terminalUri({ space: "dev", n: 1 }));
  });
  await settle(6);
  expect(live()).toHaveLength(1);
  expect(live()[0]).toContain(FIRST);

  await createIn(workbench, "staging");
  expect(panelText()).toContain("Terminal 1");
  expect(panelText()).not.toContain(FIRST);
  expect(live()).toHaveLength(1);
  leave(backend);
});

test("offer:bar falls back to a toast once its terminal is restarted, which is another session", async () => {
  const { tabs, backend, create } = await mounted("dev", "offer:bar");
  await create();
  await later(OFFER_AFTER_MS);
  expect(panelText()).toContain(FIRST);
  expect(live()).toEqual([]);

  const tab = tabs.get(terminalUri({ space: "dev", n: 1 }));
  act(() => {
    tab?.term.input("exit\r");
  });
  await settle(4);
  expect(panelText()).toContain(FIRST);
  fireEvent.click(screen.getByRole("button", { name: "Restart Terminal" }));
  await settle(10);
  expect(tab?.getStatus().state).toBe("running");
  expect(panelText()).not.toContain(FIRST);
  expect(live()).toHaveLength(1);
  expect(live()[0]).toContain(FIRST);
  leave(backend);
});
