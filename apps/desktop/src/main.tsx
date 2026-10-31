import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Workbench } from "@twigo/workbench";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);
