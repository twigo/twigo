import { useChanges, useWorkbench } from "../react";
import type { Alignment } from "../views/registry";

/** Items that features contribute, ordered by priority on each side (ARCHITECTURE 4.1). */
export function StatusBar() {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-2 bg-statusbar px-2 text-xs text-statusbar-foreground">
      <Side alignment="left" />
      <Side alignment="right" />
    </footer>
  );
}

function Side({ alignment }: { alignment: Alignment }) {
  const { views, keys } = useWorkbench();
  useChanges(views.changes);
  useChanges(keys.changes);
  return (
    <div className="flex min-w-0 items-center gap-3">
      {views.statusBarItems(alignment, keys.lookup(null)).map((item) => {
        const Component = item.component;
        return <Component key={item.id} />;
      })}
    </div>
  );
}
