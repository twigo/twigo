import {
  toIpcError,
  type ApplyPreviewed,
  type ApplyRequest,
  type Backend,
  type OpenedEdit,
} from "@twigo/protocol";
import { Changes } from "@twigo/workbench";
import { parseManifest } from "./object";

/** What an edit is previewed with, kept to ask again with other choices. */
export interface Subject {
  readonly space: string;
  /** None for a new manifest. */
  readonly opened: OpenedEdit | null;
  readonly text: string;
}

/** Where the text goes wrong, or what the engine refused. */
export interface Failure {
  readonly message: string;
  readonly at?: { readonly line: number; readonly column: number };
}

/** The dry-run of an editor's edit (ARCHITECTURE 6.5): under way, refused, or what the cluster said. */
export type Preview =
  | { readonly state: "running" }
  | ({ readonly state: "failed" } & Failure)
  | {
      readonly state: "answered";
      readonly answer: ApplyPreviewed;
      readonly subject: Subject;
      readonly forced: boolean;
      /** The conflicting fields the person gave up, as the engine names them. */
      readonly dropped: readonly string[];
    };

/**
 * Each editor's last preview, by its URI, and whether the editor shows its
 * diff in place of its text. The engine keeps what a preview prepared under
 * its id for the window, and a newer preview of the object replaces it, so a
 * preview here is the newest one asked.
 */
export class Previews {
  readonly changes = new Changes();
  readonly #previews = new Map<string, Preview>();
  readonly #inPlace = new Set<string>();
  readonly #asked = new Map<string, number>();

  constructor(private readonly backend: Backend) {}

  get(editor: string): Preview | undefined {
    return this.#previews.get(editor);
  }

  /** Whether the editor's own tab shows the diff. */
  inPlace(editor: string): boolean {
    return this.#inPlace.has(editor);
  }

  setInPlace(editor: string, inPlace: boolean): void {
    if (this.#inPlace.has(editor) === inPlace) return;
    if (inPlace) this.#inPlace.add(editor);
    else this.#inPlace.delete(editor);
    this.changes.emit();
  }

  /**
   * Parses the text and asks the engine to dry-run it; the text that does
   * not parse stays in the editor, with where it goes wrong.
   */
  async run(
    editor: string,
    subject: Subject,
    choices: { force?: boolean; drop?: readonly string[] } = {},
  ): Promise<Preview> {
    const asked = (this.#asked.get(editor) ?? 0) + 1;
    this.#asked.set(editor, asked);
    const parsed = parseManifest(subject.text);
    if (!parsed.ok) {
      return this.#set(editor, {
        state: "failed",
        message: parsed.message,
        at: { line: parsed.line, column: parsed.column },
      });
    }
    this.#set(editor, { state: "running" });
    const request: ApplyRequest = {
      space: subject.space,
      opened: subject.opened,
      edited: parsed.object,
      force: choices.force ?? false,
      drop: [...(choices.drop ?? [])],
    };
    let next: Preview;
    try {
      const answer = await this.backend.invoke("apply_preview", request);
      next = {
        state: "answered",
        answer,
        subject,
        forced: request.force,
        dropped: request.drop,
      };
    } catch (error) {
      next = { state: "failed", message: toIpcError(error).message };
    }
    // A newer preview, or a clear, has the last word.
    if (this.#asked.get(editor) !== asked) return next;
    return this.#set(editor, next);
  }

  /** Asks again for the same text, with other choices about the conflicts. */
  async again(
    editor: string,
    choices: { force?: boolean; drop?: readonly string[] },
  ): Promise<Preview | undefined> {
    const last = this.#previews.get(editor);
    if (last?.state !== "answered") return undefined;
    return this.run(editor, last.subject, {
      force: choices.force ?? last.forced,
      drop: choices.drop ?? last.dropped,
    });
  }

  /**
   * The editor's text changed. What was a bar's matter, a refusal or an
   * answer about the old text, goes; a ready diff stays to be read, and says
   * its text is old.
   */
  edited(editor: string): void {
    const last = this.#previews.get(editor);
    if (last && !(last.state === "answered" && last.answer.state === "ready"))
      this.clear(editor);
  }

  /** Forgets the preview, and whatever answer is still on its way. */
  clear(editor: string): void {
    this.#asked.set(editor, (this.#asked.get(editor) ?? 0) + 1);
    const had = this.#previews.delete(editor);
    const shown = this.#inPlace.delete(editor);
    if (had || shown) this.changes.emit();
  }

  #set(editor: string, preview: Preview): Preview {
    this.#previews.set(editor, preview);
    this.changes.emit();
    return preview;
  }
}
