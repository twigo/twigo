/**
 * What the keyboard does to a focused list, grid or tree. The workbench's
 * list service routes its `list.*` commands to the one that has the focus;
 * a widget leaves out what it cannot do.
 */
export interface ListController {
  /** Moves the cursor; `extend` marks the rows it passes, where marks exist. */
  move(delta: number, extend?: boolean): void;
  moveToEdge(edge: "first" | "last"): void;
  /** Opens what the cursor is on, as a click does. */
  activate(): void;
  toggleMark?(): void;
  collapse?(): void;
  expand?(): void;
}
