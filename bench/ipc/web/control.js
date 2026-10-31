"use strict";

// The negative control: a same-origin frame reaches the window's IPC, so the
// probe count shows that a frame which gets through is counted.
(async () => {
  const attempts = [];
  try {
    await window.parent.__TAURI_INTERNALS__.invoke("probe", {
      source: "control",
    });
    attempts.push({
      path: "parent.__TAURI_INTERNALS__.invoke",
      outcome: "answered",
    });
  } catch (error) {
    attempts.push({
      path: "parent.__TAURI_INTERNALS__.invoke",
      outcome: "threw",
      detail: String(error),
    });
  }
  window.parent.postMessage({ type: "twigo-probe-report", attempts }, "*");
})();
