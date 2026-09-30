import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/client"),
  publicDir: path.resolve(import.meta.dirname, "assets"),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, "dist/client"), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
