import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
migrate(db)
  .then((applied) => {
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
    return db.end();
  })
  .catch(async (e) => {
    console.error(`migration failed: ${(e as Error).message}`);
    await db.end();
    process.exit(1);
  });
