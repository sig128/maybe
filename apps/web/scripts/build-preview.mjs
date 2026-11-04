// Build the simulation into ONE self-contained HTML fragment (no external files).
// Output: dist-preview/maybe-preview.html
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
execFileSync("npx", ["vite", "build", "--config", "vite.preview.config.ts"], { cwd: root, stdio: "inherit" });
const dist = join(root, "dist-preview");
const assets = readdirSync(join(dist, "assets"));
const js = assets.filter((f) => f.endsWith(".js"));
const css = assets.filter((f) => f.endsWith(".css"));
if (js.length !== 1) throw new Error(`expected one bundle, got ${js.join(", ")}`);
const script = readFileSync(join(dist, "assets", js[0]), "utf8").replaceAll("</script", "<\\/script");
const style = css.map((f) => readFileSync(join(dist, "assets", f), "utf8")).join("\n").replaceAll("</style", "<\\/style");
const icon = `data:image/svg+xml;base64,${readFileSync(join(dist, "mark.svg")).toString("base64")}`;
const html = [
  "<title>Maybe futures</title>",
  '<meta name="description" content="MAYBE — program what your money does when possible futures become real. Simulation with sample data.">',
  '<meta name="color-scheme" content="dark">',
  `<link rel="icon" type="image/svg+xml" href="${icon}">`,
  `<style>${style}\n:root{color-scheme:dark}html,body{background:var(--c-canvas)}</style>`,
  '<div id="root"></div>',
  "<noscript>MAYBE needs JavaScript to run.</noscript>",
  `<script type="module">${script}</script>`,
].join("\n");
writeFileSync(join(dist, "maybe-preview.html"), html);
console.log(`maybe-preview.html: ${(html.length / 1024).toFixed(0)} KB`);
