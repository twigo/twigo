import type { LucideIcon } from "lucide-react";
import {
  evaluate,
  parseWhen,
  type Lookup,
  type When,
} from "../contextkey/when";

/** A command as the palette, menus and keybindings see it (ARCHITECTURE 5.1). */
export interface CommandDescriptor {
  /** `k8s.resource.delete`, `workbench.action.quickOpen`. */
  readonly id: string;
  readonly title: string;
  /** The palette group: `View`, `Kubernetes`. */
  readonly category: string;
  readonly icon?: LucideIcon;
  /** A when-expression; the command does nothing where it fails. */
  readonly enablement?: string;
}

export interface Command extends CommandDescriptor {
  run(args: unknown): void | Promise<void>;
}

interface Entry {
  readonly command: Command;
  readonly enablement: When | undefined;
}

/** One namespace for every command, as VS Code's CommandsRegistry. */
export class Commands {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  #all: CommandDescriptor[] | undefined;

  constructor(
    private readonly onError: (command: string, error: unknown) => void,
  ) {}

  register(command: Command): () => void {
    if (this.#entries.has(command.id)) {
      throw new Error(`command ${command.id} is already registered`);
    }
    const entry = {
      command,
      enablement:
        command.enablement === undefined
          ? undefined
          : parseWhen(command.enablement),
    };
    this.#entries.set(command.id, entry);
    this.#changed();
    return () => {
      if (this.#entries.get(command.id) === entry) {
        this.#entries.delete(command.id);
        this.#changed();
      }
    };
  }

  get(id: string): CommandDescriptor | undefined {
    return this.#entries.get(id)?.command;
  }

  /** The same array until the next change, for `useSyncExternalStore`. */
  all(): readonly CommandDescriptor[] {
    this.#all ??= [...this.#entries.values()].map((entry) => entry.command);
    return this.#all;
  }

  /** Whether the command exists and its enablement holds. */
  enabled(id: string, lookup: Lookup): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    return entry.enablement === undefined || evaluate(entry.enablement, lookup);
  }

  /**
   * Runs the command if it is enabled and reports whether it ran. A failure
   * goes to `onError`, so every caller (keys, palette, menus) shows it alike.
   */
  async execute(id: string, lookup: Lookup, args?: unknown): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (!entry || !this.enabled(id, lookup)) return false;
    try {
      await entry.command.run(args);
    } catch (error) {
      this.onError(id, error);
    }
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed() {
    this.#all = undefined;
    for (const listener of this.#listeners) listener();
  }
}
