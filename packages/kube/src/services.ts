import type { Workbench } from "@twigo/workbench";
import { Discovery } from "./discovery";
import { ListStatuses } from "./list/listStatus";
import { ListStates } from "./listState";
import { PinnedLists } from "./explorer/pinned";
import { OverviewStates } from "./object/overviewStates";
import { ListPresets } from "./presets";
import { Selection } from "./selection";

/** The state Kubernetes keeps beside the workbench's, one of each per window. */
export interface ListServices {
  readonly discovery: Discovery;
  /** Each kind's columns, widths and grouping. */
  readonly presets: ListPresets;
  /** Each list editor's sort, filters and collapsed groups. */
  readonly states: ListStates;
  /** Each list editor's selected row and marks. */
  readonly selection: Selection;
  /** Each list editor's rows and state, for the status bar and the explorer. */
  readonly statuses: ListStatuses;
  /** The lists each space pinned to its explorer. */
  readonly pinned: PinnedLists;
  /** What the person chose in each kind's Overviews. */
  readonly overviews: OverviewStates;
}

export function createServices(workbench: Workbench): ListServices {
  const states = new ListStates();
  workbench.editors.onClose((uri) => {
    states.closed(uri);
  });
  return {
    discovery: new Discovery(workbench),
    presets: new ListPresets(workbench.state),
    states,
    selection: new Selection(),
    statuses: new ListStatuses(),
    pinned: new PinnedLists(workbench.spaces),
    overviews: new OverviewStates(),
  };
}
