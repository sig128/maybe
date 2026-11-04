import { PublicKey } from "@solana/web3.js";
import { bytesToHex, decodePlan, formatAmount, type CapabilityPolicy, type Receipt, type StrategyLifecycleState, type StrategyState } from "@maybe/core";
import { fmtUnits, receiptActivity } from "@maybe/api";
import { toEventView, toStrategyState, toVaultState, type ExecutionReceiptEvent, type PolicyAccount, type VaultEvent } from "@maybe/sdk";
import type { App } from "./app.ts";
import { log } from "./log.ts";
import {
  getStrategyByAccount,
  insertReceipt,
  kvGet,
  kvSet,
  listPolicies,
  logActivity,
  receiptsFor,
  setPolicyState,
  updateStrategy,
  upsertEventProjection,
  upsertStrategyProjection,
  upsertVaultProjection,
  type StrategyRow,
} from "./store.ts";

/**
 * Projects on-chain state into Postgres. The chain is the source of truth;
 * projections are what the API reads, and every write here is idempotent, so
 * running the indexer twice (or in two processes) is harmless.
 */

const DEFAULT_KEY = PublicKey.default;

export function toCoreReceipt(e: ExecutionReceiptEvent): Receipt {
  return {
    strategy: e.strategy.toBase58(),
    planHash: bytesToHex(e.planHash),
    action: e.action,
    run: e.run,
    skippedRuns: e.skippedRuns,
    execNonce: Number(e.execNonce),
    at: e.at,
    kind: e.kind,
    inMint: e.inMint.toBase58(),
    outMint: e.outMint.equals(DEFAULT_KEY) ? null : e.outMint.toBase58(),
    amount: e.amount,
    fee: e.fee,
    amountIn: e.amountIn,
    amountOut: e.amountOut,
    recipient: e.recipient.equals(DEFAULT_KEY) ? null : e.recipient.toBase58(),
  };
}

const CHAIN_TO_LIFECYCLE: Record<string, StrategyLifecycleState> = { ACTIVE: "ACTIVE", PAUSED: "PAUSED", COMPLETED: "COMPLETED", EXPIRED: "EXPIRED", CANCELLED: "CANCELLED" };

export function policyView(address: string, p: PolicyAccount, label: string, vaultEpoch: number): CapabilityPolicy {
  const mints = p.allowedMints.map((m) => m.toBase58());
  const rec = (vals: bigint[]) => Object.fromEntries(mints.map((m, i) => [m, vals[i] ?? 0n]));
  return {
    address,
    vault: p.vault.toBase58(),
    owner: p.owner.toBase58(),
    sessionKey: p.sessionKey.toBase58(),
    label,
    epoch: p.epoch,
    canCreate: p.canCreate,
    canCancel: p.canCancel,
    allowedMints: mints,
    allowedRoutes: p.allowedRoutes.map((k) => k.toBase58()),
    allowedRecipients: p.allowedRecipients.map((k) => k.toBase58()),
    maxTotal: rec(p.maxTotal),
    maxPerAction: rec(p.maxPerAction),
    maxFeeBps: p.maxFeeBps,
    expiresAt: p.expiresAt,
    spent: rec(p.spent),
    revoked: p.revoked || p.epoch !== vaultEpoch,
  };
}

export class Indexer {
  constructor(private readonly app: App) {}

  private fmt(mint: string, units: bigint) {
    return fmtUnits(this.app.fx, mint, units);
  }

