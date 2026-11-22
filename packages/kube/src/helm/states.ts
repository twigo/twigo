import { Changes } from "@twigo/workbench";
import { partKey, type Shown } from "./reveals";

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

interface Reveals {
  readonly revision: number | undefined;
  readonly shown: ReadonlyMap<string, Shown>;
}

const NONE: ReadonlyMap<string, Shown> = new Map();

/**
 * What each open release editor, and each list's inspector, holds apart from
 * the release itself, by URI: the view shown, the values plate, the revisions
 * marked in History, and what the person revealed, which lasts until it is
 * hidden, the editor closes, or the view leaves the revision it came from
 * (ARCHITECTURE 3.6) and is never written anywhere.
 */
export class ReleaseStates {
  readonly changes = new Changes();
  readonly #tabs = new Map<string, ReleaseTab>();
  readonly #plates = new Map<string, Plate>();
  readonly #marks = new Map<string, ReadonlySet<number>>();
  readonly #reveals = new Map<string, Reveals>();

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

  marks(uri: string): ReadonlySet<number> {
    return this.#marks.get(uri) ?? new Set();
  }

  mark(uri: string, revisions: readonly number[], marked: boolean): void {
    const next = new Set(this.marks(uri));
    for (const revision of revisions) {
      if (marked) next.add(revision);
      else next.delete(revision);
    }
    this.#marks.set(uri, next);
    this.changes.emit();
  }

  /** What was revealed of `revision`: nothing once the view is of another. */
  shown(uri: string, revision: number | undefined): ReadonlyMap<string, Shown> {
    const held = this.#reveals.get(uri);
    return held && held.revision === revision ? held.shown : NONE;
  }

  reveal(uri: string, revision: number | undefined, answer: Shown): void {
    const before = this.shown(uri, revision);
    this.#reveals.set(uri, {
      revision,
      shown: new Map(before).set(partKey(answer.part), answer),
    });
    this.changes.emit();
  }

  hide(
    uri: string,
    revision: number | undefined,
    keys: readonly string[],
  ): void {
    const next = new Map(this.shown(uri, revision));
    for (const key of keys) next.delete(key);
    this.#reveals.set(uri, { revision, shown: next });
    this.changes.emit();
  }

  closed(uri: string): void {
    this.#tabs.delete(uri);
    this.#plates.delete(uri);
    this.#marks.delete(uri);
    this.#reveals.delete(uri);
  }
}
