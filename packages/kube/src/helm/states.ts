import { Changes } from "@twigo/workbench";
import type { HelmPart } from "@twigo/protocol";
import { partKey, type Glyph, type Shown } from "./reveals";

/** The views of a release: the recommended four, and the ones the split variant adds. */
export type ReleaseTab =
  | "overview"
  | "values"
  | "manifest"
  | "history"
  | "hooks"
  | "notes"
  | "objects";

/** Which of a revision's two values documents is shown: the person's, or the chart's defaults. */
export type Plate = "user" | "defaults";

/** What a page's text view shows, for the commands that reveal and hide: its eyes, the line the cursor is on, how many values are hidden and which parts are shown. */
export interface TextState {
  readonly glyphs: readonly Glyph[];
  readonly line: number;
  readonly hidden: number;
  readonly revealed: readonly HelmPart[];
  /** The part that reveals the whole text, none for a manifest. */
  readonly whole: HelmPart | undefined;
}

/** What the commands Reveal and Hide do on a page. */
interface PageActions {
  reveal(): void;
  hide(): void;
  revealAll(): void;
  hideAll(): void;
}

/** How the values read: as rows of key paths, or as their YAML. */
export type Form = "tree" | "yaml";

/** What the page holds of one `epoch` of a release's view (`ReleaseSnapshot.epoch`). */
interface Held<T> {
  readonly epoch: number;
  readonly value: T;
}

const NONE: ReadonlyMap<string, Shown> = new Map();
const UNMARKED: ReadonlySet<number> = new Set();

/**
 * What each open release editor, and each list's inspector, holds apart from
 * the release itself, by URI: the view shown, the values plate, and, of one
 * epoch of the view only, the revisions marked in History and what the person
 * revealed. An epoch is one release's one revision in one open, so a value
 * lasts until it is hidden, the editor closes, or the view leaves its
 * release or revision (ARCHITECTURE 3.6), and is never written anywhere.
 */
export class ReleaseStates {
  readonly changes = new Changes();
  readonly #tabs = new Map<string, ReleaseTab>();
  readonly #plates = new Map<string, Plate>();
  readonly #marks = new Map<string, Held<ReadonlySet<number>>>();
  readonly #reveals = new Map<string, Held<ReadonlyMap<string, Shown>>>();
  readonly #forms = new Map<string, Form>();
  readonly #actions = new Map<string, PageActions>();

  form(uri: string): Form {
    return this.#forms.get(uri) ?? "tree";
  }

  setForm(uri: string, form: Form): void {
    if (this.form(uri) === form) return;
    this.#forms.set(uri, form);
    this.changes.emit();
  }

  /** A page says what Reveal and Hide do on it while it shows. */
  register(uri: string, actions: PageActions): () => void {
    this.#actions.set(uri, actions);
    return () => {
      if (this.#actions.get(uri) === actions) this.#actions.delete(uri);
    };
  }

  act(uri: string, verb: keyof PageActions): void {
    this.#actions.get(uri)?.[verb]();
  }

  tab(uri: string): ReleaseTab {
    return this.#tabs.get(uri) ?? "overview";
  }

  setTab(uri: string, tab: ReleaseTab): void {
    if (this.tab(uri) === tab) return;
    this.#tabs.set(uri, tab);
    this.changes.emit();
  }

  plate(uri: string): Plate {
    return this.#plates.get(uri) ?? "user";
  }

  setPlate(uri: string, plate: Plate): void {
    if (this.plate(uri) === plate) return;
    this.#plates.set(uri, plate);
    this.changes.emit();
  }

  marks(uri: string, epoch: number): ReadonlySet<number> {
    const held = this.#marks.get(uri);
    return held?.epoch === epoch ? held.value : UNMARKED;
  }

  mark(
    uri: string,
    epoch: number,
    revisions: readonly number[],
    marked: boolean,
  ): void {
    const next = new Set(this.marks(uri, epoch));
    for (const revision of revisions) {
      if (marked) next.add(revision);
      else next.delete(revision);
    }
    this.#marks.set(uri, { epoch, value: next });
    this.changes.emit();
  }

  /** What was revealed in `epoch`: nothing once the view is in another. */
  shown(uri: string, epoch: number): ReadonlyMap<string, Shown> {
    const held = this.#reveals.get(uri);
    return held?.epoch === epoch ? held.value : NONE;
  }

  reveal(uri: string, epoch: number, answer: Shown): void {
    const before = this.shown(uri, epoch);
    this.#reveals.set(uri, {
      epoch,
      value: new Map(before).set(partKey(answer.part), answer),
    });
    this.changes.emit();
  }

  hide(uri: string, epoch: number, keys: readonly string[]): void {
    const next = new Map(this.shown(uri, epoch));
    for (const key of keys) next.delete(key);
    this.#reveals.set(uri, { epoch, value: next });
    this.changes.emit();
  }

  /** The page leaves `epoch`: what it held there goes, and no read of another epoch gives it back. */
  leave(uri: string, epoch: number): void {
    if (this.#marks.get(uri)?.epoch === epoch) this.#marks.delete(uri);
    if (this.#reveals.get(uri)?.epoch === epoch) this.#reveals.delete(uri);
  }

  closed(uri: string): void {
    this.#tabs.delete(uri);
    this.#plates.delete(uri);
    this.#marks.delete(uri);
    this.#reveals.delete(uri);
    this.#forms.delete(uri);
  }
}
