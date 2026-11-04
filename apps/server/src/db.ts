import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// numeric(20,0) → bigint, int8 → bigint: amounts never pass through JS floats
pg.types.setTypeParser(1700, (v) => BigInt(v));
pg.types.setTypeParser(20, (v) => BigInt(v));

export type Db = pg.Pool;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
}

export async function withTx<T>(db: Db, f: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await f(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(db: Db): Promise<string[]> {
  const dir = join(here, "..", "migrations");
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  const done: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8").replace(/CREATE TABLE IF NOT EXISTS schema_migrations[^;]+;/, "");
    await withTx(db, async (c) => {
      // serialize concurrent migrators
      await c.query("SELECT pg_advisory_xact_lock(424242)");
      const again = await c.query("SELECT 1 FROM schema_migrations WHERE version = $1", [f]);
      if (again.rowCount) return;
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [f]);
    });
    done.push(f);
  }
  return done;
}
