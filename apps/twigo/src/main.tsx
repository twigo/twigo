import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerNatsModule } from "./modules/nats";
import { setupAppMenu } from "./shell/menu";
import { installGlobalErrorHandlers } from "./lib/errors";
import "./index.css";

installGlobalErrorHandlers();

// Wire the NATS domain into the shell registries before the first render so the
// workbench (views, commands, status bar, watermark) has its contributions. A
// second technology (e.g. Kubernetes) is a sibling register<Domain>Module()
// call here - the shell, space tabs and registries already support it.
registerNatsModule();
// Build the native app menu from the registries (no-op outside Tauri).
void setupAppMenu();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
