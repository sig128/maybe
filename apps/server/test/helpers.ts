import pg from "pg";
import { createPool, migrate, type Db } from "../src/db.ts";

export const TEST_DB = process.env.MAYBE_TEST_DATABASE_URL ?? "postgres://maybe:maybe-local-dev@127.0.0.1:5432/maybe_test";

/** A clean schema for each test file (drops and re-runs migrations). */
export async function freshDb(): Promise<Db> {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
  const db = createPool(TEST_DB);
  await migrate(db);
  return db;
}