  /** Clock, global pause, outcome events and pool reserves. */
  async syncBasics(): Promise<{ eventsChanged: number }> {
    const { chain, db, fx, book } = this.app;
    const [now, cfg, slot] = await Promise.all([chain.clock(), chain.config(), chain.conn.getSlot("confirmed")]);
    const prev = await kvGet<{ paused: boolean }>(db, "chain");
    await kvSet(db, "chain", { now, paused: cfg.pausedExecution, slot, allowDevAttestors: cfg.allowDevAttestors });
    if (prev && prev.paused !== cfg.pausedExecution) {
      await logActivity(db, null, { at: now, kind: "system", title: cfg.pausedExecution ? "Emergency pause: new steps stopped" : "Emergency pause lifted", ...(cfg.pausedExecution ? { detail: "Withdrawals, cancellations and refunds still work." } : {}), actor: "system" }, `pause:${slot}`);
      await this.app.publish(["ops", "strategies", "activity"]);
    }
    const accounts = await chain.events(Object.values(book.events).map((e) => e.address));
    let changed = 0;
    for (const [address, acct] of accounts) {
      const view = toEventView(acct);
      const { changed: c, before } = await upsertEventProjection(db, { address, ...view, proposedAt: acct.proposedAt || null }, slot);
      if (!c) continue;
      changed++;
      if (!before) continue; // first sighting: no news
      const m = fx.markets.find((x) => x.eventKey === address);
      const title = m?.title ?? "Event";
      const detail =
        view.status === "PENDING"
          ? `${view.outcome} proposed by ${book.attestorSet.threshold} of ${book.attestorSet.keys.length} development attestors. Final after a ${book.attestorSet.challengeSeconds}s challenge window unless disputed.`
          : view.status === "DISPUTED"
            ? "Conflicting attestation: not final. Futures waiting on it keep waiting; at expiry they refund."
            : view.status === "FINAL"
              ? view.outcome === "VOID"
                ? "Final VOID — every condition on it is false."
                : `Final ${view.outcome}.`
              : "Open";
      await logActivity(db, null, { at: now, kind: "event", title: `${title}: ${view.status === "PENDING" ? `${view.outcome} proposed` : view.status === "DISPUTED" ? "disputed" : view.status === "FINAL" ? view.outcome! : "reopened"}`, detail, actor: view.adapter === "BALANCE" ? "keeper" : "attestor", ...(m ? { marketKey: m.key } : {}) }, `event:${address}:${view.status}:${view.outcome}:${view.finalAt}`);
    }
    if (changed) await this.app.publish(["markets", "strategies", "activity"]);
    // pool reserves → price estimates (cheap: one multi-account read)
    const reserves = await chain.poolReserves();
    await kvSet(db, "pools", reserves);
    return { eventsChanged: changed };
  }

  /** One vault: ledger, token balances, every strategy, receipts, status transitions. */
  async syncVault(owner: string): Promise<void> {
    const { chain, db } = this.app;
    const ownerKey = new PublicKey(owner);
    const vault = chain.vaultOf(ownerKey);
    const v = await chain.maybeVault(vault);
    if (!v) return;
    const slot = await chain.conn.getSlot("confirmed");
    const tokens = await chain.tokenBalances(v.balances.map((b) => b.tokenAccount));
    const tb: Record<string, bigint> = {};
    v.balances.forEach((b, i) => (tb[b.mint.toBase58()] = tokens[i]!));
    await upsertVaultProjection(db, toVaultState(vault, v, tb), slot);
    for (const { address, account } of await chain.strategiesOf(vault)) {
      const rt = toStrategyState(address, account);
      if (!rt) continue;
      await upsertStrategyProjection(db, rt, slot);
      const row = await getStrategyByAccount(db, rt.address);
      await this.syncStrategyStatus(row, rt);
      const known = (await receiptsFor(db, [rt.address])).get(rt.address)?.length ?? 0;
      if (known < rt.execNonce || (row && row.status !== CHAIN_TO_LIFECYCLE[rt.status] && rt.status !== "ACTIVE" && rt.status !== "PAUSED")) await this.syncTxEvents(rt, row);
    }
    await this.syncPolicies(owner, v.policyEpoch);
  }

  private async syncStrategyStatus(row: StrategyRow | null, rt: StrategyState): Promise<void> {
    if (!row) return;
    const target = CHAIN_TO_LIFECYCLE[rt.status];
    if (!target || row.status === target) return;
    if (row.status === "SUPERSEDED" && target === "CANCELLED") return;
    await updateStrategy(this.app.db, row.id, { status: target });
    await this.app.publish(["strategies", "portfolio"]);
  }

