import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { registerKube } from "@twigo/kube";
import { tauriBackend, toIpcError, type Backend } from "@twigo/protocol";
import { createWorkbench, platformOf, WorkbenchView } from "@twigo/workbench";
import { StartupFailure } from "./App";
import { logWebviewErrors } from "./diagnostics";
import { installNativeMenu } from "./nativeMenu";
import { installZoom } from "./zoom";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);
document.documentElement.dataset.platform = platformOf(navigator.userAgent);

async function browserBackend(): Promise<Backend> {
  const { createMockBackend, MOCK_LAYOUTS, MOCK_SCENARIOS } =
    await import("@twigo/protocol/mock");
  const asked = new URLSearchParams(location.search);
  return createMockBackend(
    MOCK_SCENARIOS.find((s) => s === asked.get("scenario")),
    MOCK_LAYOUTS.find((l) => l === asked.get("layout")),
  );
}

async function start(backend: Backend) {
  const workbench = await createWorkbench(
    backend,
    platformOf(navigator.userAgent),
  );
  registerKube(workbench);
  await installZoom(workbench);
  if (isTauri() && workbench.platform === "mac") installNativeMenu(workbench);
  return <WorkbenchView workbench={workbench} />;
}

const backend = isTauri() ? tauriBackend : await browserBackend();
const log = logWebviewErrors(backend);

const view = await start(backend).catch((error: unknown) => {
  log.caught("start", error);
  return <StartupFailure error={toIpcError(error)} />;
});

createRoot(root, log.root).render(<StrictMode>{view}</StrictMode>);
