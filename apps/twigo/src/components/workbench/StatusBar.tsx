import { Sun, Moon, Search } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUi } from "@/store/ui";
import { usePalette } from "@/store/palette";
import { fmtBinding } from "@/lib/commands";
import { getStatusSegments, statusSegmentClass } from "@/shell/statusBar";

const REPO_URL = "https://github.com/twigo/twigo";

// Open in the OS browser via the opener plugin; fall back to window.open when
// running outside Tauri (e.g. a plain `vite dev` in a browser).
function openRepo(): void {
  void openUrl(REPO_URL).catch(() => {
    window.open(REPO_URL, "_blank", "noopener");
  });
}

// GitHub mark - lucide dropped its brand icons, so inline the official path.
function GitHubMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

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
        <button
          type="button"
          onClick={openRepo}
          aria-label="Twigo on GitHub"
          title="View source on GitHub"
          className={statusSegmentClass}
        >
          <GitHubMark />
          <span className="opacity-90">v0.1.0</span>
        </button>
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