  /** Receipts and closes, parsed from the strategy's confirmed transactions. */
  async syncTxEvents(rt: StrategyState, row: StrategyRow | null): Promise<void> {
    const { chain, db } = this.app;
    const txs = await chain.eventsFor(new PublicKey(rt.address), { limit: 60 });
    let news = false;
    for (const t of [...txs].reverse()) {
      for (const e of t.events) news = (await this.applyEvent(e, t.signature, t.slot, rt, row)) || news;
    }
    if (news) await this.app.publish(["strategies", "portfolio", "activity"]);
  }

  /** Idempotent: a receipt is inserted once (primary key) and its activity entry has a dedupe key. */
  async applyEvent(e: VaultEvent, signature: string, slot: number, rt: StrategyState, row: StrategyRow | null): Promise<boolean> {
    const db = this.app.db;
    if (e.name === "ExecutionReceipt" && e.strategy.toBase58() === rt.address) {
      const rc = toCoreReceipt(e);
      const inserted = await insertReceipt(db, signature, slot, rc);
      if (inserted && row) {
        const label = row.doc.actions[rc.action]?.label ?? `Step ${rc.action + 1}`;
        await logActivity(db, row.owner, { at: rc.at, ...receiptActivity(this.app.fx, rc, { label, title: row.doc.title, strategyId: row.id }), tx: { id: signature, label: "Execute step", state: "CONFIRMED", signature, createdAt: rc.at, updatedAt: rc.at, simulated: false } }, `receipt:${rc.strategy}:${rc.action}:${rc.run}`);
      }
      return inserted;
    }
    if (e.name === "StrategyClosed" && e.strategy.toBase58() === rt.address && row) {
      const mode = e.mode;
      const mints = rt.plan.mints;
      const refunded = mints.map((m, i) => [m, e.refunded[i] ?? 0n] as const).filter(([, v]) => v > 0n);
      // close modes: 1 cancel, 2 expire, 3 complete (maybe-logic engine.rs)
      const kind = mode === 1 ? "cancel" : "refund";
      const title = mode === 1 ? `Cancelled “${row.doc.title}”` : mode === 2 ? `“${row.doc.title}” expired` : `“${row.doc.title}” completed`;
      const detail = refunded.length ? `Returned to available: ${refunded.map(([m, v]) => this.fmt(m, v)).join(", ")}${mode === 1 ? ". Completed trades are not reversed." : ""}` : "Nothing left to return";
      return logActivity(db, row.owner, { at: rt.closedAt ?? Math.floor(Date.now() / 1000), kind, title, detail, actor: mode === 1 ? "you" : "keeper", strategyId: row.id, amounts: refunded.map(([mint, units]) => ({ mint, units, dir: "move" as const })), tx: { id: signature, label: title, state: "CONFIRMED", signature, createdAt: 0, updatedAt: 0, simulated: false } }, `close:${rt.address}`);
    }
    return false;
  }

  async syncPolicies(owner: string, vaultEpoch?: number): Promise<void> {
    const { chain, db } = this.app;
    const epoch = vaultEpoch ?? (await chain.maybeVault(chain.vaultOf(new PublicKey(owner))))?.policyEpoch ?? 0;
    for (const p of await listPolicies(db, owner)) {
      const acct = await chain.maybePolicy(new PublicKey(p.address));
      if (!acct) continue;
      await setPolicyState(db, p.address, policyView(p.address, acct, p.label, epoch), { confirmed: true });
    }
  }

  /** Decode a confirmed transaction's vault events (used when resuming effects after a restart). */
  async txEvents(signature: string): Promise<VaultEvent[]> {
    const tx = await this.app.chain.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const { parseVaultEvents } = await import("@maybe/sdk");
    return parseVaultEvents(tx?.meta?.logMessages ?? [], this.app.chain.ids.vault);
  }

  planOf(row: StrategyRow) {
    return row.planBytes ? decodePlan(row.planBytes) : null;
  }
}

export function fmtPlain(units: bigint, decimals: number): string {
  return formatAmount(units, decimals, { minFraction: 0, maxFraction: 4 });
}

export function logIndexerError(where: string, e: unknown): void {
  log.warn({ where, err: (e as Error).message }, "indexer step failed (will retry next tick)");
}
