import { Sun, Moon, Search } from "lucide-react";
import { useUi } from "@/store/ui";
import { usePalette } from "@/store/palette";
import { fmtBinding } from "@/lib/commands";
import { getStatusSegments, statusSegmentClass } from "@/shell/statusBar";

export function StatusBar() {
  const { resolvedTheme, toggleTheme } = useUi();
  const left = getStatusSegments("left");
  const right = getStatusSegments("right");

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between bg-statusbar px-1 text-xs text-statusbar-foreground">
      <div className="flex items-center gap-0.5">
        {left.map(({ id, render: Segment }) => (
          <Segment key={id} />
        ))}
      </div>
      <div className="flex items-center gap-1 pr-1">
        {right.map(({ id, render: Segment }) => (
          <Segment key={id} />
        ))}
        <button
          type="button"
          onClick={() => usePalette.getState().setOpen(true)}
          title="Command palette"
          className={statusSegmentClass}
        >
          <Search className="size-3" />
          <span className="opacity-90">{fmtBinding("mod+shift+p")}</span>
        </button>
        <span className="px-1 opacity-80">Twigo v0.1.0</span>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
          className="flex size-5 items-center justify-center rounded transition-colors duration-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          {resolvedTheme === "dark" ? (
            <Sun className="size-3.5" />
          ) : (
            <Moon className="size-3.5" />
          )}
        </button>
      </div>
    </footer>
  );
}
