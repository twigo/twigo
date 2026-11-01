import type { KeyboardLayout } from "@twigo/protocol";
import { Changes } from "../changes";
import type { Commands } from "../commands/registry";
import type { ContextKeys } from "../contextkey/service";
import type { Platform } from "./chord";
import { KeyboardMapper, type Press } from "./mapper";
import {
  Resolver,
  type Binding,
  type KeybindingRemoval,
  type KeybindingRule,
  type Source,
  type Weight,
  validate,
} from "./resolver";

/**
 * Dispatches key presses to commands (ARCHITECTURE 5.2). Rules come in by
 * source; the resolver is rebuilt when a source or the layout changes.
 */
export class Keybindings {
  readonly #sources = new Set<Source>();
  readonly changes = new Changes();
  #mapper: KeyboardMapper;
  #resolver: Resolver | undefined;
  #pending: readonly Press[] = [];

  constructor(
    private readonly commands: Commands,
    private readonly keys: ContextKeys,
    layout: KeyboardLayout,
    platform: Platform,
  ) {
    this.#mapper = new KeyboardMapper(layout, platform);
  }

  register(
    weight: Weight,
    rules: readonly (KeybindingRule | KeybindingRemoval)[],
  ): () => void {
    for (const rule of rules) validate(rule, this.#mapper.platform);
    const source = { weight, rules };
    this.#sources.add(source);
    this.#changed();
    return () => {
      this.#sources.delete(source);
      this.#changed();
    };
  }

  setLayout(layout: KeyboardLayout): void {
    this.#mapper = new KeyboardMapper(layout, this.#mapper.platform);
    this.#changed();
  }

  /** The chords pressed so far while a chord waits for its next key. */
  get pending(): readonly Press[] {
    return this.#pending;
  }

  /** Handles a keydown; true when the event was a binding's and is consumed. */
  dispatch(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing) return false;
    const press = this.#mapper.fromEvent(event);
    if (!press) return false;
    const target = event.target instanceof Element ? event.target : null;
    const lookup = this.keys.lookup(target);
    const resolution = this.#resolve().resolve(
      this.#pending,
      press,
      lookup,
      (binding) => this.commands.enabled(binding.command, lookup),
    );
    const waited = this.#pending.length > 0;
    if (resolution.kind === "none") {
      if (!waited) return false;
      this.#setPending([]);
      event.preventDefault();
      return true;
    }
    event.preventDefault();
    if (resolution.kind === "chord") {
      this.#setPending([...this.#pending, press]);
      return true;
    }
    this.#setPending([]);
    const { command, args } = resolution.binding;
    void this.commands.execute(command, lookup, args);
    return true;
  }

  /** The binding that wins for a command, if any. */
  primary(command: string): Binding | undefined {
    return this.#resolve().bindingsOf(command)[0];
  }

  label(presses: readonly Press[]): string {
    return presses.map((press) => this.#mapper.label(press)).join(" ");
  }

  #resolve(): Resolver {
    this.#resolver ??= new Resolver([...this.#sources], this.#mapper);
    return this.#resolver;
  }

  #setPending(pending: readonly Press[]) {
    this.#pending = pending;
    this.changes.emit();
  }

  #changed() {
    this.#resolver = undefined;
    this.changes.emit();
  }
}
