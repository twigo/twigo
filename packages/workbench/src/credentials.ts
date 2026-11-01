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
  /** The person closed the panel of this run, so it opens again only for the next. */
  #dismissed = false;
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

  setTrustOpen(open: boolean): void {
    this.#trustOpen = open;
    this.changes.emit();
  }

  setPanelOpen(open: boolean): void {
    this.#panelOpen = open;
    this.#dismissed = !open;
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
    this.#trustOpen = false;
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
      this.#dismissed = false;
      this.changes.emit();
    }
    try {
      await this.backend.invoke("context_sign_in", context);
    } catch (error) {
      if (context === this.#context) this.setPanelOpen(false);
      throw error;
    }
  }

  #show(): void {
    if (!this.#dismissed) this.#panelOpen = true;
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
        this.#show();
        this.changes.emit();
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
    this.#dismissed = false;
    clearTimeout(this.#arming);
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
    const signsIn = next.state === "plugin" && next.plugin.signsIn;
    const previous = was.state === "plugin" ? was.status.state : undefined;
    if (status?.state === "running") {
      if (previous !== "running") this.#dismissed = false;
      // A plugin that may ask shows the panel once it prints, or after a
      // moment without a credential: a browser flow often prints nothing.
      if (signsIn) {
        if (status.output.trim() !== "") this.#show();
        else if (previous !== "running") this.#arm(context);
      }
    } else {
      clearTimeout(this.#arming);
    }
    // A sign-in that failed shows why, however fast it failed.
    if (status?.state === "failed" && signsIn && previous !== "failed") {
      this.#show();
    }
    if (status?.state === "ready") {
      this.#panelOpen = false;
      this.#dismissed = false;
      if (previous !== "ready") this.#ready++;
    }
    if (next.state === "untrusted" && this.#prompted !== context) {
      this.#prompted = context;
      this.#trustOpen = this.#review.length === 0;
    }
    this.changes.emit();
  }
}
