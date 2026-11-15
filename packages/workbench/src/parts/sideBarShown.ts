import type { Workbench } from "../services";
import type { SideBar } from "../views/registry";

/** Whether a side bar is on screen: its space shows it and it holds a container. */
export function sideBarShown(workbench: Workbench, location: SideBar): boolean {
  const space = workbench.spaces.active;
  return (
    space !== undefined &&
    workbench.spaces.state(space.id).parts[location].visible &&
    workbench.views.containers(location).length > 0
  );
}
