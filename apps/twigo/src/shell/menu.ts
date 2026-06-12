import { Menu, type MenuItemOptions } from "@tauri-apps/api/menu";
import { getCommands } from "@/lib/commands";
import { getViews } from "@/shell/views";
import { useUi } from "@/store/ui";
import { usePalette } from "@/store/palette";
import { useHelp } from "@/store/help";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// This menu is macOS-shaped (an app menu with Services/Hide, a global menu bar,
// and accelerators the OS consumes before the webview). On Windows/Linux the
// webview handles clipboard shortcuts itself and there's no global menu bar, and
// accelerators would double-fire with the keydown loop — so we skip it there.
const isMac =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

// "mod+shift+p" → "CmdOrCtrl+Shift+P" (Tauri accelerator syntax). Exported for
// the unit test.
export function toAccelerator(binding: string): string {
  return binding
    .split("+")
    .map((p) =>
      p === "mod"
        ? "CmdOrCtrl"
        : p === "alt"
          ? "Alt"
          : p === "shift"
            ? "Shift"
            : p.length === 1
              ? p.toUpperCase()
              : p,
    )
    .join("+");
}

// A native menu item that runs a registered command by id, showing its keybind
// as the accelerator. macOS handles the accelerator natively (it never reaches
// the webview keydown), so there's no double-firing with the command loop.
function cmdItem(id: string, fallback: string): MenuItemOptions {
  const c = getCommands().find((x) => x.id === id);
  return {
    text: c?.title ?? fallback,
    accelerator: c?.keybinding ? toAccelerator(c.keybinding) : undefined,
    action: () => {
      getCommands()
        .find((x) => x.id === id)
        ?.run();
    },
  };
}

// Build the native application menu once at startup, mirroring the command
// registry. The predefined Edit/Window/App items keep clipboard shortcuts and
// standard macOS behaviours working (a custom menu replaces Tauri's default).
export async function setupAppMenu(): Promise<void> {
  if (!isTauri || !isMac) return;
  try {
    await buildAndSetMenu();
  } catch (e) {
    // A menu failure must not break startup; surface it for debugging only.
    console.error("Failed to set the application menu:", e);
  }
}

async function buildAndSetMenu(): Promise<void> {
  const goToViews: MenuItemOptions[] = getViews().map((v) => ({
    text: `Go to ${v.title}`,
    action: () => {
      useUi.getState().setView(v.id);
    },
  }));

  const menu = await Menu.new({
    items: [
      {
        text: "Twigo",
        items: [
          { item: { About: { name: "Twigo", version: "0.1.0" } } },
          { item: "Separator" },
          cmdItem("settings.open", "Settings…"),
          { item: "Separator" },
          { item: "Services" },
          { item: "Separator" },
          { item: "Hide" },
          { item: "HideOthers" },
          { item: "ShowAll" },
          { item: "Separator" },
          { item: "Quit" },
        ],
      },
      {
        text: "Edit",
        items: [
          { item: "Undo" },
          { item: "Redo" },
          { item: "Separator" },
          { item: "Cut" },
          { item: "Copy" },
          { item: "Paste" },
          { item: "SelectAll" },
        ],
      },
      {
        text: "View",
        items: [
          cmdItem("layout.sidebar", "Toggle Sidebar"),
          cmdItem("layout.inspector", "Toggle Inspector"),
          cmdItem("theme.toggle", "Toggle Theme"),
          { item: "Separator" },
          cmdItem("zoom.in", "Zoom In"),
          cmdItem("zoom.out", "Zoom Out"),
          cmdItem("zoom.reset", "Actual Size"),
          { item: "Separator" },
          {
            text: "Reload",
            accelerator: "CmdOrCtrl+R",
            action: () => {
              window.location.reload();
            },
          },
          { item: "Fullscreen" },
        ],
      },
      {
        text: "Go",
        items: [
          {
            text: "Command Palette",
            accelerator: "CmdOrCtrl+Shift+P",
            action: () => {
              usePalette.getState().toggle();
            },
          },
          { item: "Separator" },
          ...goToViews,
        ],
      },
      {
        text: "Window",
        items: [
          { item: "Minimize" },
          { item: "Maximize" },
          { item: "Separator" },
          { item: "CloseWindow" },
        ],
      },
      {
        text: "Help",
        items: [
          {
            text: "Keyboard Shortcuts",
            action: () => {
              useHelp.getState().toggle();
            },
          },
        ],
      },
    ],
  });

  await menu.setAsAppMenu();
}
