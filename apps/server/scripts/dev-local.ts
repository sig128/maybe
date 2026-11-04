/**
 * LOCALNET ONLY. One command for the whole local stack:
 *   local validator (seeded if fresh) → Postgres migrations → API + worker → web app pointed at the API.
 *
 *   pnpm dev:local
 *
 * Env: MAYBE_KEEP_LEDGER=1 keeps an existing validator ledger (and database);
 *      DATABASE_URL overrides the local database.
 * Stop with Ctrl-C (the validator keeps running; `bash scripts/validator.sh stop` stops it).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { repoRoot } from "@maybe/sdk";

const ROOT = repoRoot();
const PATH = `/opt/solana/solana-release/bin:${process.env.HOME}/.local/share/solana/install/active_release/bin:${process.env.PATH}`;
const DB = process.env.DATABASE_URL ?? "postgres://maybe:maybe-local-dev@127.0.0.1:5432/maybe";
const API = "http://127.0.0.1:8787";

async function healthy(url: string, body?: string): Promise<boolean> {
  try {
    const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body } : {});
    return r.ok && (!body || (await r.text()).includes('"ok"'));
  } catch {
    return false;
  }
}

async function main() {
  console.log("MAYBE local stack (local validator, test tokens only)\n");
  const db = new pg.Client({ connectionString: DB });
  try {
    await db.connect();
  } catch (e) {
    console.error(`Postgres isn't reachable at ${DB.replace(/:[^:@/]+@/, ":•••@")} (${(e as Error).message}).\nStart it (e.g. \`docker compose up -d db\` or \`service postgresql start\`) and try again.`);
    process.exit(1);
  }
  const rpcUp = await healthy("http://127.0.0.1:8899", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }));
  const keep = process.env.MAYBE_KEEP_LEDGER === "1";
  const book = join(ROOT, ".localnet", "localnet.json");
  if (!rpcUp || !existsSync(book) || !keep) {
    if (!keep) spawnSync("bash", ["scripts/validator.sh", "stop"], { cwd: ROOT, env: { ...process.env, PATH }, stdio: "ignore" });
    console.log("• starting a fresh local validator");
    const v = spawnSync("bash", ["scripts/validator.sh"], { cwd: ROOT, env: { ...process.env, PATH }, stdio: "inherit" });
    if (v.status !== 0) process.exit(1);
    console.log("• seeding it (test mints, pools, events, development attestors)");
    const s = spawnSync(process.execPath, ["--import", "tsx", "scripts/localnet-setup.ts"], { cwd: join(ROOT, "packages/sdk"), env: { ...process.env, PATH }, stdio: "inherit" });
    if (s.status !== 0) process.exit(1);
    // projections describe a ledger; a new ledger means a new database
    console.log("• resetting the local database for the new ledger");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  }
  await db.end();
  const children: ChildProcess[] = [];
  const run = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => {
      console.log(`${name} exited (${code})`);
      for (const c of children) c.kill("SIGTERM");
      process.exit(code ?? 1);
    });
    children.push(p);
  };
  run("api", process.execPath, ["--import", "tsx", "src/main.ts"], join(ROOT, "apps/server"), { MAYBE_MODE: "localnet", MAYBE_WITH_WORKER: "1", DATABASE_URL: DB, LOG_LEVEL: process.env.LOG_LEVEL ?? "info" });
  for (let i = 0; i < 60 && !(await healthy(`${API}/v1/health`)); i++) await new Promise((r) => setTimeout(r, 500));
  run("web", "pnpm", ["--filter", "@maybe/web", "dev"], ROOT, { VITE_MAYBE_API: API });
  console.log(`\n  API  ${API}/v1/health\n  Web  http://127.0.0.1:5173  (connect the local dev wallet; it gets test SOL, USDC and MAYBE)\n`);
  const stop = () => {
    for (const c of children) c.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
