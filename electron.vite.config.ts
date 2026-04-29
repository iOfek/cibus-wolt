/**
 * electron-vite config — wires the three Electron entry points.
 *
 * `main`     bundles electron/main/index.ts     → out/main/index.js
 * `preload`  bundles electron/preload/index.ts  → out/preload/index.js
 * `renderer` serves electron/renderer/ in dev (Vite dev server with HMR),
 *           builds to out/renderer/ for production.
 *
 * `externalizeDepsPlugin()` keeps node_modules out of the main/preload
 * bundles — important for native modules like Playwright/imapflow that
 * can't be bundled and need to load from node_modules at runtime.
 */

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

const here = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(here, "electron/main/index.ts") },
      outDir: "out/main",
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(here, "electron/preload/index.ts") },
      outDir: "out/preload",
    },
  },
  renderer: {
    root: resolve(here, "electron/renderer"),
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(here, "electron/renderer/index.html"),
      },
    },
  },
});
