import { parse, stringify, type ActivityItem, type AgentSession, type RoomRecord, type RoomVersion, type TxRecord } from "@maybe/api";
import type { CapabilityPolicy, EventView, Receipt, Strategy, StrategyLifecycleState, StrategyState, TxState, VaultState } from "@maybe/core";
import type { Queryable } from "./jobs.ts";

/**
 * Database access. Amounts live in numeric(20,0) columns or in tagged JSON
 * ({"$b": "…"}) inside jsonb, never as JS numbers.
 */

export const toJsonb = (v: unknown): string => stringify(v);
export const fromJsonb = <T>(v: unknown): T => parse<T>(JSON.stringify(v));
const sec = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : 0);

export class NotFound extends Error {
  readonly status = 404;
}
export class Conflict extends Error {
  readonly status = 409;
}

// ───────────────────────────────────────── users / kv

export async function ensureUser(q: Queryable, address: string): Promise<void> {
  await q.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT (address) DO UPDATE SET last_seen_at = now()`, [address]);
}

export async function kvGet<T>(q: Queryable, key: string): Promise<T | null> {
  const r = await q.query<{ value: unknown }>(`SELECT value FROM kv WHERE key = $1`, [key]);
  return r.rows[0] ? fromJsonb<T>(r.rows[0].value) : null;
}

export async function kvSet(q: Queryable, key: string, value: unknown): Promise<void> {
  await q.query(`INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, toJsonb(value)]);
}

// ───────────────────────────────────────── strategies

