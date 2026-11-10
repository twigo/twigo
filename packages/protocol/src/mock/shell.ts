import { IpcError } from "../error";
import type {
  OpenShell,
  ShellContainers,
  ShellEnd,
  ShellEvent,
  ShellKind,
  ShellMessage,
  ShellTarget,
} from "../generated";
import { SHELL_FRAME_BYTES, SHELL_HIGH_WATER, SHELL_LOW_WATER } from "../shell";
import type { Pod } from "./cluster";

/**
 * Pins what a shell does: `shellQueued` waits for a place among the
 * cluster's sessions, `shellNoShell` finds no shell in the container,
 * `shellLost` loses its connection and `shellRelocked` its context's write
 * mode a while after it opens, `shellOneContainer` runs one container in
 * every pod, so no picker asks, `shellDefaultSecond` has the pods'
 * default-container annotation name the second container, so the default is
 * not the first, and `shellAttachInteractive` gives the containers a
 * terminal and stdin, so an attach takes what is typed. Any other scenario
 * runs two or three containers, which keep neither, as most servers' do.
 */
export type ShellScenario =
  | "shellQueued"
  | "shellNoShell"
  | "shellLost"
  | "shellRelocked"
  | "shellOneContainer"
  | "shellDefaultSecond"
  | "shellAttachInteractive";

export const SHELL_SCENARIOS: readonly ShellScenario[] = [
  "shellQueued",
  "shellNoShell",
  "shellLost",
  "shellRelocked",
  "shellOneContainer",
  "shellDefaultSecond",
  "shellAttachInteractive",
];

/** How a session joins its process: a shell with a terminal and stdin, an attach as its container keeps them. */
export function joins(
  kind: ShellKind,
  scenario: ShellScenario | undefined,
): { readonly tty: boolean; readonly stdin: boolean } {
  const both = kind === "shell" || scenario === "shellAttachInteractive";
  return { tty: both, stdin: both };
}

export function isShellScenario(scenario: string): scenario is ShellScenario {
  return (SHELL_SCENARIOS as readonly string[]).includes(scenario);
}

/** How long `shellQueued` waits for a place, and how long `shellLost` and `shellRelocked` run. */
export const QUEUED_MS = 5000;
export const ENDS_AFTER_MS = 8000;
const CONNECT_MS = 150;
/** An attached process writes a line this often. */
const LINE_MS = 1000;

/** The recorded pods' containers, as the logs' streams name them. */
const NAMES = ["api", "istio-proxy", "log-shipper"];

/**
 * The containers of a pod a shell can reach: those that run, a pod that
 * runs none refused in words. The mock's pods run two or three, in the order
 * of their statuses, and the first is the default unless an annotation names
 * another, as Rust answers.
 */
export function shellContainers(
  pod: Pod,
  scenario: ShellScenario | undefined,
): ShellContainers {
  if (pod.status !== "Running") {
    throw new IpcError(
      "invalidInput",
      `pod ${pod.name} is ${pod.status}, so it runs no container to open a shell in`,
    );
  }
  const count =
    scenario === "shellOneContainer" ? 1 : Math.max(2, pod.containers);
  const containers = NAMES.slice(0, count);
  const annotated = scenario === "shellDefaultSecond" ? 1 : 0;
  return { containers, default: containers[annotated] ?? "api" };
}

const FILES = [
  "\x1b[1;34mbin\x1b[0m",
  "\x1b[1;34metc\x1b[0m",
  "\x1b[1;34mvar\x1b[0m",
  "\x1b[1;32mentrypoint.sh\x1b[0m",
  "\x1b[1;36mcurrent\x1b[0m",
  "README.md",
  "журнал.log",
  "設定.yaml",
];

const encoder = new TextEncoder();
const FLOOD = encoder.encode("y\r\n".repeat(Math.floor(SHELL_FRAME_BYTES / 3)));

/** What bash writes before its first prompt: it asks for bracketed paste. */
const BRACKETED_PASTE = "\x1b[?2004h";

