import type { Sort } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

/**
 * What a person chose in the Overviews of one kind, by the kind's resource
 * (`apps/deployments`): the parts they folded or opened, and the sort and
 * column widths of each live list, so another object of the kind, or the
 * same one shown again, reads as they left it.
 */
export class OverviewStates {
  readonly changes = new Changes();
  readonly #toggled = new Map<string, ReadonlySet<string>>();
  readonly #sorts = new Map<string, Sort>();
  readonly #widths = new Map<string, Readonly<Record<string, number>>>();

  /** Whether a part that starts as `open` is open now. */
  open(kind: string, part: string, open: boolean): boolean {
    return this.#toggled.get(kind)?.has(part) === true ? !open : open;
  }

  toggle(kind: string, part: string): void {
    const toggled = new Set(this.#toggled.get(kind));
    if (!toggled.delete(part)) toggled.add(part);
    this.#toggled.set(kind, toggled);
    this.changes.emit();
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
