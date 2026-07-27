import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useToasts } from "@/store/toasts";
import { useUpdateCheck } from "@/store/updateCheck";

const UPDATE_KEY = "app:update";
const CHECK_FAILED_KEY = "app:update-check-failed";
// The quiet check runs once per launch, so this counts launches. A single
// failure is ordinary (started offline); a run of them means the update channel
// itself is broken, which is otherwise invisible until someone reports it.
const FAILURE_LIMIT = 3;

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
// stays quiet about *finding nothing*, never about failing to look: a check
// that errors is always recorded and eventually surfaced.
export async function checkForUpdates({ silent = false } = {}): Promise<void> {
  if (!inTauri()) return;
  const toasts = useToasts.getState();
  try {
    const update = await check();
    useUpdateCheck.getState().recordSuccess();
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
    const message = e instanceof Error ? e.message : String(e);
    console.error("[update check]", e);
    const failures = useUpdateCheck.getState().recordFailure(message);
    if (!silent) {
      toasts.push("error", `Update check failed: ${message}`);
      return;
    }
    if (failures >= FAILURE_LIMIT) {
      useUpdateCheck.getState().snooze();
      toasts.push(
        "warning",
        "Update checks keep failing — you may be missing new versions.",
        {
          key: CHECK_FAILED_KEY,
          action: { label: "Check again", run: () => void checkForUpdates() },
        },
      );
    }
  }
}
