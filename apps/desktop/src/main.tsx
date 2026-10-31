import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { tauriBackend, type Backend } from "@twigo/protocol";
import { App } from "./App";
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

const backend = isTauri() ? tauriBackend : await browserBackend();

createRoot(root).render(
  <StrictMode>
    <App backend={backend} />
  </StrictMode>,
);
