import type {
  Backend,
  ContextAuth,
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
  #trustOpen = false;
  #panelOpen = false;
  /** When the run under way started, for its elapsed time. */
  #since: number | undefined;
  #arming: ReturnType<typeof setTimeout> | undefined;

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

  get trustOpen(): boolean {
    return this.#trustOpen && this.#auth.state === "untrusted";
  }

  get panelOpen(): boolean {
    return this.#panelOpen;
  }

  get since(): number | undefined {
    return this.#since;
  }

  setTrustOpen(open: boolean): void {
    this.#trustOpen = open;
    this.changes.emit();
  }

  setPanelOpen(open: boolean): void {
    this.#panelOpen = open;
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
   * out asks when its space opens next.
   */
  async answerReview(digests: readonly string[]): Promise<void> {
    this.#review = [];
    this.#prompted = this.#context;
    this.changes.emit();
    await this.backend.invoke("exec_trust", [...digests]);
  }

  async trust(): Promise<void> {
    if (this.#auth.state !== "untrusted") return;
    const { digest } = this.#auth.plugin;
    this.#trustOpen = false;
    this.changes.emit();
    await this.backend.invoke("exec_trust", [digest]);
    await this.signIn();
  }

  async signIn(): Promise<void> {
    const context = this.#context;
    if (context === undefined) return;
    this.#panelOpen = true;
    this.changes.emit();
    await this.backend.invoke("context_sign_in", context);
  }

  async cancel(): Promise<void> {
    if (this.#context === undefined) return;
    await this.backend.invoke("context_sign_in_cancel", this.#context);
  }

  #arm(context: string): void {
    clearTimeout(this.#arming);
    this.#arming = setTimeout(() => {
      const { auth } = this;
      if (
        context === this.#context &&
        auth.state === "plugin" &&
        auth.status.state === "running"
      ) {
        this.setPanelOpen(true);
      }
    }, SHOW_AFTER_MS);
  }

  #follow(): void {
    const contexts = this.spaces.active?.contexts ?? [];
    const context = contexts.length === 1 ? contexts[0] : undefined;
    if (context === this.#context) return;
    this.#context = context;
    this.#auth = { state: "none" };
    this.#panelOpen = false;
    this.#prompted = undefined;
    this.changes.emit();
    if (context === undefined) return;
    // A change sent before the answer is newer than the answer.
    const early = { changed: false };
    this.backend
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
    const wasRunning = was.state === "plugin" && was.status.state === "running";
    if (status?.state === "running") {
      if (!wasRunning) this.#since = Date.now();
      // A plugin that may ask shows the panel once it prints, or after a
      // moment without a credential: a browser flow often prints nothing.
      if (next.state === "plugin" && next.plugin.signsIn) {
        if (status.output.trim() !== "") this.#panelOpen = true;
        else if (!wasRunning) this.#arm(context);
      }
    } else {
      this.#since = undefined;
      clearTimeout(this.#arming);
    }
    if (status?.state === "ready") {
      this.#panelOpen = false;
      if (!(was.state === "plugin" && was.status.state === "ready")) {
        this.#ready++;
      }
    }
    if (next.state === "untrusted" && this.#prompted !== context) {
      this.#prompted = context;
      this.#trustOpen = this.#review.length === 0;
    }
    this.changes.emit();
  }
}
