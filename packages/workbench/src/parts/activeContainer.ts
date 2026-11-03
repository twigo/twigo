import type { Workbench } from "../services";
import type { SideBar, ViewContainer } from "../views/registry";

/** The container a part shows: the user's pick while it exists there, else the first. */
export function activeContainer(
  workbench: Workbench,
  location: SideBar,
): ViewContainer | undefined {
  const containers = workbench.views.containers(location);
  const space = workbench.spaces.active;
  const picked =
    space && workbench.spaces.state(space.id).parts[location].container;
  return (
    containers.find((container) => container.id === picked) ?? containers[0]
  );
}