/** Whether an escape sequence, started by ESC, is complete. */
function complete(sequence: string): boolean {
  const kind = sequence[1];
  if (kind === undefined) return false;
  if (kind === "[") {
    const last = sequence.charCodeAt(sequence.length - 1);
    return sequence.length > 2 && last >= 0x40 && last <= 0x7e;
  }
  return kind !== "O" || sequence.length >= 3;
}

/**
 * A shell session of the mock backend: a small line-editing shell in a
 * container, or a process that an attach joins, over the channel Rust would
 * send, bytes and events in order. `yes` floods and honours the acks as
 * Rust does, at most a frame of 64 KiB at a time, stopping at 256 KiB
 * unacknowledged and starting again below 64 KiB.
 */
export class MockShell {
  readonly #target: ShellTarget;
  readonly #kind: ShellKind;
  readonly #joined: { readonly tty: boolean; readonly stdin: boolean };
  readonly #scenario: ShellScenario | undefined;
  readonly #onMessage: (message: ShellMessage) => void;
  readonly #relock: () => void;
  readonly #decoder = new TextDecoder();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #size: { cols: number; rows: number };
  #state: ShellEvent["state"] = "connecting";
  #ahead = "";
  #line = "";
  #escape = "";
  #pasting = false;
  #flooding = false;
  #pumping = false;
  #unacked = 0;

