import { createApp, processIdentity } from "./app.ts";
import { loadConfig, rpcHost } from "./config.ts";
import { migrate } from "./db.ts";
import { log } from "./log.ts";
import { Worker } from "./workers.ts";

/** Background worker: indexer, keeper, settlement watcher, transaction recovery, reconciliation. */
async function main() {
  const cfg = loadConfig();
  const id = processIdentity(process.env.MAYBE_WORKER_ID ?? cfg.WORKER_ID);
  const app = await createApp(cfg, { runner: id });
  await migrate(app.db);
  const w = new Worker(app, id);
  w.start();
  log.info({ id, mode: cfg.MAYBE_MODE, rpc: rpcHost(cfg.RPC_URL) }, "worker started");
  const shutdown = async () => {
    await w.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  log.fatal({ err: (e as Error).message }, "worker failed to start");
  process.exit(1);
});
