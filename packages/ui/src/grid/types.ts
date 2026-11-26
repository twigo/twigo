import type { Tone } from "../lib/tone";

export interface GridColumn {
  readonly id: string;
  readonly title: string;
  /** The starting width in px, until the user drags or fits it. */
  readonly width: number;
  /** Takes the free width while the user has not sized it: a name column. */
  readonly grow?: boolean;
  readonly align?: "start" | "end";
  /** Its cells are figures, which line up in tabular numerals. */
  readonly numeric?: boolean;
  /** A first click on its header sorts it descending, and the second ascending. */
  readonly descendFirst?: boolean;
  /** A quiet mark beside the title, whose tooltip says this. */
  readonly note?: string;
  /** A hovered row's icons may lie over its cells, as over an age or a measure, when it is among the last columns. */
  readonly coverable?: boolean;
}

/** When each cell of a row last changed, by column id. */
export type RowFlash = ReadonlyMap<string, number>;

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
      /** An abnormal row is drawn as a band in its tone. */
      readonly tone?: Tone;
    }
  | {
      readonly type: "group";
      readonly id: string;
      readonly data: G;
      readonly open: boolean;
    };
