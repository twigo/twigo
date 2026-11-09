import type { Backend, RequestOf } from "./backend";
import { toIpcError } from "./error";
import type {
  OpenShell,
  ShellEnd,
  ShellEvent,
  ShellMessage,
} from "./generated";

/**
 * What Rust holds a shell session to (ARCHITECTURE 3.2, 4.6), as the webview
 * tells it and the mock keeps it: the exec, attach and port-forward
 * sessions Twigo opens on one cluster, the most output bytes in a frame,
 * and the unacknowledged output at which it stops reading, and below which
 * it reads again.
 */
export const CLUSTER_SESSIONS = 64;
export const SHELL_FRAME_BYTES = 64 * 1024;
export const SHELL_HIGH_WATER = 256 * 1024;
export const SHELL_LOW_WATER = 64 * 1024;

/**
 * Where a session's output goes, usually a terminal's `write`: `parsed` is
 * called once the terminal has parsed the bytes, which is what Rust is told
 * for its flow control.
 */
export type ShellOutput = (bytes: Uint8Array, parsed: () => void) => void;

const CONNECTING: ShellEvent = { state: "connecting" };

/**
 * One shell tab's session as a store for `useSyncExternalStore`
 * (ARCHITECTURE 4.6): Rust sends the bytes of the process's output and its
 * events in order over one channel; the bytes go on to `output`, and Rust
 * hears what the terminal has parsed.
 */
export class ShellSession {
  readonly #backend: Backend;
  readonly #request: OpenShell;
  readonly #output: ShellOutput;
  readonly #report: (error: unknown) => void;
  readonly #listeners = new Set<() => void>();
  #state: ShellEvent = CONNECTING;
  #closed = false;
  /** What was typed while a `shell_input` was in flight. */
  #typed: Uint8Array[] = [];
  #typing = false;
  /** The size Rust was last told, and the size the terminal has now. */
  #sent: { cols: number; rows: number };
  #size: { cols: number; rows: number };
  #resizing = false;
  /** Bytes parsed since the last `shell_ack` went out. */
  #parsed = 0;
  #acking = false;

  constructor(
    backend: Backend,
    request: OpenShell,
    output: ShellOutput,
    report: (error: unknown) => void,
  ) {
    this.#backend = backend;
    this.#request = request;
    this.#output = output;
    this.#report = report;
    this.#sent = { cols: request.cols, rows: request.rows };
    this.#size = this.#sent;
    backend
      .subscribe("shell_open", request, (message) => {
        this.#receive(message);
      })
      .catch((error: unknown) => {
        this.#end({ reason: "failed", error: toIpcError(error) });
      });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): ShellEvent => this.#state;

  /**
   * Sends what was typed or pasted. One call is in flight at a time, and
   * what is typed meanwhile goes in the next, so the keys keep their order
   * whatever the transport does with concurrent calls.
   */
  input(data: Uint8Array): void {
    if (this.#state.state !== "running" || this.#closed) return;
    this.#typed.push(data);
    this.#type();
  }

  /** Tells Rust the terminal's size when it differs from the last one told. */
  resize(cols: number, rows: number): void {
    this.#size = { cols, rows };
    this.#resize();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    const ended = this.#state.state === "ended";
    this.#backend
      .invoke("shell_close", this.#request.id)
      .catch((error: unknown) => {
        if (!ended) this.#report(error);
      });
  }

  #receive(message: ShellMessage): void {
    if (this.#closed || this.#state.state === "ended") return;
    if ("state" in message) {
      this.#publish(message);
      if (message.state === "running") this.#resize();
      return;
    }
    const bytes = new Uint8Array(message);
    this.#output(bytes, () => {
      this.#parsed += bytes.length;
      this.#acknowledge();
    });
  }

  #end(end: ShellEnd): void {
    if (this.#closed || this.#state.state === "ended") return;
    this.#publish({ state: "ended", end });
  }

  #type(): void {
    if (this.#typing || this.#typed.length === 0) return;
    const length = this.#typed.reduce((sum, part) => sum + part.length, 0);
    const data = new Uint8Array(length);
    let at = 0;
    for (const part of this.#typed) {
      data.set(part, at);
      at += part.length;
    }
    this.#typed = [];
    this.#typing = true;
    void this.#call("shell_input", {
      id: this.#request.id,
      data: Array.from(data),
    }).then(() => {
      this.#typing = false;
      this.#type();
    });
  }

  #resize(): void {
    const { cols, rows } = this.#size;
    if (
      this.#resizing ||
      this.#state.state !== "running" ||
      this.#closed ||
      (cols === this.#sent.cols && rows === this.#sent.rows)
    ) {
      return;
    }
    this.#sent = this.#size;
    this.#resizing = true;
    void this.#call("shell_resize", { id: this.#request.id, cols, rows }).then(
      () => {
        this.#resizing = false;
        this.#resize();
      },
    );
  }

  #acknowledge(): void {
    if (this.#acking || this.#parsed === 0 || this.#closed) return;
    const bytes = this.#parsed;
    this.#parsed = 0;
    this.#acking = true;
    void this.#call("shell_ack", { id: this.#request.id, bytes }).then(() => {
      this.#acking = false;
      this.#acknowledge();
    });
  }

  /** Never rejects: a call that fails after the session ended is the session's own end, not news. */
  async #call<C extends "shell_input" | "shell_resize" | "shell_ack">(
    command: C,
    request: RequestOf<C>,
  ): Promise<void> {
    try {
      await this.#backend.invoke(command, request);
    } catch (error) {
      if (!this.#closed && this.#state.state !== "ended") this.#report(error);
    }
  }

  #publish(state: ShellEvent): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
