import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type {
  KubeconfigOffer,
  KubeconfigOfferEvent,
  ShellMessage,
  TerminalSession,
} from "../generated";
import {
  createMockBackend,
  MOCK_SCENARIOS,
  OFFER_AFTER_MS,
  type MockScenario,
} from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function answered<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0);
  return promise;
}

async function refused(promise: Promise<unknown>): Promise<IpcError> {
  const caught = promise.then(
    () => {
      throw new Error("it was not refused");
    },
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  const error = await caught;
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

async function created(
  scenario: MockScenario,
  context: string,
): Promise<TerminalSession> {
  const backend = createMockBackend(scenario);
  return answered(
    backend.invoke("terminal_create", { context, label: "Terminal 1" }),
  );
}

interface Opened {
  readonly backend: ReturnType<typeof createMockBackend>;
  readonly session: TerminalSession;
  readonly messages: ShellMessage[];
  readonly text: () => string;
  readonly type: (text: string) => Promise<void>;
}

/** How long `opened` lets the shell run before it returns. */
const SETTLE_MS = 200;

async function opened(
  context: string,
  scenario: MockScenario = "live",
  label = "Terminal 1",
  backend = createMockBackend(scenario),
): Promise<Opened> {
  const session = await answered(
    backend.invoke("terminal_create", { context, label }),
  );
  const messages: ShellMessage[] = [];
  await answered(
    backend.subscribe(
      "shell_open",
      { id: session.id, cols: 80, rows: 24 },
      (message) => {
        messages.push(message);
      },
    ),
  );
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  return {
    backend,
    session,
    messages,
    text: () =>
      messages
        .filter((message): message is ArrayBuffer => "byteLength" in message)
        .map((frame) => new TextDecoder().decode(frame))
        .join(""),
    type: async (text) => {
      await answered(
        backend.invoke("shell_input", {
          id: session.id,
          data: Array.from(new TextEncoder().encode(text)),
        }),
      );
    },
  };
}

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const events = (messages: readonly ShellMessage[]) =>
  messages.flatMap((message) => ("state" in message ? [message] : []));

test("a terminal of a read-write context goes by the person's credentials, any other through the proxy by its mode", async () => {
  expect(await created("live", "dev")).toEqual({
    id: expect.any(Number) as number,
    kind: { kind: "kubeconfig" },
    shell: "zsh",
  });
  expect((await created("live", "staging")).kind).toEqual({
    kind: "proxy",
    why: "mode",
  });
  expect((await created("live", "prod-eu")).kind).toEqual({
    kind: "proxy",
    why: "mode",
  });
});

test("the policy file sends the contexts it lists in terminal.usePolicyProxy through the proxy for that, and the others by their mode", async () => {
  expect((await created("policyFile", "dev")).kind).toEqual({
    kind: "proxy",
    why: "policyFile",
  });
  expect((await created("policyFile", "prod-eu")).kind).toEqual({
    kind: "proxy",
    why: "mode",
  });
  expect((await created("policyFile", "staging")).kind).toEqual({
    kind: "proxy",
    why: "mode",
  });
  expect((await created("live", "dev")).kind).toEqual({ kind: "kubeconfig" });
});

test("an unlocked context goes through the proxy for its mode", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("context_unlock", "prod-eu"));
  const unlocked = await answered(
    backend.invoke("terminal_create", { context: "prod-eu", label: "T" }),
  );
  expect(unlocked.kind).toEqual({ kind: "proxy", why: "mode" });
});

test("a terminal of a context the catalog does not list is not found", async () => {
  const backend = createMockBackend("live");
  const error = await refused(
    backend.invoke("terminal_create", { context: "nowhere", label: "T" }),
  );
  expect(error.kind).toBe("notFound");
});

