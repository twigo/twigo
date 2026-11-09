import type { ComponentType } from "react";
import type { ContextColor } from "@twigo/protocol";
import type { TextRange, Tone } from "@twigo/ui";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";
import type { Lookup } from "../contextkey/when";

/**
 * A row of quick access as data (ARCHITECTURE 4.5): the widget draws every
 * provider's rows alike.
 */
export interface QuickPickItem {
  readonly id: string;
  readonly label: string;
  /** What in the label matched the filter, drawn bold in the brand colour. */
  readonly matches?: readonly TextRange[];
  /** Quiet words after the label, such as a namespace. */
  readonly description?: string;
  readonly icon?: ComponentType<{ className?: string }>;
  /** Two letters of the name on its colour in place of the icon, as the rail draws a space. */
  readonly tile?: {
    readonly name: string;
    readonly color: ContextColor | undefined;
  };
  /**
   * A state worth saying at the row's end, as its dot and its words in its
   * tone: a pod's only when it is abnormal, a space's connection always.
   */
  readonly state?: {
    readonly tone: Tone;
    readonly label: string;
    /** While the state is in flight. */
    readonly pulse?: boolean;
  };
  /** What sort of thing the row is, quieter at its end: `Pod`, `Deployment`. */
  readonly kind?: string;
  /** A keybinding label, shown at the end. */
  readonly keybinding?: string;
  /** Items group under headings in the order they come. */
  readonly group?: string;
}

export interface AcceptOptions {
  /** ⌘↵: open what the row names beside the active editor. */
  readonly side: boolean;
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
  /** Names the prefix in the footer of keys, as `Commands`; without it the prefix stays out of the footer. */
  readonly hint?: string;
  /** What Enter does to a row, in the footer: `Open` unless it says. */
  readonly acceptLabel?: string;
  /** Whether ⌘↵ opens a row to the side; `accept` then gets `side`. */
  readonly toSide?: boolean;
  items(
    filter: string,
    context: QuickAccessContext,
  ): readonly QuickPickItem[] | Promise<readonly QuickPickItem[]>;
  accept(
    item: QuickPickItem,
    filter: string,
    context: QuickAccessContext,
    options?: AcceptOptions,
  ): void | Promise<void>;
}

/** What the open widget does for the `quickInput.*` commands. */
export interface QuickAccessList {
  /** Moves the selection, wrapping around. */
  move(delta: number): void;
  accept(options: AcceptOptions): void;
}

/**
 * Rows asked for each value typed, as a provider's are, for a list too long
 * to hold or one that a backend filters.
 */
export type PickSource = (filter: string) => Picked | Promise<Picked>;

/** The rows of a pick, and what the person should know of them, over the rows or in place of them. */
export type Picked =
  | readonly QuickPickItem[]
  | { readonly items: readonly QuickPickItem[]; readonly notice: string };

interface Pick {
  readonly placeholder: string;
  /** The rows the widget filters; none when `source` gives them. */
  readonly items: readonly QuickPickItem[];
  readonly source: PickSource | undefined;
  readonly resolve: (item: QuickPickItem | undefined) => void;
}

/** What a command asks the user to type, as VS Code's input box. */
export interface InputOptions {
  readonly placeholder: string;
  /** What Enter does with the value, under the field: `Scale deployment web, now at 3`. */
  readonly prompt: string;
  /** What Enter says in the footer: `Scale`. */
  readonly acceptLabel: string;
  /** What it starts with, all selected. */
  readonly value: string;
  /** Why Enter cannot take a value, none when it can. */
  readonly validate: (value: string) => string | undefined;
}

interface Ask extends InputOptions {
  readonly resolve: (value: string | undefined) => void;
}

export interface Session {
  readonly value: string;
  readonly context: QuickAccessContext;
  /** Set while a command waits for the user to pick one of its items. */
  readonly pick: Pick | undefined;
  /** Set while a command waits for the user to type a value. */
  readonly ask: Ask | undefined;
}

export class QuickAccess {
  readonly changes = new Changes();
  readonly #providers = new Map<string, QuickAccessProvider>();
  #session: Session | undefined;
  #restore: HTMLElement | undefined;
  #list: QuickAccessList | undefined;

  constructor(
    private readonly keys: ContextKeys,
    private readonly returnFocus: (to: Element | undefined) => void,
  ) {}

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
    this.#open({ value, pick: undefined, ask: undefined });
  }

  /**
   * Lets the user pick one item; undefined if they dismiss quick access.
   * The items are a list, or a source asked for the rows of each value typed.
   */
  pick(
    placeholder: string,
    items: readonly QuickPickItem[] | PickSource,
  ): Promise<QuickPickItem | undefined> {
    this.#settle(undefined);
    return new Promise((resolve) => {
      const listed = typeof items === "function";
      this.#open({
        value: "",
        pick: {
          placeholder,
          items: listed ? [] : items,
          source: listed ? items : undefined,
          resolve,
        },
        ask: undefined,
      });
    });
  }

  /** Lets the user type a value; undefined if they dismiss quick access. */
  input(options: InputOptions): Promise<string | undefined> {
    this.#settle(undefined);
    return new Promise((resolve) => {
      this.#open({
        value: options.value,
        pick: undefined,
        ask: { ...options, resolve },
      });
    });
  }

  /** Takes the typed value, unless it is not one the command can take. */
  submit(): void {
    const session = this.#session;
    if (!session?.ask) return;
    if (session.ask.validate(session.value) !== undefined) return;
    this.#session = { ...session, ask: undefined };
    session.ask.resolve(session.value);
    this.#close();
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

  /** Accepts an item of the open session; only a provider that says `toSide` opens it to the side. */
  async accept(
    item: QuickPickItem,
    { side }: AcceptOptions = { side: false },
  ): Promise<void> {
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
    await resolved.provider.accept(item, resolved.filter, session.context, {
      side: side && resolved.provider.toSide === true,
    });
  }

  /** The open widget's rows, while it shows them. */
  get list(): QuickAccessList | undefined {
    return this.#list;
  }

  attach(list: QuickAccessList): () => void {
    this.#list = list;
    return () => {
      if (this.#list === list) this.#list = undefined;
    };
  }

  #open({
    value,
    pick,
    ask,
  }: {
    value: string;
    pick: Pick | undefined;
    ask: Ask | undefined;
  }) {
    const focused = document.activeElement;
    if (!this.#session) {
      this.#restore = focused instanceof HTMLElement ? focused : undefined;
    }
    const context = this.#session?.context ?? {
      lookup: this.keys.lookup(focused),
    };
    this.#session = { value, context, pick, ask };
    this.changes.emit();
  }

  #close() {
    this.#session = undefined;
    this.changes.emit();
    const restore = this.#restore;
    this.#restore = undefined;
    this.returnFocus(restore);
  }

  #settle(item: QuickPickItem | undefined) {
    const session = this.#session;
    if (session?.ask) {
      this.#session = { ...session, ask: undefined };
      session.ask.resolve(undefined);
      return;
    }
    if (!session?.pick) return;
    this.#session = { ...session, pick: undefined };
    session.pick.resolve(item);
  }
}
