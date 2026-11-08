import type { Workbench } from "@twigo/workbench";
import { Capabilities } from "./capabilities";
import { Discovery } from "./discovery";
import { ListStatuses } from "./list/listStatus";
import { ListStates } from "./listState";
import { PinnedLists } from "./explorer/pinned";
import { createEdits, type EditServices } from "./edit/services";
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
  workbench.editors.onClose((uri) => {
    states.closed(uri);
    capabilities.closed(uri);
  });
  return {
    discovery: new Discovery(workbench),
    presets: new ListPresets(workbench.state),
    states,
    selection: new Selection(),
    statuses: new ListStatuses(),
    pinned: new PinnedLists(workbench.spaces),
    overviews: new OverviewStates(),
    capabilities,
    edits: createEdits(workbench),
  };
}