test("a terminal connects, shows its prompt, and keeps what was typed while it connected", async () => {
  const backend = createMockBackend("live");
  const session = await answered(
    backend.invoke("terminal_create", { context: "dev", label: "Terminal 1" }),
  );
  const messages: ShellMessage[] = [];
  await answered(
    backend.subscribe(
      "shell_open",
      { id: session.id, cols: 80, rows: 24 },
      (message) => {
        messages.push(message);
      },
    ),
  );
  await vi.advanceTimersByTimeAsync(10);
  await answered(
    backend.invoke("shell_input", {
      id: session.id,
      data: Array.from(new TextEncoder().encode("exit 3\r")),
    }),
  );
  await vi.advanceTimersByTimeAsync(200);
  expect(events(messages)).toEqual([
    { state: "connecting" },
    { state: "running" },
    { state: "ended", end: { reason: "exited", code: 3 } },
  ]);
});

test("the prompt echoes what is typed and Backspace takes a character back", async () => {
  const shell = await opened("dev");
  expect(shell.text()).toBe("you@mac ~ % ");
  await shell.type("kubx");
  await shell.type("\x7f");
  await shell.type("ctl");
  expect(shell.text()).toBe("you@mac ~ % kubx\b \bctl");
});

test("kubectl config current-context prints the context of the terminal", async () => {
  for (const context of ["dev", "staging"]) {
    const shell = await opened(context);
    await shell.type("kubectl config current-context\r");
    expect(shell.text()).toContain(`\r\n${context}\r\nyou@mac ~ % `);
  }
});

test("$KUBECONFIG says the kind: Twigo's file and then the user's, or the proxy's alone", async () => {
  const own = await opened("dev");
  await own.type("echo $KUBECONFIG\r");
  const [first, second, ...more] =
    own.text().split("\r\n")[1]?.split(":") ?? [];
  expect(first).toContain(`/terminals/${String(own.session.id)}/kubeconfig`);
  expect(second).toBe("/Users/you/.kube/config");
  expect(more).toEqual([]);

  const proxied = await opened("staging");
  await proxied.type("echo $KUBECONFIG\r");
  const line = proxied.text().split("\r\n")[1] ?? "";
  expect(line).toContain(
    `/terminals/${String(proxied.session.id)}/proxy-kubeconfig`,
  );
  expect(line).not.toContain(".kube/config");
});

test("exit ends the session as exited with its code, and exit alone with 0", async () => {
  const failing = await opened("dev");
  await failing.type("exit 2\r");
  expect(last(events(failing.messages))).toEqual({
    state: "ended",
    end: { reason: "exited", code: 2 },
  });
  const quiet = await opened("dev");
  await quiet.type("exit\r");
  expect(last(events(quiet.messages))).toEqual({
    state: "ended",
    end: { reason: "exited", code: 0 },
  });
  const typed = await opened("dev");
  await typed.type("exit now\r");
  expect(last(events(typed.messages))).toEqual({ state: "running" });
});

test("kill -9 $$ ends the session as signaled with KILL", async () => {
  const shell = await opened("dev");
  await shell.type("kill -9 $$\r");
  expect(last(events(shell.messages))).toEqual({
    state: "ended",
    end: { reason: "signaled", signal: "KILL" },
  });
});

test("clear clears the screen and shows a prompt once", async () => {
  const shell = await opened("dev");
  await shell.type("clear\r");
  const after = shell.text().split("\r\n")[1] ?? "";
  expect(after).toBe("\x1b[H\x1b[2J\x1b[3Jyou@mac ~ % ");
});

test("any other command is not found, by its first word", async () => {
  const shell = await opened("dev");
  await shell.type("helm list -A\r");
  expect(shell.text()).toContain("\r\nzsh: command not found: helm\r\n");
  await shell.type("kubectl get pods\r");
  expect(shell.text()).toContain("\r\nzsh: command not found: kubectl\r\n");
});

