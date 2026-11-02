import type {
  Backend,
  ContextAuth,
  ExecPlugin,
  ExecReview,
  ReviewedPlugin,
} from "@twigo/protocol";
import { Changes } from "./changes";
import type { Spaces } from "./spaces/store";

/** How long a silent sign-in runs before the panel shows that it waits. */
const SHOW_AFTER_MS = 2000;

/**
 * How the active space's context gets its credentials (ARCHITECTURE 6.2), as
 * Rust reports it, and the review of untrusted plugins on the first start.
 */
export class Credentials {
  readonly changes = new Changes();
  #context: string | undefined;
  #auth: ContextAuth = { state: "none" };
  /** Counts the times a credential became ready, so views that failed ask again. */
  #ready = 0;
  #review: readonly ReviewedPlugin[] = [];
  /** The context whose untrusted plugin the trust prompt shows, once per activation. */
  #prompted: string | undefined;
  /** The plugin the open trust prompt shows; it closes if the kubeconfig changes it. */
  #prompt: ExecPlugin | undefined;
  #panelOpen = false;
  /** The runs whose panel the person closed, by plugin and start, so it opens again only for the next, in any space that shares the plugin. */
  readonly #dismissed = new Set<string>();
  #arming: ReturnType<typeof setTimeout> | undefined;
  /**
   * The last watch asked for, which the next waits on: Rust keeps one
   * follower per webview, that of the watch that answered last.
   */
  #watching: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: Backend,
    private readonly spaces: Spaces,
    private readonly onError: (error: unknown) => void,
  ) {}

  get context(): string | undefined {
    return this.#context;
  }

  get auth(): ContextAuth {
    return this.#auth;
  }

  get ready(): number {
    return this.#ready;
  }

  /** The plugins the first start's review lists; empty once answered. */
  get review(): readonly ReviewedPlugin[] {
    return this.#review;
  }

  /** The plugin the open trust prompt shows, if it is open. */
  get prompt(): ExecPlugin | undefined {
    return this.#prompt;
  }

  get panelOpen(): boolean {
    return this.#panelOpen;
  }

  setTrustOpen(open: boolean): void {
    this.#prompt =
      open && this.#auth.state === "untrusted" ? this.#auth.plugin : undefined;
    this.changes.emit();
  }

  setPanelOpen(open: boolean): void {
    this.#panelOpen = open;
    const run = this.#run();
    if (run && open) this.#dismissed.delete(run);
    else if (run) this.#dismissed.add(run);
    this.changes.emit();
  }

  /** Follows the active space, and asks for the review. */
  async start(): Promise<void> {
    // First, so that the review, not the prompt, asks about the active
    // space's plugin.
    const review: ExecReview = await this.backend.invoke("exec_review", null);
    if (!review.reviewed) this.#review = review.plugins;
    this.spaces.changes.subscribe(() => {
      this.#follow();
    });
    this.#follow();
  }

  /**
   * Trusts the plugins of `digests` and closes the review; a plugin left
   * out asks when its space opens next. The active space's plugin, if
   * trusted, signs in at once, as "Trust and connect" does.
   */
  async answerReview(digests: readonly string[]): Promise<void> {
    const context = this.#context;
    const active =
      this.#auth.state === "untrusted" ? this.#auth.plugin.digest : undefined;
    this.#review = [];
    this.#prompted = context;
    this.changes.emit();
    try {
      await this.backend.invoke("exec_trust", [...digests]);
      if (context !== undefined && active && digests.includes(active)) {
        await this.#signIn(context);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  /**
   * Trusts the plugin of `digest`, the one the prompt showed, and signs in
   * with it; nothing happens if the kubeconfig changed it since.
   */
  async trust(digest: string): Promise<void> {
    const context = this.#context;
    const auth = this.#auth;
    if (
      context === undefined ||
      auth.state !== "untrusted" ||
      auth.plugin.digest !== digest
    ) {
      return;
    }
    this.#prompt = undefined;
    this.changes.emit();
    try {
      await this.backend.invoke("exec_trust", [digest]);
      await this.#signIn(context);
    } catch (error) {
      this.onError(error);
    }
  }

  async signIn(): Promise<void> {
    const context = this.#context;
    if (context === undefined) return;
    try {
      await this.#signIn(context);
    } catch (error) {
      this.onError(error);
    }
  }

  async cancel(): Promise<void> {
    const context = this.#context;
    if (context === undefined) return;
    try {
      await this.backend.invoke("context_sign_in_cancel", context);
    } catch (error) {
      this.onError(error);
    }
  }

  /** Runs `context`'s plugin, its panel open while `context` is active. */
  async #signIn(context: string): Promise<void> {
    if (context === this.#context) {
      this.#panelOpen = true;
      this.changes.emit();
    }
    try {
      await this.backend.invoke("context_sign_in", context);
    } catch (error) {
      if (context === this.#context) this.setPanelOpen(false);
      throw error;
    }
  }

  /** The run under way, as a key of `#dismissed`. */
  #run(): string | undefined {
    const auth = this.#auth;
    if (auth.state !== "plugin" || auth.status.state !== "running") {
      return undefined;
    }
    return `${auth.plugin.digest}\n${auth.status.since}`;
  }

  #show(): void {
    const run = this.#run();
    if (!run || !this.#dismissed.has(run)) this.#panelOpen = true;
  }

  /** Shows the panel once the run has gone on for a moment; a switch of space clears it. */
  #arm(since: string): void {
    clearTimeout(this.#arming);
    const left = Date.parse(since) + SHOW_AFTER_MS - Date.now();
    this.#arming = setTimeout(
      () => {
        const { auth } = this;
        if (auth.state === "plugin" && auth.status.state === "running") {
          this.#show();
          this.changes.emit();
        }
      },
      Math.max(0, left),
    );
  }

  #follow(): void {
    const contexts = this.spaces.active?.contexts ?? [];
    const context = contexts.length === 1 ? contexts[0] : undefined;
    if (context === this.#context) return;
    this.#context = context;
    this.#auth = { state: "none" };
    this.#panelOpen = false;
    this.#prompt = undefined;
    clearTimeout(this.#arming);
    this.#prompted = undefined;
    this.changes.emit();
    if (context === undefined) return;
    this.#watching = this.#watching.then(() =>
      context === this.#context ? this.#watch(context) : undefined,
    );
  }

  #watch(context: string): Promise<void> {
    // A change sent before the answer is newer than the answer.
    const early = { changed: false };
    return this.backend
      .subscribe("context_auth_watch", context, (next) => {
        early.changed = true;
        this.#set(context, next);
      })
      .then(
        (answer) => {
          if (!early.changed) this.#set(context, answer);
        },
        (error: unknown) => {
          this.onError(error);
        },
      );
  }

  #set(context: string, next: ContextAuth): void {
    if (context !== this.#context) return;
    const was = this.#auth;
    this.#auth = next;
    const status = next.state === "plugin" ? next.status : undefined;
    const signsIn = next.state === "plugin" && next.plugin.signsIn;
    const previous = was.state === "plugin" ? was.status.state : undefined;
    if (status?.state === "running") {
      // A plugin that may ask shows the panel once it prints, or after a
      // moment without a credential: a browser flow often prints nothing.
      if (signsIn) {
        if (status.output.trim() !== "") this.#show();
        else if (previous !== "running") this.#arm(status.since);
      }
    } else {
      clearTimeout(this.#arming);
    }
    // A sign-in seen to fail in this activation shows why, however fast it
    // failed; one that failed before shows in the status bar.
    if (
      status?.state === "failed" &&
      signsIn &&
      previous !== undefined &&
      previous !== "failed"
    ) {
      this.#panelOpen = true;
    }
    if (status?.state === "ready") {
      this.#panelOpen = false;
      if (previous !== "ready") this.#ready++;
    }
    // A prompt whose plugin the kubeconfig changed closes rather than show
    // another command under the person's hand.
    if (
      this.#prompt &&
      (next.state !== "untrusted" || next.plugin.digest !== this.#prompt.digest)
    ) {
      this.#prompt = undefined;
    }
    if (next.state === "untrusted" && this.#prompted !== context) {
      this.#prompted = context;
      if (this.#review.length === 0) this.#prompt = next.plugin;
    }
    this.changes.emit();
  }
}
