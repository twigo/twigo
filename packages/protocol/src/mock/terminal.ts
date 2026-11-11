import { IpcError } from "../error";
import type {
  AnswerKubeconfigOffer,
  ContextAccess,
  KubeconfigOffer,
  KubeconfigOfferEvent,
  KubeconfigOfferId,
  ShellEnd,
  ShellEvent,
  ShellMessage,
  TerminalKind,
} from "../generated";
import { complete } from "./shell";

/**
 * Pins what the terminals' offers do (ARCHITECTURE 4.6): `terminalOffer`
 * raises an offer to move what a tool wrote into a terminal's own kubeconfig
 * a while after the first terminal opens, and a second one a while after the
 * first is answered. Any other scenario raises none.
 */
export type TerminalScenario = "terminalOffer";

export const TERMINAL_SCENARIOS: readonly TerminalScenario[] = [
  "terminalOffer",
];

export function isTerminalScenario(
  scenario: string,
): scenario is TerminalScenario {
  return (TERMINAL_SCENARIOS as readonly string[]).includes(scenario);
}

/** How long after the first terminal opens the first offer comes, and how long after it is answered the second. */
export const OFFER_AFTER_MS = 3000;
const START_MS = 100;

const POLICY_FILE_PROXY: readonly string[] = ["dev"];

/**
 * How a context's terminal reaches clusters: through the proxy when the
 * policy file lists the context in `terminal.usePolicyProxy`, whatever its
 * mode, or when the context was not read-write, an unlock included, else with
 * the user's own credentials. A mode the file sets makes the proxy's reason
 * the mode, not the file.
 */
export function terminalKind(
  context: string,
  { mode }: ContextAccess,
  policyFile: boolean,
): TerminalKind {
  if (policyFile && POLICY_FILE_PROXY.includes(context)) {
    return { kind: "proxy", why: "policyFile" };
  }
  return mode === "read-write"
    ? { kind: "kubeconfig" }
    : { kind: "proxy", why: "mode" };
}

const PROMPT = "you@mac ~ % ";
const HOME_CONFIG = "/Users/you/.kube/config";
const APP_DATA = "/Users/you/Library/Application Support/io.twigo.ide";

/** What `$KUBECONFIG` holds: Twigo's file and then the user's, or the proxy's alone. */
function kubeconfigPath(id: number, kind: TerminalKind): string {
  return kind.kind === "kubeconfig"
    ? `${APP_DATA}/terminals/${String(id)}/kubeconfig:${HOME_CONFIG}`
    : `${APP_DATA}/proxy/process-${String(id)}.kubeconfig`;
}

const CLEAR = "\x1b[H\x1b[2J\x1b[3J";

const encoder = new TextEncoder();

/**
 * A terminal session of the mock backend: a small line-editing zsh on this
 * machine, over the channel Rust would send, bytes and events in order.
 */
export class MockTerminal {
  readonly #id: number;
  readonly #context: string;
  readonly #kind: TerminalKind;
  readonly #onMessage: (message: ShellMessage) => void;
  readonly #decoder = new TextDecoder();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #state: ShellEvent["state"] = "connecting";
  #ahead = "";
  #line = "";
  #escape = "";

