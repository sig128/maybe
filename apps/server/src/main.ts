import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db.ts";
import { log } from "./log.ts";
import { Hub } from "./outbox.ts";
import { buildRoutes } from "./routes.ts";
import { Worker } from "./workers.ts";

/**
 * API server. With MAYBE_WITH_WORKER=1 the background worker runs in the
 * same process (convenient for local development); in a deployment the
 * worker runs separately (src/worker.ts) and both can be scaled, because
 * jobs, intents and projections coordinate through Postgres.
 */
async function main() {
  const cfg = loadConfig();
  const app = await createApp(cfg, { runner: `api:${process.pid}` });
  const applied = await migrate(app.db);
  if (applied.length) log.info({ applied }, "migrations applied");
  const hub = new Hub(cfg.DATABASE_URL, () => Math.floor(Date.now() / 1000));
  await hub.start();
  const routes = buildRoutes(app, hub);
  const server = serve({ fetch: routes.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => log.info({ port: info.port, mode: cfg.MAYBE_MODE, rpc: cfg.RPC_URL }, "MAYBE API listening"));
  let worker: Worker | null = null;
  if (process.env.MAYBE_WITH_WORKER === "1") {
    worker = new Worker(app, `worker:${process.pid}`);
    worker.start();
    log.info("worker running in-process");
  }
  // first sync so the API has projections even before a worker ticks
  void app.indexer.syncBasics().catch((e) => log.warn({ err: (e as Error).message }, "initial sync failed"));
  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    await worker?.stop();
    server.close();
    await hub.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.fatal({ err: (e as Error).message }, "failed to start");
  process.exit(1);
});
