import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Workbench } from "@twigo/workbench";

async function apply(factor: number): Promise<void> {
  if (isTauri()) await getCurrentWebview().setZoom(factor);
  else document.documentElement.style.zoom = String(factor);
}

/**
 * Applies the workbench's interface zoom: the webview's own in the app, the
 * page's CSS `zoom` in the browser mock. Resolves once the starting factor is
 * applied, so the first render needs no jump. Each later change follows it,
 * one at a time: two async commands in flight could land in either order.
 */
export function installZoom(workbench: Workbench): Promise<void> {
  const { zoom } = workbench;
  let last = Promise.resolve();
  const follow = () => {
    const { factor } = zoom;
    last = last
      .then(() => apply(factor))
      .catch((error: unknown) => {
        workbench.report(error);
      });
    return last;
  };
  zoom.changes.subscribe(() => {
    void follow();
  });
  return follow();
}
