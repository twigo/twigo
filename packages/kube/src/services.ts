import type { Workbench } from "@twigo/workbench";
import { Capabilities } from "./capabilities";
import { Discovery } from "./discovery";
import { ListGrids } from "./list/grids";
import { ListStatuses } from "./list/listStatus";
import { KnownMeasures } from "./list/measures";
import { ListStates } from "./listState";
import { PinnedLists } from "./explorer/pinned";
import { createEdits, type EditServices } from "./edit/services";
import { OverviewStates } from "./object/overviewStates";
import { UsageSaid } from "./object/usageSaid";
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
  /** Each list editor's grid, for the keyboard focus. */
  readonly grids: ListGrids;
  /** Which columns of each kind are measures, as the session's lists learnt it. */
  readonly measures: KnownMeasures;
  /** The lists each space pinned to its explorer. */
  readonly pinned: PinnedLists;
  /** What the person chose in each kind's Overviews. */
  readonly overviews: OverviewStates;
  /** What each space's Metrics API last said of an object's usage. */
  readonly usageSaid: UsageSaid;
  /** What RBAC lets the person do, for the `capability.*` keys. */
  readonly capabilities: Capabilities;
  /** Each YAML editor's working copy, preview and schema. */
  readonly edits: EditServices;
}

export function createServices(workbench: Workbench): ListServices {
  const states = new ListStates();
  const capabilities = new Capabilities(workbench.backend, (error) => {
    workbench.report(error);
  });
  const grids = new ListGrids();
  workbench.editors.onClose((uri) => {
    states.closed(uri);
    capabilities.closed(uri);
    grids.closed(uri);
  });
  return {
    discovery: new Discovery(workbench),
    presets: new ListPresets(workbench.state),
    states,
    selection: new Selection(),
    statuses: new ListStatuses(),
    grids,
    measures: new KnownMeasures(),
    pinned: new PinnedLists(workbench.spaces),
    overviews: new OverviewStates(),
    usageSaid: new UsageSaid(),
    capabilities,
    edits: createEdits(workbench),
  };
}
