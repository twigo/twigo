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
import { drive } from "./driver";
import { Probe } from "./probe";
import "../src/index.css";

const CATALOG_WAIT_MS = 30_000;

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

document.documentElement.classList.toggle(
  "dark",
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);

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

/** The space of the one context TWIGO_KUBECONFIG names, the harness's cluster. */
async function benchSpace(workbench: Workbench): Promise<string> {
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
  return (await workbench.spaces.open(context.name)).id;
}

async function run(container: HTMLElement) {
  const probe = new Probe(tauriBackend);
  const workbench = await createWorkbench(
    probe.backend,
    platformOf(navigator.userAgent),
  );
  registerKube(workbench);
  if (workbench.platform === "mac") installNativeMenu(workbench);
  createRoot(container).render(
    <StrictMode>
      <WorkbenchView workbench={workbench} />
    </StrictMode>,
  );
  const space = await benchSpace(workbench);
  const results = await whileVisible(() =>
    drive(workbench, probe, {
      space,
      steady: () => write("steady", {}),
      visible: () => write("visible", {}),
    }),
  );
  await write("webview", results);
}

await run(root).catch((error: unknown) =>
  write("failure", { message: toIpcError(error).message }),
);
document.addEventListener(
  "visibilitychange",
  () => void write("hidden", { visibility: document.visibilityState }),
  { once: true },
);
await invoke("plugin:twigo-bench|idle");
