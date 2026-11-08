import * as v from "valibot";
import { Changes, type StateStore } from "@twigo/workbench";
import {
  comparable,
  parseManifest,
  resourceVersionOf,
  yamlOfJson,
} from "./object";
import { parseObjectUri, parseUntitledUri, untitledUri } from "../uri";

/**
 * An edit that nothing has applied yet (ARCHITECTURE 4.3, "Working copies"):
 * the object as it was opened and the text the person made of it.
 */
export interface WorkingCopy {
  /** The space whose cluster the edit is of, or for a new manifest where it goes. */
  readonly space: string;
  readonly base: string | undefined;
  readonly lock: string | undefined;
  /**
   * The object as it stood at `lock`, when "Keep mine" locked to a newer
   * version than `base`. The edit stays measured against `base`, since
   * measuring against the newer object would revert the other writer's
   * change; this says what changed on the server since.
   */
  readonly locked: string | undefined;
  /** For a new manifest, the space its apply goes to; none until the person says. */
  readonly target: string | undefined;
  readonly text: string;
}

export interface Opened {
  readonly space: string;
  readonly base: string;
  readonly lock: string;
}

const COPIES = v.record(
  v.string(),
  v.object({
    base: v.optional(v.string()),
    lock: v.optional(v.string()),
    locked: v.optional(v.string()),
    target: v.optional(v.string()),
    text: v.string(),
  }),
);

const KEY = "edits";

const PERSIST_AFTER_MS = 300;

/**
 * Whether a copy is or may become a Secret's, whose text must never reach the
 * state file. A manifest that does not parse or names no kind yet may turn
 * into a Secret once its kind is typed, after the values.
 */
export function mayHoldSecret(uri: string, text: string): boolean {
  const object = parseObjectUri(uri);
  if (object)
    return object.gvr.group === "" && object.gvr.resource === "secrets";
  const parsed = parseManifest(text);
  return (
    !parsed.ok ||
    typeof parsed.object.kind !== "string" ||
    /\bSecret\b/.test(text)
  );
}

/**
 * The working copy of each editor, by its URI. An editor that holds one
 * shows its text rather than the live object. The first change makes it, and
 * it goes when the text is the object again, or the person applies it,
 * discards it or takes the server's. Copies live in memory and, a Secret's
 * apart, in their space's state, so they survive a restart; closing the
 * editor keeps them.
 */
export class WorkingCopies {
  readonly changes = new Changes();
  readonly #copies = new Map<string, WorkingCopy>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #manifests = 0;
  readonly #seen = new Map<
    string,
    { readonly live: string; readonly statusSubresource: boolean }
  >();

  constructor(
    private readonly state: StateStore,
    private readonly editors: {
      setDirty(uri: string, dirty: boolean): void;
    },
    spaces: readonly string[],
  ) {
    for (const space of spaces) {
      const stored = this.state.get(space, KEY, COPIES, {});
      for (const [uri, { base, lock, locked, target, text }] of Object.entries(
        stored,
      )) {
        this.#copies.set(uri, { space, base, lock, locked, target, text });
        this.editors.setDirty(uri, true);
        this.#manifests = Math.max(this.#manifests, parseUntitledUri(uri) ?? 0);
      }
    }
  }

  get(uri: string): WorkingCopy | undefined {
    return this.#copies.get(uri);
  }

  edit(uri: string, text: string, opened: Opened): void {
    const copy = this.#copies.get(uri);
    const base = copy?.base ?? opened.base;
    if (text === yamlOfJson(base)) {
      this.drop(uri);
      return;
    }
    this.#set(uri, {
      space: opened.space,
      base,
      lock: copy?.lock ?? opened.lock,
      locked: copy?.locked,
      target: undefined,
      text,
    });
  }

  write(uri: string, space: string, text: string): void {
    if (text === "") {
      this.drop(uri);
      return;
    }
    this.#set(uri, {
      space,
      base: undefined,
      lock: undefined,
      locked: undefined,
      target: this.#copies.get(uri)?.target,
      text,
    });
  }

  retarget(uri: string, target: string): void {
    const copy = this.#copies.get(uri);
    if (copy) this.#set(uri, { ...copy, target });
  }

  nextManifest(): string {
    this.#manifests += 1;
    return untitledUri(this.#manifests);
  }

  see(uri: string, live: string, statusSubresource: boolean): void {
    const before = this.serverChanged(uri);
    this.#seen.set(uri, { live, statusSubresource });
    if (this.serverChanged(uri) !== before) this.changes.emit();
  }

  live(uri: string): string | undefined {
    return this.#seen.get(uri)?.live;
  }

  /**
   * Whether the object changed on the server since the copy was based on it,
   * or since "Keep mine" locked to it. A write to `status` alone is no
   * change where the resource has the `status` subresource.
   */
  serverChanged(uri: string): boolean {
    const copy = this.#copies.get(uri);
    const seen = this.#seen.get(uri);
    const since = copy?.locked ?? copy?.base;
    return (
      since !== undefined &&
      seen !== undefined &&
      comparable(seen.live, seen.statusSubresource) !==
        comparable(since, seen.statusSubresource)
    );
  }

  keepMine(uri: string): void {
    const copy = this.#copies.get(uri);
    const live = this.#seen.get(uri)?.live;
    const lock = live === undefined ? undefined : resourceVersionOf(live);
    if (copy?.base === undefined || live === undefined || lock === undefined)
      return;
    this.#set(uri, { ...copy, lock, locked: live });
  }

  drop(uri: string): void {
    const copy = this.#copies.get(uri);
    if (!copy) return;
    this.#copies.delete(uri);
    this.editors.setDirty(uri, false);
    this.#persist(copy.space);
    this.changes.emit();
  }

  flush(): void {
    for (const [space, timer] of this.#timers) {
      clearTimeout(timer);
      this.#timers.delete(space);
      this.#store(space);
    }
  }

  #set(uri: string, copy: WorkingCopy): void {
    this.#copies.set(uri, copy);
    this.editors.setDirty(uri, true);
    this.#persist(copy.space);
    this.changes.emit();
  }

  /** A pause after the last change of a space's copies, as typing makes one per key. */
  #persist(space: string): void {
    clearTimeout(this.#timers.get(space));
    this.#timers.set(
      space,
      setTimeout(() => {
        this.#timers.delete(space);
        this.#store(space);
      }, PERSIST_AFTER_MS),
    );
  }

  #store(space: string): void {
    const stored = Object.fromEntries(
      [...this.#copies]
        .filter(
          ([uri, copy]) =>
            copy.space === space && !mayHoldSecret(uri, copy.text),
        )
        .map(([uri, { base, lock, locked, target, text }]) => [
          uri,
          {
            ...(base !== undefined && { base }),
            ...(lock !== undefined && { lock }),
            ...(locked !== undefined && { locked }),
            ...(target !== undefined && { target }),
            text,
          },
        ]),
    );
    this.state.set(space, KEY, stored);
  }
}
