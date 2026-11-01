import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
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