  /** `relock` makes the target's context read-only, which `shellRelocked` does when it ends. */
  constructor(
    target: ShellTarget,
    kind: ShellKind,
    open: OpenShell,
    scenario: ShellScenario | undefined,
    relock: () => void,
    onMessage: (message: ShellMessage) => void,
  ) {
    this.#target = target;
    this.#kind = kind;
    this.#joined = joins(kind, scenario);
    this.#scenario = scenario;
    this.#relock = relock;
    this.#onMessage = onMessage;
    this.#size = { cols: open.cols, rows: open.rows };
    this.#later(0, () => {
      if (scenario === "shellQueued") {
        this.#event({ state: "queued" });
        this.#later(QUEUED_MS, () => {
          this.#connect();
        });
      } else {
        this.#connect();
      }
    });
    if (scenario === "shellLost" || scenario === "shellRelocked") {
      this.#later(ENDS_AFTER_MS, () => {
        if (scenario === "shellRelocked") this.#relock();
        this.#end(
          scenario === "shellLost"
            ? { reason: "connectionLost" }
            : { reason: "relocked" },
        );
      });
    }
  }

  /** Keeps what is typed before the process runs and gives it to the process then, as Rust's queue does. */
  input(data: readonly number[]): void {
    if (!this.#joined.stdin) return;
    const text = this.#decoder.decode(Uint8Array.from(data), { stream: true });
    if (this.#state === "connecting" || this.#state === "queued") {
      this.#ahead += text;
      return;
    }
    if (this.#state !== "running") {
      throw new IpcError("conflict", "the shell does not run");
    }
    for (const character of text) this.#key(character);
  }

  resize(cols: number, rows: number): void {
    this.#size = { cols, rows };
  }

  ack(bytes: number): void {
    this.#unacked = Math.max(0, this.#unacked - bytes);
    if (this.#flooding && this.#unacked < SHELL_LOW_WATER) this.#pump();
  }

  close(): void {
    this.#state = "ended";
    this.#flooding = false;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #connect(): void {
    this.#event({ state: "connecting" });
    this.#later(CONNECT_MS, () => {
      if (this.#scenario === "shellNoShell") {
        this.#end({
          reason: "noShell",
          message: `OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown`,
        });
        return;
      }
      this.#event({ state: "running" });
      if (this.#kind === "attach") {
        this.#attached();
      } else {
        this.#write(BRACKETED_PASTE);
        this.#prompt();
      }
      const ahead = this.#ahead;
      this.#ahead = "";
      for (const character of ahead) this.#key(character);
    });
  }

  /** The joined process writes a line a second until it is stopped, with a bare line feed when it has no terminal. */
  #attached(): void {
    this.#later(LINE_MS, () => {
      const at = new Date().toISOString();
      const end = this.#joined.tty ? "\r\n" : "\n";
      this.#write(
        `\x1b[90m${at}\x1b[0m [${this.#target.container}] handled GET /healthz 200${end}`,
      );
      this.#attached();
    });
  }

  #prompt(): void {
    const { pod, container } = this.#target;
    this.#write(`\x1b[32mroot@${pod}\x1b[0m \x1b[34m[${container}]\x1b[0m # `);
  }

  #key(character: string): void {
    if (this.#escape !== "" || character === "\x1b") {
      this.#escape += character;
      if (!complete(this.#escape)) return;
      const sequence = this.#escape;
      this.#escape = "";
      if (sequence === "\x1b[200~") this.#pasting = true;
      if (sequence === "\x1b[201~") this.#pasting = false;
      return;
    }
    if (character === "\x03") {
      this.#interrupt();
      return;
    }
    if (this.#flooding) return;
    if (this.#kind === "attach") {
      this.#write(character === "\r" ? "\r\n" : character);
      return;
    }
    switch (character) {
      case "\r":
      case "\n":
        if (this.#pasting) {
          this.#line += "\n";
          this.#write("\r\n");
        } else {
          this.#submit();
        }
        return;
      case "\x7f":
      case "\b":
        if (this.#line !== "" && !this.#line.endsWith("\n")) {
          this.#line = this.#line.slice(0, -1);
          this.#write("\b \b");
        }
        return;
      case "\x04":
        if (this.#line === "") this.#exit(0);
        return;
      case "\x0c":
        this.#write(`\x1b[H\x1b[2J`);
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

  #interrupt(): void {
    if (this.#kind === "attach") {
      this.#write("^C\r\n");
      this.#end({ reason: "detached" });
      return;
    }
    this.#flooding = false;
    this.#line = "";
    this.#write("^C\r\n");
    this.#prompt();
  }

  #submit(): void {
    const lines = this.#line.split("\n");
    this.#line = "";
    this.#write("\r\n");
    for (const line of lines) {
      if (this.#state === "ended") return;
      this.#run(line.trim());
    }
    if (!this.#flooding && this.#state !== "ended") this.#prompt();
  }

  #run(command: string): void {
    const [name = "", ...args] = command.split(/\s+/);
    switch (name) {
      case "":
        return;
      case "echo":
        this.#write(`${args.join(" ")}\r\n`);
        return;
      case "ls":
        this.#write(`${FILES.join("  ")}\r\n`);
        return;
      case "stty":
        if (args[0] === "size") {
          this.#write(
            `${String(this.#size.rows)} ${String(this.#size.cols)}\r\n`,
          );
        } else {
          this.#write(`stty: unsupported: ${args.join(" ")}\r\n`);
        }
        return;
      case "exit": {
        const code = args[0] === undefined ? 0 : Number(args[0]);
        if (Number.isInteger(code)) {
          this.#exit(code);
        } else {
          this.#write(`exit: ${args[0] ?? ""}: numeric argument required\r\n`);
        }
        return;
      }
      case "yes":
        this.#flooding = true;
        this.#pump();
        return;
      default:
        this.#write(`sh: 1: ${name}: not found\r\n`);
    }
  }

  #exit(code: number): void {
    this.#write("exit\r\n");
    this.#end({ reason: "exited", code });
  }

  /** Writes a frame of `yes` whenever fewer than 256 KiB are unacknowledged. */
  #pump(): void {
    if (this.#pumping || !this.#flooding) return;
    this.#pumping = true;
    this.#later(0, () => {
      this.#pumping = false;
      if (!this.#flooding || this.#unacked >= SHELL_HIGH_WATER) return;
      this.#send(FLOOD.slice().buffer);
      this.#pump();
    });
  }

  #write(text: string): void {
    this.#send(encoder.encode(text).buffer);
  }

  #send(frame: ArrayBuffer): void {
    if (this.#state === "ended") return;
    this.#unacked += frame.byteLength;
    this.#onMessage(frame);
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
