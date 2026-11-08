import * as v from "valibot";
import type { editor } from "monaco-editor/editor";
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

/**
 * What Monaco keeps of an editor while the editor is not shown: its model,
 * whose undo stack lives there, and the cursor and scroll of its view.
 */
export interface EditorBuffer {
  readonly model: editor.ITextModel;
  view: editor.ICodeEditorViewState | null;
  /** Puts the keyboard focus in the view, while the editor has one. */
  focus?: () => void;
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

function differs(
  live: string,
  since: string,
  statusSubresource: boolean,
): boolean {
  return (
    comparable(live, statusSubresource) !== comparable(since, statusSubresource)
  );
}

function isSecretUri(uri: string): boolean {
  const object = parseObjectUri(uri);
  return object?.gvr.group === "" && object.gvr.resource === "secrets";
}

/**
 * Whether a copy is or may become a Secret's, whose text must never reach the
 * state file: an object of the `secrets` resource, text of any editor that
 * mentions a Secret, since one can be pasted into another object's editor,
 * and a new manifest that does not parse or names no kind yet, which may turn
 * into a Secret once its kind is typed, after the values.
 */
export function mayHoldSecret(uri: string, text: string): boolean {
  if (isSecretUri(uri) || /\bSecret\b/.test(text)) return true;
  if (parseObjectUri(uri)) return false;
  const parsed = parseManifest(text);
  return !parsed.ok || typeof parsed.object.kind !== "string";
}

/**
 * The working copy of each editor, by its URI. An editor that holds one
 * shows its text rather than the live object. The first change makes it, and
 * it goes when the text is the object again, or the person applies it,
 * discards it or takes the server's. Copies live in memory and, a Secret's
 * apart, in their space's state, so they survive a restart; closing the
 * editor keeps them.
 *
 * It also keeps each shown editor's Monaco buffer, so that cursor, scroll and
 * undo outlive the view that shows them, as on a switch between an object's
 * Overview and YAML. A buffer goes when its editor closes, and a copy that
 * ends while the editor is open sets its text to the object's, which clears
 * the undo stack.
 */
export class WorkingCopies {
  readonly changes = new Changes();
  readonly #copies = new Map<string, WorkingCopy>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #buffers = new Map<string, EditorBuffer>();
  readonly #held = new Map<
    string,
    {
      readonly text: string;
      readonly since: string;
      /** The object the preview said the apply would leave, as JSON. */
      readonly result: string | undefined;
    }
  >();
  readonly #focusing = new Set<string>();
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

  /** The editor's buffer, `make`d the first time it is shown. */
  buffer(uri: string, make: () => EditorBuffer): EditorBuffer {
    let buffer = this.#buffers.get(uri);
    if (!buffer) {
      buffer = make();
      this.#buffers.set(uri, buffer);
    }
    return buffer;
  }

  /**
   * Gives the editor the keyboard focus, as a bar or a diff that had it goes:
   * now if the editor has a view, else when it has.
   */
  focus(uri: string): void {
    const focus = this.#buffers.get(uri)?.focus;
    if (focus) focus();
    else this.#focusing.add(uri);
  }

  /** Whether the editor was asked for focus while it had no view, which its new view takes. */
  takeFocus(uri: string): boolean {
    return this.#focusing.delete(uri);
  }

  /** The editor closed: its buffer goes, and its copy, if it has one, stays as text. */
  closed(uri: string): void {
    this.#buffers.get(uri)?.model.dispose();
    this.#buffers.delete(uri);
    this.#held.delete(uri);
    this.#focusing.delete(uri);
  }

  edit(uri: string, text: string, opened: Opened): void {
    this.#held.delete(uri);
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
    this.#held.delete(uri);
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
    const held = this.#held.get(uri);
    const shown =
      held !== undefined &&
      (differs(live, held.since, statusSubresource) ||
        (held.result !== undefined &&
          !differs(live, held.result, statusSubresource)));
    if (shown) this.#held.delete(uri);
    if (shown || this.serverChanged(uri) !== before) this.changes.emit();
  }

  /**
   * The text of an edit whose plan is done, shown in place of the live
   * object until the object comes by its watch with what the edit changed,
   * so that the editor never shows the object as it was.
   */
  held(uri: string): string | undefined {
    return this.#held.get(uri)?.text;
  }

  /**
   * The edit's plan is done and the copy ends. The object has not shown the
   * change yet if it still equals what the copy was based on, or locked to,
   * and its text is held until `see` finds it different: a status write moves
   * the `resourceVersion` without that, so the lock alone would let the old
   * object show. The hold ends too when the object equals `result`, what the
   * preview said the apply leaves, since an apply that changes nothing in the
   * object would otherwise hold for good. A Secret's never holds, as its
   * masked view does not differ for a value of the same size, and the text
   * typed would stay.
   */
  applied(uri: string, result?: unknown): void {
    const copy = this.#copies.get(uri);
    const seen = this.#seen.get(uri);
    const since = copy?.locked ?? copy?.base;
    const left = result === undefined ? undefined : JSON.stringify(result);
    if (
      copy &&
      since !== undefined &&
      !isSecretUri(uri) &&
      !(seen && differs(seen.live, since, seen.statusSubresource)) &&
      !(
        seen &&
        left !== undefined &&
        !differs(seen.live, left, seen.statusSubresource)
      )
    ) {
      this.#held.set(uri, { text: copy.text, since, result: left });
    }
    this.drop(uri);
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
      differs(seen.live, since, seen.statusSubresource)
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
