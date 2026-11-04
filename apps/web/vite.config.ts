import { copyFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Public builds (VITE_PUBLIC_SITE=1) are what goes on the open web: the live Odds board on its own
 * (odds.html → src/site), with a Content-Security-Policy, built to work on a static host without
 * rewrites (unknown paths get 404.html, which is the same page). The full app isn't part of it.
 *
 * The live board connects to these hosts straight from the browser. Token metadata and images can
 * sit on any https host (IPFS gateways, launchpad CDNs), so https stays open for fetches and images.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss://pumpportal.fun wss://solana-rpc.publicnode.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function publicSite(): Plugin {
  let outDir = "dist";
  return {
    name: "maybe-public-site",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
    closeBundle() {
      // the site's page is built from odds.html; static hosts serve index.html, and 404.html for any other path
      renameSync(resolve(outDir, "odds.html"), resolve(outDir, "index.html"));
      copyFileSync(resolve(outDir, "index.html"), resolve(outDir, "404.html"));
      writeFileSync(resolve(outDir, ".nojekyll"), "");
    },
  };
}

const PUBLIC_SITE = process.env.VITE_PUBLIC_SITE === "1";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react(), ...(PUBLIC_SITE ? [publicSite()] : [])],
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 4173, host: "127.0.0.1" },
  build: {
    target: "es2022",
    // public builds ship without source maps; local builds keep them for debugging
    sourcemap: !PUBLIC_SITE,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      ...(PUBLIC_SITE ? { input: resolve(here, "odds.html") } : {}),
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
