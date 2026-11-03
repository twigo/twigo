import * as v from "valibot";
import type { Workbench } from "@twigo/workbench";

/** A list the user pinned to a space's explorer, with its filters in its URI. */
export interface PinnedList {
  readonly uri: string;
  /** The kind, as the explorer names it: `Pods`. */
  readonly title: string;
  /** What narrows it, quieter: `Failing`, `payments`. */
  readonly detail: string;
}

const KEY = "kube.pinned";

const PINNED = v.array(
  v.object({ uri: v.string(), title: v.string(), detail: v.string() }),
);

/** Each space's pinned lists (ARCHITECTURE 4.4), kept with the space. */
export class PinnedLists {
  constructor(private readonly spaces: Workbench["spaces"]) {}

  get changes() {
    return this.spaces.changes;
  }

  list(space: string): readonly PinnedList[] {
    const parsed = v.safeParse(PINNED, this.spaces.view(space, KEY));
    return parsed.success ? parsed.output : [];
  }

  has(space: string, uri: string): boolean {
    return this.list(space).some((pinned) => pinned.uri === uri);
  }

  pin(space: string, list: PinnedList): void {
    if (this.has(space, list.uri)) return;
    this.spaces.setView(space, KEY, [...this.list(space), list]);
  }

  unpin(space: string, uri: string): void {
    this.spaces.setView(
      space,
      KEY,
      this.list(space).filter((pinned) => pinned.uri !== uri),
    );
  }
}
