import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useToasts } from "@/store/toasts";

const UPDATE_KEY = "app:update";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function install(update: Update): Promise<void> {
  const toasts = useToasts.getState();
  try {
    toasts.push("info", `Installing ${update.version}…`, {
      key: UPDATE_KEY,
      ttl: Infinity,
    });
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    toasts.push("error", `Update failed: ${String(e)}`, { key: UPDATE_KEY });
  }
}

// Check GitHub Releases for a newer signed build. `silent` (the launch check)
// stays quiet unless an update is found; a manual check always reports back.
export async function checkForUpdates({ silent = false } = {}): Promise<void> {
  if (!inTauri()) return;
  const toasts = useToasts.getState();
  try {
    const update = await check();
    if (!update) {
      if (!silent) {
        toasts.push("success", "You're on the latest version.");
      }
      return;
    }
    toasts.push("info", `Update ${update.version} is available`, {
      key: UPDATE_KEY,
      ttl: Infinity,
      action: { label: "Install & restart", run: () => void install(update) },
    });
  } catch (e) {
    if (!silent) {
      toasts.push("error", `Update check failed: ${String(e)}`);
    }
  }
}
