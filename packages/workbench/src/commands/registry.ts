import type { LucideIcon } from "lucide-react";
import { Changes } from "../changes";
import {
  evaluate,
  keysOf,
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
  /** Runs with the context the command was enabled in, as of the focus it ran from. */
  run(args: unknown, lookup: Lookup): void | Promise<void>;
}

interface Entry {
  readonly command: Command;
  readonly enablement: When | undefined;
}

/** One namespace for every command, as VS Code's CommandsRegistry. */
export class Commands {
  readonly #entries = new Map<string, Entry>();
  readonly changes = new Changes();
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

  /** The keys the commands' enablement reads that start with `prefix`. */
  referenced(prefix: string): readonly string[] {
    const keys = new Set<string>();
    for (const { enablement } of this.#entries.values()) {
      if (!enablement) continue;
      for (const key of keysOf(enablement)) {
        if (key.startsWith(prefix)) keys.add(key);
      }
    }
    return [...keys].sort();
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
      await entry.command.run(args, lookup);
    } catch (error) {
      this.onError(id, error);
    }
    return true;
  }

  #changed() {
    this.#all = undefined;
    this.changes.emit();
  }
}