export interface StrategyRow {
  id: string;
  owner: string;
  version: number;
  title: string;
  status: StrategyLifecycleState;
  doc: Strategy;
  planHash: string | null;
  planBytes: Uint8Array | null;
  strategyAccount: string | null;
  strategySeed: bigint | null;
  signedAt: number | null;
  viaPolicy: string | null;
  supersedes: string | null;
  sample: boolean;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawStrategy {
  id: string;
  owner: string;
  version: number;
  title: string;
  status: StrategyLifecycleState;
  doc: unknown;
  plan_hash: string | null;
  plan_bytes: Buffer | null;
  strategy_account: string | null;
  strategy_seed: bigint | null;
  signed_at: bigint | null;
  via_policy: string | null;
  supersedes: string | null;
  sample: boolean;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const toStrategy = (r: RawStrategy): StrategyRow => ({
  id: r.id,
  owner: r.owner,
  version: r.version,
  title: r.title,
  status: r.status,
  doc: fromJsonb<Strategy>(r.doc),
  planHash: r.plan_hash,
  planBytes: r.plan_bytes ? new Uint8Array(r.plan_bytes) : null,
  strategyAccount: r.strategy_account,
  strategySeed: r.strategy_seed,
  signedAt: r.signed_at === null ? null : Number(r.signed_at),
  viaPolicy: r.via_policy,
  supersedes: r.supersedes,
  sample: r.sample,
  lastError: r.last_error,
  createdAt: sec(r.created_at),
  updatedAt: sec(r.updated_at),
});

export async function getStrategy(q: Queryable, id: string): Promise<StrategyRow | null> {
  const r = await q.query<RawStrategy>(`SELECT * FROM strategies WHERE id = $1`, [id]);
  return r.rows[0] ? toStrategy(r.rows[0]) : null;
}

export async function getStrategyByAccount(q: Queryable, account: string): Promise<StrategyRow | null> {
  const r = await q.query<RawStrategy>(`SELECT * FROM strategies WHERE strategy_account = $1`, [account]);
  return r.rows[0] ? toStrategy(r.rows[0]) : null;
}

export async function listStrategies(q: Queryable, owner: string): Promise<StrategyRow[]> {
  const r = await q.query<RawStrategy>(`SELECT * FROM strategies WHERE owner = $1 ORDER BY updated_at DESC`, [owner]);
  return r.rows.map(toStrategy);
}

export async function authorizedStrategies(q: Queryable): Promise<StrategyRow[]> {
  const r = await q.query<RawStrategy>(`SELECT * FROM strategies WHERE strategy_account IS NOT NULL ORDER BY updated_at DESC`);
  return r.rows.map(toStrategy);
}

const EDITABLE: StrategyLifecycleState[] = ["DRAFT", "INVALID", "READY", "AWAITING_SIGNATURE", "ACTIVATION_FAILED"];

/** Insert or replace a draft. Authorized versions are immutable: editing one is refused. */
export async function saveDraft(q: Queryable, owner: string, doc: Strategy, status: StrategyLifecycleState, o: { supersedes?: string | null } = {}): Promise<StrategyRow> {
  const r = await q.query<RawStrategy>(
    `INSERT INTO strategies (id, owner, version, title, status, doc, supersedes) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, title = EXCLUDED.title, status = EXCLUDED.status, doc = EXCLUDED.doc,
       last_error = NULL, updated_at = now()
     WHERE strategies.owner = EXCLUDED.owner AND strategies.status = ANY($8::text[]) AND strategies.strategy_account IS NULL
     RETURNING *`,
    [doc.id, owner, doc.version, doc.title, status, toJsonb(doc), o.supersedes ?? null, EDITABLE],
  );
  if (!r.rows[0]) throw new Conflict("This future is already authorized. Editing creates a new version that needs a new signature.");
  return toStrategy(r.rows[0]);
}

export async function deleteDraft(q: Queryable, owner: string, id: string): Promise<void> {
  const r = await q.query(`DELETE FROM strategies WHERE id = $1 AND owner = $2 AND strategy_account IS NULL AND status = ANY($3::text[])`, [id, owner, EDITABLE]);
  if (!r.rowCount && (await getStrategy(q, id))) throw new Conflict("Authorized futures can't be deleted; cancel them instead.");
}

export async function updateStrategy(
  q: Queryable,
  id: string,
  patch: Partial<{ status: StrategyLifecycleState; planHash: string; planBytes: Uint8Array; strategyAccount: string; strategySeed: bigint; signedAt: number; viaPolicy: string | null; lastError: string | null }>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.planHash !== undefined) add("plan_hash", patch.planHash);
  if (patch.planBytes !== undefined) add("plan_bytes", Buffer.from(patch.planBytes));
  if (patch.strategyAccount !== undefined) add("strategy_account", patch.strategyAccount);
  if (patch.strategySeed !== undefined) add("strategy_seed", patch.strategySeed.toString());
  if (patch.signedAt !== undefined) add("signed_at", patch.signedAt);
  if (patch.viaPolicy !== undefined) add("via_policy", patch.viaPolicy);
  if (patch.lastError !== undefined) add("last_error", patch.lastError);
  if (!sets.length) return;
  await q.query(`UPDATE strategies SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
}

// ───────────────────────────────────────── activity

export async function logActivity(q: Queryable, owner: string | null, item: Omit<ActivityItem, "id">, dedupeKey?: string): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO activity (dedupe_key, owner, at, kind, title, detail, amounts, strategy_id, market_key, signature, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (dedupe_key) DO NOTHING`,
    [dedupeKey ?? null, owner, item.at, item.kind, item.title, item.detail ?? null, item.amounts ? toJsonb(item.amounts) : null, item.strategyId ?? null, item.marketKey ?? null, item.tx?.signature ?? null, item.actor],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listActivity(q: Queryable, owner: string | null, limit = 300): Promise<ActivityItem[]> {
  const r = await q.query<{ id: bigint; at: bigint; kind: ActivityItem["kind"]; title: string; detail: string | null; amounts: unknown; strategy_id: string | null; market_key: string | null; signature: string | null; actor: ActivityItem["actor"] }>(
    `SELECT * FROM activity WHERE owner IS NULL OR owner = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [owner, limit],
  );
  return r.rows.map((x) => ({
    id: `act_${x.id}`,
    at: Number(x.at),
    kind: x.kind,
    title: x.title,
    ...(x.detail ? { detail: x.detail } : {}),
    ...(x.amounts ? { amounts: fromJsonb<NonNullable<ActivityItem["amounts"]>>(x.amounts) } : {}),
    ...(x.strategy_id ? { strategyId: x.strategy_id } : {}),
    ...(x.market_key ? { marketKey: x.market_key } : {}),
    ...(x.signature ? { tx: { id: x.signature, label: x.title, state: "CONFIRMED" as TxState, signature: x.signature, createdAt: Number(x.at), updatedAt: Number(x.at), simulated: false } } : {}),
    actor: x.actor,
  }));
}

// ───────────────────────────────────────── receipts

export async function insertReceipt(q: Queryable, signature: string, slot: number, rc: Receipt): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO receipts (strategy_account, action, run, signature, plan_hash, kind, skipped_runs, exec_nonce, at, amount, fee, amount_in, amount_out, in_mint, out_mint, recipient, slot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT DO NOTHING`,
    [rc.strategy, rc.action, rc.run, signature, rc.planHash, rc.kind, rc.skippedRuns, rc.execNonce, rc.at, rc.amount.toString(), rc.fee.toString(), rc.amountIn.toString(), rc.amountOut.toString(), rc.inMint, rc.outMint, rc.recipient, slot],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function receiptsFor(q: Queryable, accounts: string[]): Promise<Map<string, Array<Receipt & { signature: string }>>> {
  const out = new Map<string, Array<Receipt & { signature: string }>>();
  if (!accounts.length) return out;
  const r = await q.query<{ strategy_account: string; action: number; run: number; signature: string; plan_hash: string; kind: number; skipped_runs: number; exec_nonce: bigint; at: bigint; amount: bigint; fee: bigint; amount_in: bigint; amount_out: bigint; in_mint: string; out_mint: string | null; recipient: string | null }>(
    `SELECT * FROM receipts WHERE strategy_account = ANY($1::text[]) ORDER BY exec_nonce`,
    [accounts],
  );
  for (const x of r.rows) {
    const list = out.get(x.strategy_account) ?? [];
    list.push({
      strategy: x.strategy_account,
      planHash: x.plan_hash,
      action: x.action,
      run: x.run,
      skippedRuns: x.skipped_runs,
      execNonce: Number(x.exec_nonce),
      at: Number(x.at),
      kind: x.kind,
      inMint: x.in_mint,
      outMint: x.out_mint,
      amount: BigInt(x.amount),
      fee: BigInt(x.fee),
      amountIn: BigInt(x.amount_in),
      amountOut: BigInt(x.amount_out),
      recipient: x.recipient,
      signature: x.signature,
    });
    out.set(x.strategy_account, list);
  }
  return out;
}

// ───────────────────────────────────────── projections (written by the indexer)

export async function upsertVaultProjection(q: Queryable, v: VaultState, slot: number): Promise<void> {
  await q.query(
    `INSERT INTO vault_projections (vault, owner, policy_epoch, balances, token_balances, slot, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (vault) DO UPDATE SET policy_epoch = EXCLUDED.policy_epoch, balances = EXCLUDED.balances, token_balances = EXCLUDED.token_balances, slot = EXCLUDED.slot, updated_at = now()
     WHERE vault_projections.slot <= EXCLUDED.slot`,
    [v.address, v.owner, v.policyEpoch, toJsonb(v.balances), toJsonb({ tokens: v.tokens, strategyCount: v.strategyCount }), slot],
  );
}

export async function vaultProjection(q: Queryable, vault: string): Promise<VaultState | null> {
  const r = await q.query<{ vault: string; owner: string; policy_epoch: number; balances: unknown; token_balances: unknown }>(`SELECT * FROM vault_projections WHERE vault = $1`, [vault]);
  const x = r.rows[0];
  if (!x) return null;
  const t = fromJsonb<{ tokens: Record<string, bigint>; strategyCount: number }>(x.token_balances);
  return { address: x.vault, owner: x.owner, policyEpoch: x.policy_epoch, balances: fromJsonb(x.balances), tokens: t.tokens, strategyCount: t.strategyCount };
}

export async function allVaults(q: Queryable): Promise<Array<{ vault: string; owner: string }>> {
  return (await q.query<{ vault: string; owner: string }>(`SELECT vault, owner FROM vault_projections`)).rows;
}

export async function upsertStrategyProjection(q: Queryable, s: StrategyState, slot: number): Promise<void> {
  await q.query(
    `INSERT INTO strategy_projections (strategy_account, vault, status, state, slot, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (strategy_account) DO UPDATE SET status = EXCLUDED.status, state = EXCLUDED.state, slot = EXCLUDED.slot, updated_at = now()
     WHERE strategy_projections.slot <= EXCLUDED.slot`,
    [s.address, s.vault, s.status, toJsonb(s), slot],
  );
}

export async function strategyProjections(q: Queryable, o: { accounts?: string[]; activeOnly?: boolean } = {}): Promise<Map<string, StrategyState>> {
  const r = o.accounts
    ? await q.query<{ strategy_account: string; state: unknown }>(`SELECT strategy_account, state FROM strategy_projections WHERE strategy_account = ANY($1::text[])`, [o.accounts])
    : await q.query<{ strategy_account: string; state: unknown }>(`SELECT strategy_account, state FROM strategy_projections ${o.activeOnly ? "WHERE status IN ('ACTIVE', 'PAUSED')" : ""}`);
  return new Map(r.rows.map((x) => [x.strategy_account, fromJsonb<StrategyState>(x.state)]));
}

export interface EventProjection extends EventView {
  address: string;
  proposedAt: number | null;
}

export async function upsertEventProjection(q: Queryable, e: EventProjection, slot: number): Promise<{ changed: boolean; before: EventView | null }> {
  const prev = await q.query<{ status: string; outcome: string | null; final_at: bigint | null; adapter: string; deadline: bigint | null }>(`SELECT * FROM event_projections WHERE event_account = $1`, [e.address]);
  const p = prev.rows[0];
  const before: EventView | null = p ? { status: p.status as EventView["status"], outcome: p.outcome as EventView["outcome"], finalAt: p.final_at === null ? null : Number(p.final_at), adapter: p.adapter as EventView["adapter"], ...(p.deadline !== null ? { deadline: Number(p.deadline) } : {}) } : null;
  const changed = !p || p.status !== e.status || p.outcome !== e.outcome || (p.final_at === null ? null : Number(p.final_at)) !== e.finalAt;
  await q.query(
    `INSERT INTO event_projections (event_account, adapter, status, outcome, final_at, proposed_at, deadline, slot, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (event_account) DO UPDATE SET adapter = EXCLUDED.adapter, status = EXCLUDED.status, outcome = EXCLUDED.outcome, final_at = EXCLUDED.final_at,
       proposed_at = EXCLUDED.proposed_at, deadline = EXCLUDED.deadline, slot = EXCLUDED.slot, updated_at = now()`,
    [e.address, e.adapter, e.status, e.outcome, e.finalAt, e.proposedAt, e.deadline ?? null, slot],
  );
  return { changed, before };
}

export async function eventViews(q: Queryable): Promise<Record<string, EventView>> {
  const r = await q.query<{ event_account: string; adapter: string; status: string; outcome: string | null; final_at: bigint | null; deadline: bigint | null }>(`SELECT * FROM event_projections`);
  const out: Record<string, EventView> = {};
  for (const x of r.rows) {
    out[x.event_account] = { status: x.status as EventView["status"], outcome: x.outcome as EventView["outcome"], finalAt: x.final_at === null ? null : Number(x.final_at), adapter: x.adapter as EventView["adapter"], ...(x.deadline !== null && x.adapter === "BALANCE" ? { deadline: Number(x.deadline) } : {}) };
  }
  return out;
}

// ───────────────────────────────────────── intents and transactions

export type IntentKind = "deposit" | "withdraw" | "authorize" | "pause" | "cancel" | "policy-create" | "policy-revoke" | "kill-switch";

export interface IntentRow {
  id: string;
  key: string;
  kind: IntentKind;
  actor: string;
  owner: string;
  strategyId: string | null;
  payload: Record<string, unknown>;
  state: "BUILT" | "SUBMITTING" | "DONE" | "FAILED";
  error: string | null;
  effectsApplied: number[];
  createdAt: number;
}

interface RawIntent {
  id: string;
  idempotency_key: string;
  kind: IntentKind;
  actor: string;
  owner: string;
  strategy_id: string | null;
  payload: unknown;
  state: IntentRow["state"];
  error: string | null;
  effects_applied: number[];
  created_at: Date;
}
const toIntent = (r: RawIntent): IntentRow => ({ id: r.id, key: r.idempotency_key, kind: r.kind, actor: r.actor, owner: r.owner, strategyId: r.strategy_id, payload: fromJsonb(r.payload), state: r.state, error: r.error, effectsApplied: r.effects_applied, createdAt: sec(r.created_at) });

export async function createIntent(q: Queryable, i: { id: string; key: string; kind: IntentKind; actor: string; owner: string; strategyId?: string | null; payload: Record<string, unknown> }): Promise<{ intent: IntentRow; created: boolean }> {
  const r = await q.query<RawIntent>(
    `INSERT INTO intents (id, idempotency_key, kind, actor, owner, strategy_id, payload) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [i.id, i.key, i.kind, i.actor, i.owner, i.strategyId ?? null, toJsonb(i.payload)],
  );
  if (r.rows[0]) return { intent: toIntent(r.rows[0]), created: true };
  const ex = await q.query<RawIntent>(`SELECT * FROM intents WHERE idempotency_key = $1`, [i.key]);
  return { intent: toIntent(ex.rows[0]!), created: false };
}

export async function getIntent(q: Queryable, id: string): Promise<IntentRow | null> {
  const r = await q.query<RawIntent>(`SELECT * FROM intents WHERE id = $1`, [id]);
  return r.rows[0] ? toIntent(r.rows[0]) : null;
}

export async function setIntent(q: Queryable, id: string, state: IntentRow["state"], error?: string | null): Promise<void> {
  await q.query(`UPDATE intents SET state = $2, error = COALESCE($3, error), updated_at = now() WHERE id = $1`, [id, state, error ?? null]);
}

/** Record that effect `seq` was applied; false if it already was (effects run exactly once). */
export async function markEffect(q: Queryable, id: string, seq: number): Promise<boolean> {
  const r = await q.query(`UPDATE intents SET effects_applied = array_append(effects_applied, $2) WHERE id = $1 AND NOT ($2 = ANY(effects_applied))`, [id, seq]);
  return (r.rowCount ?? 0) > 0;
}

/** How long a runner's claim on an intent lasts without a heartbeat (a crashed runner's intent resumes after this). */
export const INTENT_LEASE_SECONDS = Number(process.env.MAYBE_INTENT_LEASE_SECONDS ?? 60);

/**
 * Lease an intent for sending, or renew a lease this holder already has. Holders are unique per
 * runIntent call, so a second call can't share a live lease, even from the same process.
 */
export async function leaseIntent(q: Queryable, id: string, runner: string, seconds = INTENT_LEASE_SECONDS): Promise<boolean> {
  const r = await q.query(
    `UPDATE intents SET runner = $2, lease_until = now() + make_interval(secs => $3::int) WHERE id = $1 AND state = 'SUBMITTING' AND (runner IS NULL OR runner = $2 OR lease_until < now())`,
    [id, runner, seconds],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function releaseIntent(q: Queryable, id: string, runner: string): Promise<void> {
  await q.query(`UPDATE intents SET runner = NULL, lease_until = NULL WHERE id = $1 AND runner = $2`, [id, runner]);
}

/** Lock a strategy row for the rest of the transaction (authorization and submission serialize on it). */
export async function lockStrategy(q: Queryable, id: string): Promise<StrategyRow | null> {
  const r = await q.query<RawStrategy>(`SELECT * FROM strategies WHERE id = $1 FOR UPDATE`, [id]);
  return r.rows[0] ? toStrategy(r.rows[0]) : null;
}

/** Is an authorization for this strategy being sent right now? */
export async function authorizationInFlight(q: Queryable, strategyId: string): Promise<boolean> {
  const r = await q.query(`SELECT 1 FROM intents WHERE strategy_id = $1 AND kind = 'authorize' AND state = 'SUBMITTING' LIMIT 1`, [strategyId]);
  return (r.rowCount ?? 0) > 0;
}

/** Prepared-but-unsigned authorizations for a strategy can no longer be submitted (the plan or the request changed). */
export async function voidBuiltAuthorizations(q: Queryable, strategyId: string, reason: string, exceptIntent?: string): Promise<number> {
  const r = await q.query<{ id: string }>(
    `UPDATE intents SET state = 'FAILED', error = $2, updated_at = now() WHERE strategy_id = $1 AND kind = 'authorize' AND state = 'BUILT' AND id <> COALESCE($3, '') RETURNING id`,
    [strategyId, reason, exceptIntent ?? null],
  );
  const ids = r.rows.map((x) => x.id);
  if (ids.length) await q.query(`UPDATE transactions SET state = 'FAILED', error = $2, updated_at = now() WHERE intent_id = ANY($1::text[]) AND state IN ('BUILT', 'SIGNED')`, [ids, reason]);
  return ids.length;
}

/** An unsigned intent that can no longer be submitted. */
export async function voidIntent(q: Queryable, id: string, reason: string): Promise<void> {
  const r = await q.query(`UPDATE intents SET state = 'FAILED', error = $2, updated_at = now() WHERE id = $1 AND state = 'BUILT'`, [id, reason]);
  if (r.rowCount) await q.query(`UPDATE transactions SET state = 'FAILED', error = $2, updated_at = now() WHERE intent_id = $1 AND state IN ('BUILT', 'SIGNED')`, [id, reason]);
}

export async function abandonedIntents(q: Queryable): Promise<string[]> {
  return (await q.query<{ id: string }>(`SELECT id FROM intents WHERE state = 'SUBMITTING' AND (lease_until IS NULL OR lease_until < now())`)).rows.map((r) => r.id);
}

export interface TxRow {
  id: string;
  intentId: string;
  seq: number;
  label: string;
  effect: string | null;
  message: Buffer;
  signedTx: Buffer | null;
  signature: string | null;
  state: TxState;
  blockhash: string;
  lastValidBlockHeight: number;
  error: string | null;
  slot: number | null;
  createdAt: number;
  updatedAt: number;
}
interface RawTx {
  id: string;
  intent_id: string;
  seq: number;
  label: string;
  effect: string | null;
  message: Buffer;
  signed_tx: Buffer | null;
  signature: string | null;
  state: TxState;
  blockhash: string;
  last_valid_block_height: bigint;
  error: string | null;
  slot: bigint | null;
  created_at: Date;
  updated_at: Date;
}
const toTx = (r: RawTx): TxRow => ({
  id: r.id,
  intentId: r.intent_id,
  seq: r.seq,
  label: r.label,
  effect: r.effect,
  message: r.message,
  signedTx: r.signed_tx,
  signature: r.signature,
  state: r.state,
  blockhash: r.blockhash,
  lastValidBlockHeight: Number(r.last_valid_block_height),
  error: r.error,
  slot: r.slot === null ? null : Number(r.slot),
  createdAt: sec(r.created_at),
  updatedAt: sec(r.updated_at),
});

export async function insertTx(q: Queryable, t: { id: string; intentId: string; seq: number; label: string; effect?: string; message: Buffer; blockhash: string; lastValidBlockHeight: number }): Promise<void> {
  await q.query(`INSERT INTO transactions (id, intent_id, seq, label, effect, message, blockhash, last_valid_block_height) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    t.id,
    t.intentId,
    t.seq,
    t.label,
    t.effect ?? null,
    t.message,
    t.blockhash,
    t.lastValidBlockHeight,
  ]);
}

export async function intentTxs(q: Queryable, intentId: string): Promise<TxRow[]> {
  return (await q.query<RawTx>(`SELECT * FROM transactions WHERE intent_id = $1 ORDER BY seq`, [intentId])).rows.map(toTx);
}

export async function setTx(q: Queryable, id: string, patch: Partial<{ state: TxState; signedTx: Buffer; signature: string; error: string | null; slot: number }>): Promise<void> {
  await q.query(
    `UPDATE transactions SET state = COALESCE($2, state), signed_tx = COALESCE($3, signed_tx), signature = COALESCE($4, signature), error = CASE WHEN $6 THEN $5 ELSE error END, slot = COALESCE($7, slot), updated_at = now() WHERE id = $1`,
    [id, patch.state ?? null, patch.signedTx ?? null, patch.signature ?? null, patch.error ?? null, patch.error !== undefined, patch.slot ?? null],
  );
}

/** First successful broadcast. Never moves a transaction backwards (a late write can't undo CONFIRMED). */
export async function markSubmitted(q: Queryable, id: string, signature: string): Promise<void> {
  await q.query(`UPDATE transactions SET state = 'SUBMITTED', signature = COALESCE(signature, $2), updated_at = now() WHERE id = $1 AND state IN ('BUILT', 'SIGNED')`, [id, signature]);
}

export function txRecord(t: TxRow): TxRecord {
  return { id: t.id, label: t.label, state: t.state, signature: t.signature ?? "", createdAt: t.createdAt, updatedAt: t.updatedAt, ...(t.error ? { error: t.error } : {}), simulated: false, ...(t.effect ? { effect: t.effect } : {}) };
}

/** Transactions still in flight (or that finished in the last few seconds) for these strategies. */
export async function pendingTxByStrategy(q: Queryable, strategyIds: string[]): Promise<Map<string, TxRecord[]>> {
  const out = new Map<string, TxRecord[]>();
  if (!strategyIds.length) return out;
  const r = await q.query<RawTx & { strategy_id: string }>(
    `SELECT t.*, i.strategy_id FROM transactions t JOIN intents i ON i.id = t.intent_id
      WHERE i.strategy_id = ANY($1::text[]) AND (i.state IN ('BUILT', 'SUBMITTING') OR i.updated_at > now() - interval '6 seconds')
      ORDER BY t.seq`,
    [strategyIds],
  );
  for (const x of r.rows) out.set(x.strategy_id, [...(out.get(x.strategy_id) ?? []), txRecord(toTx(x))]);
  return out;
}

export async function inflightIntents(q: Queryable, owner: string): Promise<Array<IntentRow & { txState: TxState }>> {
  const r = await q.query<RawIntent & { tx_state: TxState }>(
    `SELECT i.*, (SELECT t.state FROM transactions t WHERE t.intent_id = i.id ORDER BY t.seq DESC LIMIT 1) AS tx_state
       FROM intents i WHERE i.owner = $1 AND i.state = 'SUBMITTING'`,
    [owner],
  );
  return r.rows.map((x) => ({ ...toIntent(x), txState: x.tx_state }));
}

export async function openTxs(q: Queryable): Promise<TxRow[]> {
  return (await q.query<RawTx>(`SELECT * FROM transactions WHERE state IN ('CONFIRMED') AND updated_at < now() - interval '2 seconds' ORDER BY updated_at LIMIT 50`)).rows.map(toTx);
}

// ───────────────────────────────────────── agent policies and sessions

export interface PolicyRow {
  address: string;
  owner: string;
  vault: string;
  label: string;
  sessionKey: string;
  limits: Omit<CapabilityPolicy, "address" | "vault" | "owner" | "epoch" | "spent" | "revoked" | "sessionKey">;
  state: CapabilityPolicy | null;
  confirmed: boolean;
  revokedAt: number | null;
}

export async function insertPolicy(q: Queryable, p: Omit<PolicyRow, "state" | "confirmed" | "revokedAt">): Promise<void> {
  await q.query(`INSERT INTO agent_policies (policy_account, owner, vault, label, session_key, limits) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (policy_account) DO NOTHING`, [
    p.address,
    p.owner,
    p.vault,
    p.label,
    p.sessionKey,
    toJsonb(p.limits),
  ]);
}

export async function listPolicies(q: Queryable, owner?: string): Promise<PolicyRow[]> {
  const r = owner
    ? await q.query<{ policy_account: string; owner: string; vault: string; label: string; session_key: string; limits: unknown; state: unknown; confirmed: boolean; revoked_at: Date | null }>(`SELECT * FROM agent_policies WHERE owner = $1 ORDER BY created_at DESC`, [owner])
    : await q.query<{ policy_account: string; owner: string; vault: string; label: string; session_key: string; limits: unknown; state: unknown; confirmed: boolean; revoked_at: Date | null }>(`SELECT * FROM agent_policies ORDER BY created_at DESC`);
  return r.rows.map((x) => ({
    address: x.policy_account,
    owner: x.owner,
    vault: x.vault,
    label: x.label,
    sessionKey: x.session_key,
    limits: fromJsonb(x.limits),
    state: x.state ? fromJsonb<CapabilityPolicy>(x.state) : null,
    confirmed: x.confirmed,
    revokedAt: x.revoked_at ? sec(x.revoked_at) : null,
  }));
}

export async function setPolicyState(q: Queryable, address: string, state: CapabilityPolicy, o: { confirmed?: boolean } = {}): Promise<void> {
  await q.query(`UPDATE agent_policies SET state = $2, confirmed = confirmed OR $3, revoked_at = CASE WHEN $4 AND revoked_at IS NULL THEN now() ELSE revoked_at END WHERE policy_account = $1`, [address, toJsonb(state), o.confirmed ?? false, state.revoked]);
}

export interface SessionRow extends AgentSession {
  owner: string;
  conversation: unknown;
}

export async function getSession(q: Queryable, id: string): Promise<SessionRow | null> {
  const r = await q.query<{ id: string; owner: string; role: AgentSession["role"]; title: string; provider: string; cost_usd: string; conversation: unknown; steps: unknown; created_at: Date }>(`SELECT * FROM agent_sessions WHERE id = $1`, [id]);
  const x = r.rows[0];
  if (!x) return null;
  return { id: x.id, owner: x.owner, role: x.role, title: x.title, provider: x.provider, costUsd: Number(x.cost_usd), conversation: x.conversation, steps: fromJsonb(x.steps), createdAt: sec(x.created_at) };
}

export async function saveSession(q: Queryable, s: SessionRow): Promise<void> {
  await q.query(
    `INSERT INTO agent_sessions (id, owner, role, title, provider, cost_usd, conversation, steps, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))
     ON CONFLICT (id) DO UPDATE SET conversation = EXCLUDED.conversation, steps = EXCLUDED.steps, cost_usd = EXCLUDED.cost_usd`,
    [s.id, s.owner, s.role, s.title, s.provider, s.costUsd, JSON.stringify(s.conversation), toJsonb(s.steps), s.createdAt],
  );
}

export async function listSessions(q: Queryable, owner: string): Promise<AgentSession[]> {
  const r = await q.query<{ id: string; role: AgentSession["role"]; title: string; provider: string; cost_usd: string; steps: unknown; created_at: Date; draft_id?: string }>(`SELECT * FROM agent_sessions WHERE owner = $1 ORDER BY created_at DESC LIMIT 50`, [owner]);
  return r.rows.map((x) => ({ id: x.id, role: x.role, title: x.title, provider: x.provider, costUsd: Number(x.cost_usd), steps: fromJsonb(x.steps), createdAt: sec(x.created_at) }));
}

export async function audit(q: Queryable, sessionId: string | null, event: string, detail: Record<string, unknown>): Promise<void> {
  await q.query(`INSERT INTO agent_audit (session_id, event, detail) VALUES ($1, $2, $3)`, [sessionId, event, toJsonb(detail)]);
}

// ───────────────────────────────────────── rooms

export async function listRooms(q: Queryable): Promise<RoomRecord[]> {
  const rooms = await q.query<{ id: string; slug: string; title: string; author: string; sample: boolean; record: unknown; copies: number; created_at: Date }>(`SELECT * FROM rooms ORDER BY created_at DESC`);
  const versions = await q.query<{ room_id: string; version: number; doc: unknown; plan_hash: string; thesis: string; risk: unknown; published_at: Date }>(`SELECT * FROM room_versions ORDER BY version`);
  const byRoom = new Map<string, RoomVersion[]>();
  for (const v of versions.rows) byRoom.set(v.room_id, [...(byRoom.get(v.room_id) ?? []), { version: v.version, publishedAt: sec(v.published_at), doc: fromJsonb(v.doc), hash: v.plan_hash, thesis: v.thesis, risk: fromJsonb(v.risk) }]);
  return rooms.rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, author: r.author, createdAt: sec(r.created_at), sample: r.sample, versions: byRoom.get(r.id) ?? [], record: fromJsonb(r.record), copies: r.copies }));
}

export async function insertRoom(q: Queryable, r: RoomRecord, o: { owner: string | null; sourceDocId?: string }): Promise<void> {
  await q.query(`INSERT INTO rooms (id, slug, title, author, owner, source_doc_id, sample, record, copies, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10)) ON CONFLICT (id) DO NOTHING`, [
    r.id,
    r.slug,
    r.title,
    r.author,
    o.owner,
    o.sourceDocId ?? null,
    r.sample,
    toJsonb(r.record),
    r.copies,
    r.createdAt,
  ]);
  for (const v of r.versions) await insertRoomVersion(q, r.id, v);
}

/** Versions are append-only: the primary key refuses a second write of the same version. */
export async function insertRoomVersion(q: Queryable, roomId: string, v: RoomVersion): Promise<void> {
  await q.query(`INSERT INTO room_versions (room_id, version, doc, plan_hash, thesis, risk, published_at) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`, [roomId, v.version, toJsonb(v.doc), v.hash, v.thesis, toJsonb(v.risk), v.publishedAt]);
}

export async function roomBySourceDoc(q: Queryable, owner: string, docId: string): Promise<string | null> {
  return (await q.query<{ id: string }>(`SELECT id FROM rooms WHERE owner = $1 AND source_doc_id = $2`, [owner, docId])).rows[0]?.id ?? null;
}

export async function bumpCopies(q: Queryable, roomId: string): Promise<void> {
  await q.query(`UPDATE rooms SET copies = copies + 1 WHERE id = $1`, [roomId]);
}

// ───────────────────────────────────────── reconciliation

export async function recordReconciliation(q: Queryable, scope: string, ok: boolean, detail: string): Promise<void> {
  await q.query(`INSERT INTO reconciliation_runs (scope, ok, detail) VALUES ($1, $2, $3)`, [scope, ok, detail]);
  await q.query(`DELETE FROM reconciliation_runs WHERE id IN (SELECT id FROM reconciliation_runs ORDER BY at DESC OFFSET 200)`);
}

export async function recentReconciliation(q: Queryable, limit = 30): Promise<Array<{ at: number; scope: string; ok: boolean; detail: string }>> {
  return (await q.query<{ at: Date; scope: string; ok: boolean; detail: string }>(`SELECT at, scope, ok, detail FROM reconciliation_runs ORDER BY at DESC LIMIT $1`, [limit])).rows.map((r) => ({ at: sec(r.at), scope: r.scope, ok: r.ok, detail: r.detail }));
}
