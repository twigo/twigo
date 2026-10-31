// A validator in miniature: it refuses `bypass` and passes everything else
// unchanged, so the cost measurements see the pattern itself.
window.__TAURI_ISOLATION_HOOK__ = (payload) => {
  if (payload.cmd === "bypass") throw new Error("the hook refuses bypass");
  return payload;
};
