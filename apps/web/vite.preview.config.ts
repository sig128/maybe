import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Single-file preview build (simulation only) for static hosts that refuse
 * same-origin script and font files: one bundle, fonts inlined, hash routing.
 * `node scripts/build-preview.mjs` inlines the bundle into one HTML file.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    "import.meta.env.VITE_HASH_ROUTER": JSON.stringify("1"),
    "import.meta.env.VITE_MAYBE_API": JSON.stringify("off"),
  },
  build: {
    target: "es2022",
    outDir: "dist-preview",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 200_000,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
