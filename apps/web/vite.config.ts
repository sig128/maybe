import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 4173, host: "127.0.0.1" },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xyflow")) return "graph";
          if (id.includes("node_modules/react") || id.includes("react-router") || id.includes("scheduler")) return "react";
          if (id.includes("@radix-ui") || id.includes("cmdk")) return "ui";
          if (id.includes("packages/core") || id.includes("packages/agent") || id.includes("@noble") || id.includes("zod") || id.includes("bs58")) return "engine";
          return undefined;
        },
      },
    },
  },
});
