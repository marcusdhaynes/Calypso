import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      // Prefer built packages (npm run build runs shared/ui before desktop)
      "@calypso/shared": path.resolve(__dirname, "../../packages/shared/dist/index.js"),
      "@calypso/ui/styles.css": path.resolve(__dirname, "../../packages/ui/src/styles/global.css"),
      "@calypso/ui": path.resolve(__dirname, "../../packages/ui/dist/index.js"),
    },
  },
});
