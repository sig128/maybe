import { randomBytes } from "node:crypto";
import { buildFixtures, type FixtureSet } from "@maybe/core";
import { defaultBookPath, loadLocalnetBook, toCoreAddressBook, type LocalnetBook } from "@maybe/sdk";
import { Chain } from "./chain.ts";
import { ConfigError, type Config } from "./config.ts";
import { createPool, type Db } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { publish, type Topic } from "./outbox.ts";
import { kvGet } from "./store.ts";

/** Everything a request handler or worker loop needs, created once per process. */
export interface App {
  cfg: Config;
  db: Db;
  chain: Chain;
  book: LocalnetBook;
  fx: FixtureSet;
  mode: "localnet" | "devnet";
  indexer: Indexer;
  /** this process's identity for leases */
  runner: string;
  publish(topics: Topic[]): Promise<void>;
  /** chain time (validator clock), falling back to the last value the indexer saw */
  now(): Promise<number>;
  close(): Promise<void>;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function loadBook(cfg: Config): LocalnetBook {
  const path = cfg.LOCALNET_BOOK ?? defaultBookPath();
  const book = loadLocalnetBook(path);
  if (!book) throw new ConfigError(`No address book at ${path}. Start a validator and seed it first: bash scripts/validator.sh && npx tsx scripts/localnet-setup.ts`);
  if (cfg.MAYBE_MODE === "localnet" && !/127\.0\.0\.1|localhost/.test(book.rpc)) throw new ConfigError("The localnet address book points at a non-local RPC.");
  return book;
}

export async function createApp(cfg: Config, o: { runner?: string; db?: Db } = {}): Promise<App> {
  if (cfg.MAYBE_MODE === "production") throw new ConfigError("Production mode needs a reviewed deployment (see docs/DEPLOYMENT.md); this build only runs localnet and devnet.");
  const book = loadBook(cfg);
  const db = o.db ?? createPool(cfg.DATABASE_URL);
  const chain = new Chain(book, cfg);
  const fx = buildFixtures(book.createdAt, toCoreAddressBook(book), "localnet");
  const app: App = {
    cfg,
    db,
    chain,
    book,
    fx,
    mode: cfg.MAYBE_MODE === "devnet" ? "devnet" : "localnet",
    indexer: undefined as unknown as Indexer,
    runner: o.runner ?? `${cfg.WORKER_ID}:${process.pid}`,
    publish: (topics) => publish(db, topics),
    now: async () => {
      try {
        return await chain.clock();
      } catch {
        return (await kvGet<{ now: number }>(db, "chain"))?.now ?? Math.floor(Date.now() / 1000);
      }
    },
    close: async () => {
      await db.end();
    },
  };
  app.indexer = new Indexer(app);
  return app;
}