  constructor(
    id: number,
    context: string,
    kind: TerminalKind,
    onMessage: (message: ShellMessage) => void,
  ) {
    this.#id = id;
    this.#context = context;
    this.#kind = kind;
    this.#onMessage = onMessage;
    this.#later(0, () => {
      this.#event({ state: "connecting" });
      this.#later(START_MS, () => {
        this.#event({ state: "running" });
        this.#prompt();
        const ahead = this.#ahead;
        this.#ahead = "";
        for (const character of ahead) this.#key(character);
      });
    });
  }

  /** Keeps what is typed before the shell runs and gives it to the shell then, as Rust's queue does. */
  input(data: readonly number[]): void {
    const text = this.#decoder.decode(Uint8Array.from(data), { stream: true });
    if (this.#state === "connecting") {
      this.#ahead += text;
      return;
    }
    if (this.#state !== "running") {
      throw new IpcError("conflict", "the shell does not run");
    }
    for (const character of text) this.#key(character);
  }

  resize(): void {
    return undefined;
  }

  ack(): void {
    return undefined;
  }

  close(): void {
    this.#state = "ended";
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #prompt(): void {
    this.#write(PROMPT);
  }

  #key(character: string): void {
    if (this.#escape !== "" || character === "\x1b") {
      this.#escape += character;
      if (complete(this.#escape)) this.#escape = "";
      return;
    }
    switch (character) {
      case "\r":
      case "\n":
        this.#submit();
        return;
      case "\x7f":
      case "\b":
        if (this.#line !== "") {
          this.#line = this.#line.slice(0, -1);
          this.#write("\b \b");
        }
        return;
      case "\x03":
        this.#line = "";
        this.#write("^C\r\n");
        this.#prompt();
        return;
      case "\x04":
        if (this.#line === "") this.#end({ reason: "exited", code: 0 });
        return;
      case "\x0c":
        this.#write(CLEAR);
        this.#prompt();
        this.#write(this.#line);
        return;
      default:
        if (character >= " ") {
          this.#line += character;
          this.#write(character);
        }
    }
  }

  #submit(): void {
    const command = this.#line.trim();
    this.#line = "";
    this.#write("\r\n");
    this.#run(command);
    if (this.#state === "running") this.#prompt();
  }

  #run(command: string): void {
    const [name = "", ...args] = command.split(/\s+/);
    switch (name) {
      case "":
        return;
      case "echo":
        this.#write(
          `${args.join(" ").replace(/\$KUBECONFIG/g, () => kubeconfigPath(this.#id, this.#kind))}\r\n`,
        );
        return;
      case "clear":
        this.#write(CLEAR);
        return;
      case "kubectl":
        if (args.join(" ") === "config current-context") {
          this.#write(`${this.#context}\r\n`);
          return;
        }
        break;
      case "kill":
        if (args.join(" ") === "-9 $$") {
          this.#end({ reason: "signaled", signal: "KILL" });
          return;
        }
        break;
      case "exit": {
        const code = args[0] === undefined ? 0 : Number(args[0]);
        if (Number.isInteger(code)) {
          this.#end({ reason: "exited", code });
        } else {
          this.#write(`exit: bad math expression: ${args[0] ?? ""}\r\n`);
        }
        return;
      }
    }
    this.#write(`zsh: command not found: ${name}\r\n`);
  }

  #write(text: string): void {
    if (this.#state === "ended") return;
    this.#onMessage(encoder.encode(text).buffer);
  }

  #event(event: ShellEvent): void {
    if (this.#state === "ended") return;
    this.#state = event.state;
    this.#onMessage(event);
  }

  #end(end: ShellEnd): void {
    if (this.#state === "ended") return;
    this.#event({ state: "ended", end });
    this.close();
  }

  #later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, ms);
    this.#timers.add(timer);
  }
}

type Draft = Omit<KubeconfigOffer, "id" | "terminal" | "session" | "context">;

const EKS = "arn:aws:eks:eu-west-1:123456789012:cluster";
const TARGET = "~/.kube/config";

/**
 * What `aws eks update-kubeconfig` writes twice: the user's files have a
 * context named like the second of the first two, so a move leaves out that
 * context and the cluster and the user only it names.
 */
const DRAFTS: readonly Draft[] = [
  {
    contexts: [`${EKS}/prod-eu-2`, `${EKS}/prod-eu-3`],
    clusters: [`${EKS}/prod-eu-2`, `${EKS}/prod-eu-3`],
    users: [`${EKS}/prod-eu-2`, `${EKS}/prod-eu-3`],
    target: TARGET,
    left_out: {
      contexts: [`${EKS}/prod-eu-3`],
      clusters: [`${EKS}/prod-eu-3`],
      users: [`${EKS}/prod-eu-3`],
    },
  },
  {
    contexts: [`${EKS}/staging-us`],
    clusters: [`${EKS}/staging-us`],
    users: [`${EKS}/staging-us`],
    target: TARGET,
    left_out: { contexts: [], clusters: [], users: [] },
  },
];

type Source = Pick<KubeconfigOffer, "terminal" | "session" | "context">;

/**
 * The offers of a window's terminals as the window sees them: it hears those
 * waiting and every new one, and an answer withdraws its offer, which the
 * broker refuses for one that is gone.
 */
export class MockOffers {
  readonly #waiting = new Map<KubeconfigOfferId, KubeconfigOffer>();
  #follower: ((event: KubeconfigOfferEvent) => void) | undefined;
  #coming: Draft[] = [...DRAFTS];
  #started = false;
  #source: Source | undefined;
  #next = 1;

  constructor(private readonly scenario: TerminalScenario | undefined) {}

  watch(onMessage: (event: KubeconfigOfferEvent) => void): KubeconfigOffer[] {
    this.#follower = onMessage;
    return [...this.#waiting.values()];
  }

  /** The first terminal to open is the one the offers come from. */
  opened(source: Source): void {
    if (this.scenario === undefined || this.#started) return;
    this.#started = true;
    this.#source = source;
    this.#later();
  }

  answer({ id }: AnswerKubeconfigOffer): null {
    if (!this.#waiting.delete(id)) {
      throw new IpcError("notFound", `the offer ${String(id)} is gone`);
    }
    this.#follower?.({ event: "withdrawn", id });
    this.#later();
    return null;
  }

  #later(): void {
    setTimeout(() => {
      const draft = this.#coming.shift();
      if (draft === undefined || this.#source === undefined) return;
      const offer: KubeconfigOffer = {
        ...draft,
        ...this.#source,
        id: this.#next++,
      };
      this.#waiting.set(offer.id, offer);
      this.#follower?.({ event: "offered", offer });
    }, OFFER_AFTER_MS);
  }
}
