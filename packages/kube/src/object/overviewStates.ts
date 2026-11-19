import type { Section, Sort } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

type Fold = Section["fold"];

/**
 * What a person chose in the Overviews of one kind, by the kind's resource
 * (`apps/deployments`): the parts they folded or opened, and the sort and
 * column widths of each live list, so another object of the kind, or the
 * same one shown again, reads as they left it.
 */
export class OverviewStates {
  readonly changes = new Changes();
  readonly #toggled = new Map<string, ReadonlySet<string>>();
  readonly #chosen = new Map<string, Map<string, boolean>>();
  readonly #shut = new Map<
    string,
    { readonly object: string; readonly ids: ReadonlySet<string> }
  >();
  readonly #sorts = new Map<string, Sort>();
  readonly #widths = new Map<string, Readonly<Record<string, number>>>();

  /** Whether a part whose start, `open`, never varies between objects is open now: what the person changed of it is kept for the kind. */
  open(kind: string, part: string, open: boolean): boolean {
    return this.#toggled.get(kind)?.has(part) === true ? !open : open;
  }

  toggle(kind: string, part: string): void {
    const toggled = new Set(this.#toggled.get(kind));
    if (!toggled.delete(part)) toggled.add(part);
    this.#toggled.set(kind, toggled);
    this.changes.emit();
  }

  /**
   * Whether a section of `object` is open. It opens as its `fold` says until
   * the person folds or opens it, and that is kept for the kind as open or
   * folded, never as a change of the fold, which differs between objects of
   * a kind. A `finding` opens over what was kept, since it holds what is
   * wrong; the person can fold it, for the object they folded it in, until
   * another object's section is folded the same way.
   */
  section(kind: string, object: string, id: string, fold: Fold): boolean {
    if (fold !== "finding")
      return this.#chosen.get(kind)?.get(id) ?? fold === "open";
    const shut = this.#shut.get(kind);
    return !(shut?.object === object && shut.ids.has(id));
  }

  /**
   * Opens or folds one section by hand: a `finding` for `object` alone, any
   * other for the kind.
   */
  setSection(
    kind: string,
    object: string,
    { id, fold }: { readonly id: string; readonly fold: Fold },
    open: boolean,
  ): void {
    const changed =
      fold === "finding"
        ? this.#hold(kind, object, id, open)
        : this.#choose(kind, id, open);
    if (changed) this.changes.emit();
  }

  /**
   * Opens or folds each of the sections, and keeps the choice for the kind for
   * every one of them, those that are so already and a `finding` too: another
   * object of the kind may draw them as it did not, by its own `fold`.
   */
  setSections(
    kind: string,
    object: string,
    sections: readonly { readonly id: string; readonly fold: Fold }[],
    open: boolean,
  ): void {
    let changed = false;
    for (const { id, fold } of sections) {
      if (fold === "finding" && this.#hold(kind, object, id, open))
        changed = true;
      if (this.#choose(kind, id, open)) changed = true;
    }
    if (changed) this.changes.emit();
  }

  #hold(kind: string, object: string, id: string, open: boolean): boolean {
    if (this.section(kind, object, id, "finding") === open) return false;
    const shut = this.#shut.get(kind);
    const ids = new Set(shut?.object === object ? shut.ids : []);
    if (open) ids.delete(id);
    else ids.add(id);
    this.#shut.set(kind, { object, ids });
    return true;
  }

  #choose(kind: string, id: string, open: boolean): boolean {
    const chosen = this.#chosen.get(kind) ?? new Map<string, boolean>();
    const changed = chosen.get(id) !== open;
    chosen.set(id, open);
    this.#chosen.set(kind, chosen);
    return changed;
  }

  sort(kind: string, list: string): Sort | null {
    return this.#sorts.get(`${kind}\n${list}`) ?? null;
  }

  setSort(kind: string, list: string, sort: Sort): void {
    this.#sorts.set(`${kind}\n${list}`, sort);
    this.changes.emit();
  }

  widths(kind: string, list: string): Readonly<Record<string, number>> {
    return this.#widths.get(`${kind}\n${list}`) ?? {};
  }

  resize(kind: string, list: string, column: string, width: number): void {
    const key = `${kind}\n${list}`;
    this.#widths.set(key, {
      ...this.#widths.get(key),
      [column]: Math.round(width),
    });
    this.changes.emit();
  }
}
