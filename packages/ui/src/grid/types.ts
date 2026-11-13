import type { Tone } from "../lib/tone";

export interface GridColumn {
  readonly id: string;
  readonly title: string;
  /** The starting width in px, until the user drags or fits it. */
  readonly width: number;
  /** Takes the free width while the user has not sized it: a name column. */
  readonly grow?: boolean;
  readonly align?: "start" | "end";
  /** A first click on its header sorts it descending, and the second ascending. */
  readonly descendFirst?: boolean;
  /** A quiet mark beside the title, whose tooltip says this. */
  readonly note?: string;
}

export interface GridSort {
  readonly column: string;
  readonly descending: boolean;
}

/** An item of the grid's sequence: a row, or the header of a group of rows. */
export type GridItem<R, G> =
  | {
      readonly type: "row";
      readonly id: string;
      readonly data: R;
      /** An abnormal row gets an edge in its tone. */
      readonly tone?: Tone;
    }
  | {
      readonly type: "group";
      readonly id: string;
      readonly data: G;
      readonly open: boolean;
    };