test("a session that closed takes no more, and an ended one refuses input as the shells do", async () => {
  const shell = await opened("dev");
  await shell.type("exit\r");
  const error = await refused(
    shell.backend.invoke("shell_input", { id: shell.session.id, data: [97] }),
  );
  expect(error.kind).toBe("conflict");
  await answered(shell.backend.invoke("shell_close", shell.session.id));
  const gone = await refused(
    shell.backend.invoke("shell_input", { id: shell.session.id, data: [97] }),
  );
  expect(gone.kind).toBe("notFound");
});

async function followed(scenario: MockScenario) {
  const backend = createMockBackend(scenario);
  const events: KubeconfigOfferEvent[] = [];
  const first = await answered(
    backend.subscribe("kubeconfig_offers_watch", null, (event) => {
      events.push(event);
    }),
  );
  return { backend, events, first };
}

const offers = (events: readonly KubeconfigOfferEvent[]): KubeconfigOffer[] =>
  events.flatMap((event) => (event.event === "offered" ? [event.offer] : []));

test("an offer comes 3 s after a terminal opens, from that terminal, with one name that the person's files hold", async () => {
  const { backend, events } = await followed("terminalOffer");
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS * 2);
  expect(events).toEqual([]);
  await opened("dev", "terminalOffer", "Terminal 4", backend);
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS - SETTLE_MS - 1);
  expect(events.length).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  const [offer, ...more] = offers(events);
  expect(more).toEqual([]);
  expect(offer?.terminal).toBe("Terminal 4");
  expect(offer?.target).toBe("~/.kube/config");
  expect(offer?.contexts).toEqual(offer?.clusters);
  expect(offer?.contexts[0]).toMatch(
    /^arn:aws:eks:[a-z0-9-]+:\d{12}:cluster\//,
  );
  expect(offer?.taken).toHaveLength(1);
  expect(offer?.contexts).toContain(offer?.taken[0]);
});

test("the second offer comes 3 s after the first is answered, which withdraws the first, and nothing follows the second", async () => {
  const { backend, events } = await followed("terminalOffer");
  await opened("dev", "terminalOffer", "Terminal 1", backend);
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS - SETTLE_MS);
  const [first] = offers(events);
  if (!first) throw new Error("no first offer");
  await opened("staging", "terminalOffer", "Terminal 2", backend);
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS * 3);
  expect(offers(events)).toHaveLength(1);

  await answered(
    backend.invoke("kubeconfig_offer_answer", { id: first.id, answer: "move" }),
  );
  expect(last(events)).toEqual({ event: "withdrawn", id: first.id });
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS - 1);
  expect(offers(events)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  const [, second] = offers(events);
  expect(second?.id).not.toBe(first.id);
  expect(second?.taken).toEqual([]);

  if (!second) throw new Error("no second offer");
  await answered(
    backend.invoke("kubeconfig_offer_answer", {
      id: second.id,
      answer: "dismiss",
    }),
  );
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS * 3);
  expect(offers(events)).toHaveLength(2);
});

test("a window that follows later is told the offers that wait, and answering one that is gone is refused", async () => {
  const backend = createMockBackend("terminalOffer");
  await opened("dev", "terminalOffer", "Terminal 1", backend);
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS);
  const waiting = await answered(
    backend.subscribe("kubeconfig_offers_watch", null, () => undefined),
  );
  expect(waiting).toHaveLength(1);
  const [offer] = waiting;
  if (!offer) throw new Error("no offer");
  await answered(
    backend.invoke("kubeconfig_offer_answer", { id: offer.id, answer: "move" }),
  );
  const error = await refused(
    backend.invoke("kubeconfig_offer_answer", { id: offer.id, answer: "move" }),
  );
  expect(error.kind).toBe("notFound");
});

test("any other scenario raises no offer, and the scenario is one the page can pin", async () => {
  const { backend, events, first } = await followed("live");
  await opened("dev", "live", "Terminal 1", backend);
  await vi.advanceTimersByTimeAsync(OFFER_AFTER_MS * 3);
  expect(first).toEqual([]);
  expect(events).toEqual([]);
  expect(MOCK_SCENARIOS).toContain("terminalOffer");
});
