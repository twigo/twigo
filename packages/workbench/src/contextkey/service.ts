import type { ContextValue, Lookup } from "./when";

export interface Scope {
  set(key: string, value: ContextValue | undefined): void;
  dispose(): void;
}

/**
 * Context keys (ARCHITECTURE 5.1): global values, plus values scoped to a DOM
 * element that hold only while the focus is inside it, as VS Code's scoped
 * context key services do. A table's scope sets `listFocus`, so the key is
 * true exactly while the table has the focus.
 */
export class ContextKeys {
  readonly #global = new Map<string, ContextValue>();
  readonly #scopes = new WeakMap<Element, Map<string, ContextValue>>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  set(key: string, value: ContextValue | undefined): void {
    this.#write(this.#global, key, value);
  }

  scope(element: Element): Scope {
    if (this.#scopes.has(element)) {
      throw new Error("the element already has a context key scope");
    }
    const values = new Map<string, ContextValue>();
    this.#scopes.set(element, values);
    return {
      set: (key, value) => {
        this.#write(values, key, value);
      },
      dispose: () => {
        this.#scopes.delete(element);
        this.#changed();
      },
    };
  }

  /** The keys as seen from `element`, usually `document.activeElement`. */
  lookup(element: Element | null): Lookup {
    const chain: Map<string, ContextValue>[] = [];
    for (let at = element; at; at = at.parentElement) {
      const values = this.#scopes.get(at);
      if (values) chain.push(values);
    }
    const typing = isTypingTarget(element);
    return (key) => {
      if (key === "inputFocus") return typing;
      for (const values of chain) {
        if (values.has(key)) return values.get(key);
      }
      return this.#global.get(key);
    };
  }

  /** Bumps on every change, for `useSyncExternalStore`. */
  get version(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #write(
    values: Map<string, ContextValue>,
    key: string,
    value: ContextValue | undefined,
  ) {
    if (values.get(key) === value) return;
    if (value === undefined) values.delete(key);
    else values.set(key, value);
    this.#changed();
  }

  #changed() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }
}

/** Where typing goes to text: bare keys never fire there (ARCHITECTURE 5.2). */
export function isTypingTarget(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable ||
    element.closest(
      '[role="textbox"], [role="searchbox"], [role="combobox"]',
    ) !== null
  );
}
