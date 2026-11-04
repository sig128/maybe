import type pg from "pg";
import type { JobState } from "@maybe/core";

/**
 * Durable job queue on Postgres. Enqueue is idempotent by key; claiming uses
 * FOR UPDATE SKIP LOCKED with a lease, so a crashed worker's job comes back
 * after the lease expires. A queue can't make spending exactly-once on its
 * own: execute jobs re-read chain state before acting, and the program
 * rejects a (strategy, action, run) that already happened.
 */

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export interface Job<P = Record<string, unknown>> {
  id: string;
  kind: string;
  key: string;
  payload: P;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lastError: string | null;
}

interface JobRow {
  id: bigint;
  kind: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
}

const toJob = (r: JobRow): Job => ({ id: String(r.id), kind: r.kind, key: r.idempotency_key, payload: r.payload, state: r.state, attempts: r.attempts, maxAttempts: r.max_attempts, runAt: r.run_at, lastError: r.last_error });

/** Returns true when a new job was created (false: one with this key already exists, in any state). */
export async function enqueue(q: Queryable, kind: string, key: string, payload: Record<string, unknown>, o: { runAt?: Date; maxAttempts?: number } = {}): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO jobs (kind, idempotency_key, payload, run_at, max_attempts) VALUES ($1, $2, $3, COALESCE($4, now()), $5)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [kind, key, JSON.stringify(payload), o.runAt ?? null, o.maxAttempts ?? 8],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function claim(q: Queryable, worker: string, kinds: string[], o: { limit?: number; leaseSeconds?: number } = {}): Promise<Job[]> {
  const r = await q.query<JobRow>(
    `WITH ready AS (
       SELECT id FROM jobs
        WHERE kind = ANY($2::text[])
          AND ((state IN ('QUEUED', 'RETRY_WAIT') AND run_at <= now())
               OR (state = 'RUNNING' AND locked_until < now()))
        ORDER BY run_at, id
        LIMIT $3
        FOR UPDATE SKIP LOCKED)
     UPDATE jobs j
        SET state = 'RUNNING', locked_by = $1, locked_until = now() + make_interval(secs => $4::int),
            attempts = j.attempts + 1, updated_at = now()
       FROM ready WHERE j.id = ready.id
     RETURNING j.*`,
    [worker, kinds, o.limit ?? 4, o.leaseSeconds ?? 30],
  );
  return r.rows.map(toJob);
}

/** Only the current lease holder can finish a job; a late finisher (lease expired, reclaimed) is ignored. */
export async function succeed(q: Queryable, job: Job, worker: string): Promise<boolean> {
  const r = await q.query(`UPDATE jobs SET state = 'SUCCEEDED', locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1 AND locked_by = $2 AND state = 'RUNNING'`, [job.id, worker]);
  return (r.rowCount ?? 0) > 0;
}

export function backoffSeconds(attempt: number): number {
  return Math.min(60, 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 3);
}

export async function fail(q: Queryable, job: Job, worker: string, error: string, o: { retryable: boolean; delaySeconds?: number }): Promise<JobState> {
  const dead = !o.retryable || job.attempts >= job.maxAttempts;
  const state: JobState = dead ? "DEAD" : "RETRY_WAIT";
  await q.query(
    `UPDATE jobs SET state = $3, last_error = $4, locked_by = NULL, locked_until = NULL,
            run_at = CASE WHEN $3 = 'RETRY_WAIT' THEN now() + make_interval(secs => $5::int) ELSE run_at END, updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [job.id, worker, state, error.slice(0, 2000), o.delaySeconds ?? backoffSeconds(job.attempts)],
  );
  return state;
}

/** Not ready yet (waiting on an event, a schedule or a pause): try later without spending an attempt. */
export async function defer(q: Queryable, job: Job, worker: string, seconds: number, note?: string): Promise<void> {
  await q.query(
    `UPDATE jobs SET state = 'RETRY_WAIT', attempts = GREATEST(attempts - 1, 0), last_error = $4, locked_by = NULL, locked_until = NULL,
            run_at = now() + make_interval(secs => $3::int), updated_at = now() WHERE id = $1 AND locked_by = $2`,
    [job.id, worker, Math.max(1, Math.ceil(seconds)), note ?? null],
  );
}

export async function heartbeat(q: Queryable, job: Job, worker: string, leaseSeconds = 30): Promise<void> {
  await q.query(`UPDATE jobs SET locked_until = now() + make_interval(secs => $3::int) WHERE id = $1 AND locked_by = $2`, [job.id, worker, leaseSeconds]);
}

export async function recentJobs(q: Queryable, limit = 40) {
  const r = await q.query<JobRow & { updated_at: Date }>(`SELECT * FROM jobs WHERE state <> 'SUCCEEDED' OR updated_at > now() - interval '2 minutes' ORDER BY updated_at DESC LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ ...toJob(x), updatedAt: x.updated_at }));
}
