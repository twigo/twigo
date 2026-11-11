import type { Workbench } from "@twigo/workbench";

/**
 * Tells whether the editor at `uri` closes from now until `stop`, so that a
 * session whose answer comes after the person closed the tab is closed too
 * and does not open the tab again.
 */
export function watchClose(
  editors: Pick<Workbench["editors"], "onClose">,
  uri: string,
): { readonly closed: boolean; readonly stop: () => void } {
  let closed = false;
  const stop = editors.onClose((each) => {
    if (each === uri) closed = true;
  });
  return {
    get closed() {
      return closed;
    },
    stop,
  };
}
