import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { registerKube } from "@twigo/kube";
import { tauriBackend, toIpcError } from "@twigo/protocol";
import {
  createWorkbench,
  platformOf,
  WorkbenchView,
  type Workbench,
} from "@twigo/workbench";
import { installNativeMenu } from "../src/nativeMenu";
import { installZoom } from "../src/zoom";
import { drive, podsUri } from "./driver";
import { Probe } from "./probe";
import { driveSessions, type Target } from "./sessions";
import "../src/index.css";

const CATALOG_WAIT_MS = 30_000;
/** Twice what `idle` keeps the window hidden for, which the harness samples through. */
const AWAY_MS = 90_000;

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

document.documentElement.classList.toggle(
  "dark",
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);
document.documentElement.dataset.platform = platformOf(navigator.userAgent);

function write(name: string, value: unknown): Promise<void> {
  return invoke("plugin:twigo-bench|write", { name, value });
}

const NOT_VISIBLE =
  "the window is not visible: WebKit renders nothing while the screen is locked";

/** Runs `work` while the window stays visible, since nothing paints otherwise. */
function whileVisible<T>(work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (document.visibilityState !== "visible")
        reject(new Error(NOT_VISIBLE));
    };
    const start = () => {
      if (document.visibilityState !== "visible") {
        reject(new Error(NOT_VISIBLE));
        return;
      }
      document.addEventListener("visibilitychange", check);
      work()
        .then(resolve, reject)
        .finally(() => {
          document.removeEventListener("visibilitychange", check);
        });
    };
    if (document.visibilityState === "visible") start();
    else setTimeout(start, 5000);
  });
}

/** The one context TWIGO_KUBECONFIG names, the harness's cluster, and its space. */
async function benchSpace(
  workbench: Workbench,
): Promise<{ space: string; context: string }> {
  const deadline = performance.now() + CATALOG_WAIT_MS;
  while (workbench.catalog.list === undefined) {
    if (performance.now() > deadline) throw new Error("no catalog");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [context, ...others] = workbench.catalog.list;
  if (!context || others.length > 0) {
    throw new Error(
      `the bench needs one context, its cluster's; the catalog lists ${String(workbench.catalog.list.length)}`,
    );
  }
  return {
    space: (await workbench.spaces.open(context.name)).id,
    context: context.name,
  };
}

/** Resolves once the document is `state`, which it must be within `AWAY_MS`. */
function becomes(state: DocumentVisibilityState): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.visibilityState === state) {
      resolve();
      return;
    }
    const changed = () => {
      if (document.visibilityState !== state) return;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", changed);
      resolve();
    };
    const timer = setTimeout(() => {
      document.removeEventListener("visibilitychange", changed);
      reject(
        new Error(
          `the document did not turn ${state} within ${String(AWAY_MS)} ms`,
        ),
      );
    }, AWAY_MS);
    document.addEventListener("visibilitychange", changed);
  });
}

/**
 * Hides the window as `idle.json` or `idle-sessions.json` says, and writes
 * what the page says of its visibility. The app then quits, or shows the
 * window again, which the sessions wait for.
 */
async function hide(name: string, hidden: string, quit: boolean) {
  const hiding = becomes("hidden").then(() =>
    write(hidden, { visibility: document.visibilityState }),
  );
  await invoke("plugin:twigo-bench|idle", { name, quit });
  await hiding;
}

/** `failure` stops the harness; `sessions-failure` only leaves the sessions' rows unmeasured. */
function failed(name: "failure" | "sessions-failure") {
  return (error: unknown) =>
    write(name, { message: toIpcError(error).message });
}

async function run(container: HTMLElement) {
  const target = await invoke<Target>("plugin:twigo-bench|setup");
  const probe = new Probe(tauriBackend);
  const workbench = await createWorkbench(
    probe.backend,
    platformOf(navigator.userAgent),
  );
  registerKube(workbench);
  await installZoom(workbench);
  if (workbench.platform === "mac") installNativeMenu(workbench);
  createRoot(container).render(
    <StrictMode>
      <WorkbenchView workbench={workbench} />
    </StrictMode>,
  );
  const { space, context } = await benchSpace(workbench);
  const results = await whileVisible(() =>
    drive(workbench, probe, {
      space,
      steady: () => write("steady", {}),
      visible: () => write("visible", {}),
    }),
  );
  await write("webview", results);
  await hide("idle", "hidden", false);
  await becomes("visible")
    .then(() =>
      whileVisible(() =>
        driveSessions(workbench, probe, {
          space,
          context,
          list: podsUri(space),
          rows: results.rows,
          target,
          write,
        }),
      ),
    )
    .catch(failed("sessions-failure"));
}

await run(root).catch(failed("failure"));
await hide("idle-sessions", "hidden-sessions", true);
