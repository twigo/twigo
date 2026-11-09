import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // @todo: drop this alias once monaco-worker-manager imports
      // `monaco-editor/editor/editor.worker`: its 2.0.1, the latest, asks
      // for the path below, which Monaco 0.57's `exports` no longer maps
      // (`./*.js` is `./esm/vs/*.js`), so monaco-yaml's worker would not build.
      "monaco-editor/esm/vs/editor/editor.worker.js":
        "monaco-editor/editor/editor.worker",
    },
  },
  optimizeDeps: {
    // monaco-yaml's worker imports it, and the dev server serves a worker's
    // imports as they are, so its CommonJS would not run there.
    include: ["@twigo/kube > monaco-yaml > path-browserify"],
  },
  clearScreen: false,
  // `vite build --mode bench` builds bench/index.html, the app with the
  // bench's driver, for bench/harness.sh; tauri.bench.conf.json points there.
  ...(mode === "bench"
    ? { root: "bench", build: { outDir: "../dist-bench", emptyOutDir: true } }
    : {}),
  server: {
    // devUrl in tauri.conf.json points here.
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
