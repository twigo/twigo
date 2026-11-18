import type { Overview } from "@twigo/protocol";

/** Whether the Overview lists containers and none of them runs: false while it lists none, as before it comes. */
export function noContainerRuns(overview: Overview | undefined): boolean {
  const containers = (overview?.sections ?? [])
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "containers" ? block.containers : []));
  return (
    containers.length > 0 &&
    containers.every((container) => container.state?.running !== true)
  );
}
