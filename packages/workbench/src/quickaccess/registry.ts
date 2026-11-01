import type { ComponentType } from "react";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";
import type { Lookup } from "../contextkey/when";

export interface QuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: ComponentType<{ className?: string }>;
  /** A keybinding label, shown at the end. */
  readonly keybinding?: string;
  /** Items group under headings in the order they come. */
  readonly group?: string;
}

/** What a provider sees: the context keys of the element focused when quick access opened. */
export interface QuickAccessContext {
  readonly lookup: Lookup;
}

/**
 * A quick-access provider by prefix (ARCHITECTURE 4.5), as VS Code's
 * QuickAccessRegistry: the longest prefix the input starts with wins; the
 * empty prefix takes the rest. Providers filter their own items.
 */
export interface QuickAccessProvider {
  readonly prefix: string;
  readonly placeholder: string;
  /** What `?` says about the prefix. */
  readonly help: string;
  items(
    filter: string,
    context: QuickAccessContext,
  ): readonly QuickPickItem[] | Promise<readonly QuickPickItem[]>;
  accept(
    item: QuickPickItem,
    filter: string,
    context: QuickAccessContext,
  ): void | Promise<void>;
}

interface Pick {
  readonly placeholder: string;
  readonly items: readonly QuickPickItem[];
  readonly resolve: (item: QuickPickItem | undefined) => void;
}

export interface Session {
  readonly value: string;
  readonly context: QuickAccessContext;
  /** Set while a command waits for the user to pick one of its items. */
  readonly pick: Pick | undefined;
}

export class QuickAccess {
  readonly changes = new Changes();
  readonly #providers = new Map<string, QuickAccessProvider>();
  #session: Session | undefined;
  #restore: HTMLElement | undefined;

  constructor(private readonly keys: ContextKeys) {}

  register(provider: QuickAccessProvider): () => void {
    if (this.#providers.has(provider.prefix)) {
      throw new Error(
        `quick access already has the prefix "${provider.prefix}"`,
      );
    }
    this.#providers.set(provider.prefix, provider);
    this.changes.emit();
    return () => {
      this.#providers.delete(provider.prefix);
      this.changes.emit();
    };
  }

  providers(): QuickAccessProvider[] {
    return [...this.#providers.values()];
  }

  /** The provider for an input and the text after its prefix. */
  resolve(
    value: string,
  ): { provider: QuickAccessProvider; filter: string } | undefined {
    let best: QuickAccessProvider | undefined;
    for (const provider of this.#providers.values()) {
      if (!value.startsWith(provider.prefix)) continue;
      if (!best || provider.prefix.length > best.prefix.length) best = provider;
    }
    return best && { provider: best, filter: value.slice(best.prefix.length) };
  }

  get session(): Session | undefined {
    return this.#session;
  }

  show(value = ""): void {
    this.#settle(undefined);
    this.#open({ value, pick: undefined });
  }

  /** Lets the user pick one item; undefined if they dismiss quick access. */
  pick(
    placeholder: string,
    items: readonly QuickPickItem[],
  ): Promise<QuickPickItem | undefined> {
    this.#settle(undefined);
    return new Promise((resolve) => {
      this.#open({ value: "", pick: { placeholder, items, resolve } });
    });
  }

  setValue(value: string): void {
    if (!this.#session || this.#session.value === value) return;
    this.#session = { ...this.#session, value };
    this.changes.emit();
  }

  /** Closes quick access and gives the focus back. */
  hide(): void {
    this.#settle(undefined);
    this.#close();
  }

  /** Accepts an item of the open session. */
  async accept(item: QuickPickItem): Promise<void> {
    const session = this.#session;
    if (!session) return;
    if (session.pick) {
      this.#settle(item);
      this.#close();
      return;
    }
    const resolved = this.resolve(session.value);
    if (!resolved) return;
    this.#close();
    await resolved.provider.accept(item, resolved.filter, session.context);
  }

  #open({ value, pick }: { value: string; pick: Pick | undefined }) {
    const focused = document.activeElement;
    if (!this.#session) {
      this.#restore = focused instanceof HTMLElement ? focused : undefined;
    }
    const context = this.#session?.context ?? {
      lookup: this.keys.lookup(focused),
    };
    this.#session = { value, context, pick };
    this.changes.emit();
  }

  #close() {
    this.#session = undefined;
    this.changes.emit();
    const restore = this.#restore;
    this.#restore = undefined;
    if (restore?.isConnected) restore.focus();
  }

  #settle(item: QuickPickItem | undefined) {
    const session = this.#session;
    if (!session?.pick) return;
    this.#session = { ...session, pick: undefined };
    session.pick.resolve(item);
  }
}
