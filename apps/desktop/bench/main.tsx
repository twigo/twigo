import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { registerKube } from "@twigo/kube";
import { toIpcError } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { createWorkbench, platformOf, WorkbenchView } from "@twigo/workbench";
import { installNativeMenu } from "../src/nativeMenu";
import { drive } from "./driver";
import { Probe } from "./probe";
import "../src/index.css";

const CHANGES_PER_SECOND = 100;

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
  "the window is not visible: WebKit renders nothing while the screen is locked or asleep";

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

async function run(container: HTMLElement) {
  // @todo: replace the mock with tauriBackend once Rust serves the pod list (M1).
  const probe = new Probe(createMockBackend("live", "us", CHANGES_PER_SECOND));
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
  const results = await whileVisible(() =>
    drive(workbench, probe, {
      backend: "mock",
      changesPerSecond: CHANGES_PER_SECOND,
      steady: () => write("steady", {}),
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
