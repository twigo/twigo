import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { registerKube } from "@twigo/kube";
import { tauriBackend, toIpcError, type Backend } from "@twigo/protocol";
import { createWorkbench, platformOf, WorkbenchView } from "@twigo/workbench";
import { StartupFailure } from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

async function browserBackend(): Promise<Backend> {
  const { createMockBackend, MOCK_SCENARIOS } =
    await import("@twigo/protocol/mock");
  const asked = new URLSearchParams(location.search).get("scenario");
  return createMockBackend(MOCK_SCENARIOS.find((s) => s === asked));
}

async function start() {
  const backend = isTauri() ? tauriBackend : await browserBackend();
  const workbench = await createWorkbench(
    backend,
    platformOf(navigator.userAgent),
  );
  registerKube(workbench);
  return <WorkbenchView workbench={workbench} />;
}

const view = await start().catch((error: unknown) => (
  <StartupFailure message={toIpcError(error).message} />
));

createRoot(root).render(<StrictMode>{view}</StrictMode>);
