import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// electron-vite config: main (kernel) + preload + renderer (React+Monaco studio).
// Layout: app/{main,preload,renderer}. Output: app/out/{main,preload,renderer}.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: r("main/index.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: r("preload/index.ts") } } },
  },
  renderer: {
    root: r("renderer"),
    build: { rollupOptions: { input: { index: r("renderer/index.html") } } },
    plugins: [react()],
  },
});
