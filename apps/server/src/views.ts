import { PublicKey } from "@solana/web3.js";
import { cpSpotE6, emptyVault, type AssetInfo, type CapabilityPolicy, type ChainContext, type StrategyState } from "@maybe/core";
import {
  describeLookup,
  marketDetail,
  marketExposure,
  marketSummary,
  opsJobsFromReadiness,
  strategyView,
  type MarketDetail,
  type MarketSummary,
  type OpsStatus,
  type Portfolio,
  type StrategyRecord,
  type StrategyView,
} from "@maybe/api";
import type { App } from "./app.ts";
import { recentJobs, type Queryable } from "./jobs.ts";
import {
  eventViews,
  getStrategyByAccount,
  inflightIntents,
  kvGet,
  listPolicies,
  listStrategies,
  pendingTxByStrategy,
  receiptsFor,
  recentReconciliation,
  strategyProjections,
  vaultProjection,
  type StrategyRow,
} from "./store.ts";

/** Assemble API responses from projections, using the same builders as the browser simulation. */

export async function chainContext(app: App, q: Queryable = app.db): Promise<ChainContext> {
  const [now, k, events, strategies] = await Promise.all([app.now(), kvGet<{ paused: boolean }>(q, "chain"), eventViews(q), strategyProjections(q)]);
  return { now, executionPaused: k?.paused ?? false, events, strategies: Object.fromEntries(strategies) };
}

export async function records(app: App, rows: StrategyRow[]): Promise<StrategyRecord[]> {
  const accounts = rows.flatMap((r) => (r.strategyAccount ? [r.strategyAccount] : []));
  const [proj, receipts, pending] = await Promise.all([strategyProjections(app.db, { accounts }), receiptsFor(app.db, accounts), pendingTxByStrategy(app.db, rows.map((r) => r.id))]);
  return rows.map((r) => {
    const runtime: StrategyState | undefined = r.strategyAccount ? proj.get(r.strategyAccount) : undefined;
    return {
      id: r.id,
      doc: r.doc,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.sample ? { sample: true } : {}),
      ...(r.planBytes ? { bytes: r.planBytes } : {}),
      ...(r.planHash ? { hash: r.planHash } : {}),
      ...(r.signedAt ? { signedAt: r.signedAt } : {}),
      ...(runtime ? { runtime } : {}),
      receipts: r.strategyAccount ? (receipts.get(r.strategyAccount) ?? []).map(({ signature: _s, ...rc }) => rc) : [],
      ...(pending.get(r.id) ? { pendingTx: pending.get(r.id)! } : {}),
      ...(r.lastError ? { lastError: r.lastError } : {}),
    };
  });
}

export async function strategyViews(app: App, owner: string, ctx?: ChainContext): Promise<StrategyView[]> {
  const c = ctx ?? (await chainContext(app));
  return (await records(app, await listStrategies(app.db, owner))).map((r) => strategyView(r, c));
}

export async function assets(app: App): Promise<AssetInfo[]> {
  const pools = (await kvGet<Record<string, { mintA: string; mintB: string; reserveA: bigint; reserveB: bigint }>>(app.db, "pools")) ?? {};
  const k = await kvGet<{ now: number }>(app.db, "chain");
  const usdc = app.fx.assetByKey.USDC!;
  return app.fx.assets.map((a) => {
    if (a.kind === "stablecoin") return { ...a, priceAt: k?.now ?? a.priceAt, priceSource: "Assumed $1.00 peg (estimate)" };
    if (a.kind === "outcome-token") return a;
    const entry = Object.entries(pools).find(([, p]) => p.mintB === a.mint && p.mintA === usdc.mint);
    if (!entry) return a;
    const [address, p] = entry;
    return { ...a, priceE6: cpSpotE6({ address, ...p, feeBps: 30 }, a.mint, a.decimals, usdc.decimals), priceAt: k?.now ?? a.priceAt, priceSource: "Local pool spot price (read from the validator)" };
  });
}

export async function portfolio(app: App, owner: string): Promise<Portfolio> {
  const ctx = await chainContext(app);
  const vaultAddr = app.chain.vaultOf(new PublicKey(owner)).toBase58();
  const [wallet, vault, strategies, flights, priced] = await Promise.all([
    app.chain.walletBalances(new PublicKey(owner)).catch(() => ({})),
    vaultProjection(app.db, vaultAddr),
    strategyViews(app, owner, ctx),
    inflightIntents(app.db, owner),
    assets(app),
  ]);
  const estimates: Portfolio["estimates"] = {};
  for (const a of priced) if (a.priceE6 !== undefined) estimates[a.mint] = { priceE6: a.priceE6, source: a.priceSource ?? "sample", asOf: a.priceAt ?? ctx.now };
  return {
    asOf: ctx.now,
    wallet,
    vault: vault ?? emptyVault(vaultAddr, owner),
    strategies,
    pendingReservations: flights
      .filter((f) => f.kind === "authorize")
      .flatMap((f) => Object.entries((f.payload.reservations as Record<string, bigint> | undefined) ?? {}).map(([mint, units]) => ({ strategyId: f.strategyId!, mint, units, state: f.txState }))),
    pendingTransfers: flights.filter((f) => f.kind === "deposit" || f.kind === "withdraw").map((f) => ({ kind: f.kind as "deposit" | "withdraw", mint: f.payload.mint as string, units: f.payload.units as bigint, state: f.txState })),
    estimates,
  };
}

export async function markets(app: App): Promise<MarketSummary[]> {
  const [now, events] = await Promise.all([app.now(), eventViews(app.db)]);
  return app.fx.markets.map((m) => marketSummary(m, events[m.eventKey], now, app.mode));
}

export async function market(app: App, key: string, owner: string | null): Promise<MarketDetail | null> {
  const m = app.fx.markets.find((x) => x.key === key);
  if (!m) return null;
  const [now, events] = await Promise.all([app.now(), eventViews(app.db)]);
  const s = marketSummary(m, events[m.eventKey], now, app.mode);
  const mine = owner ? await listStrategies(app.db, owner) : [];
  const watched = m.balance ? app.book.watched[m.balance.watched]?.address : undefined;
  return marketDetail(m, s, { historyFrom: app.book.createdAt, exposure: marketExposure(m, mine), fx: app.fx, ...(watched ? { watched } : {}) });
}

export async function lookupFor(app: App, owner: string | null) {
  const rows = owner ? await listStrategies(app.db, owner) : [];
  return describeLookup(app.fx, { mode: app.mode, ...(owner ? { wallet: owner } : {}), strategies: rows.map((r) => ({ ...(r.strategyAccount ? { address: r.strategyAccount } : {}), title: r.title })) });
}

export async function policies(app: App, owner: string): Promise<CapabilityPolicy[]> {
  return (await listPolicies(app.db, owner)).filter((p) => p.confirmed && p.state).map((p) => p.state!);
}

const JOB_STATE: Record<string, string> = { QUEUED: "queued", RUNNING: "running", RETRY_WAIT: "retrying", SUCCEEDED: "done", DEAD: "stopped", CANCELLED: "cancelled" };

/** What a background job is doing, in the words the rest of the app uses. */
async function jobLabel(app: App, kind: string, p: Record<string, unknown>): Promise<string> {
  const market = (event: unknown) => app.fx.markets.find((m) => m.eventKey === event)?.title ?? "an event";
  if (kind === "execute" || kind === "close") {
    const row = await getStrategyByAccount(app.db, String(p.strategy));
    const title = row?.title ?? "a future";
    if (kind === "close") return `Close “${title}” (${p.mode === "EXPIRE" ? "expired" : "all steps settled"})`;
    const label = row?.doc.actions[Number(p.action)]?.label ?? `step ${Number(p.action) + 1}`;
    return `Run ${Number(p.run) + 1} of “${label}” in “${title}”`;
  }
  if (kind === "observe") return `Observe the escrow balance for “${market(p.event)}”`;
  if (kind === "finalize") return `Record that “${market(p.event)}” is final`;
  if (kind === "void-disputed") return `Void the disputed “${market(p.event)}”`;
  return kind;
}

export async function ops(app: App, owner: string | null): Promise<OpsStatus> {
  const ctx = await chainContext(app);
  const keeper = await kvGet<{ lastTickAt: number; ticks: number; at: number }>(app.db, "keeper");
  const chainHealth = await app.chain.health();
  const rec = await recentReconciliation(app.db);
  const jobs = await recentJobs(app.db);
  const mine = owner ? await records(app, await listStrategies(app.db, owner)) : [];
  const readiness = opsJobsFromReadiness(mine, ctx);
  const chainKv = await kvGet<{ slot: number; allowDevAttestors: boolean }>(app.db, "chain");
  const nowWall = Math.floor(Date.now() / 1000);
  const keeperAlive = !!keeper && nowWall - keeper.at < 15;
  return {
    mode: app.mode,
    keeper: { running: keeperAlive, lastTickAt: keeper?.lastTickAt ?? 0, ticks: keeper?.ticks ?? 0 },
    jobs: [
      ...(await Promise.all(
        jobs
          .filter((j) => j.state !== "SUCCEEDED" || nowWall - Math.floor(j.updatedAt.getTime() / 1000) < 30)
          .map(async (j) => ({ id: j.key, kind: await jobLabel(app, j.kind, j.payload), state: JOB_STATE[j.state] ?? j.state.toLowerCase(), attempts: j.attempts, runAt: Math.floor(j.runAt.getTime() / 1000), ...(j.lastError ? { lastError: j.lastError } : {}) })),
      )),
      ...readiness.filter((r) => r.state !== "queued"),
    ],
    reconciliation: rec,
    health: [
      { name: "Validator RPC", ok: chainHealth.ok, detail: chainHealth.ok ? `${app.cfg.RPC_URL} · ${chainHealth.detail}` : chainHealth.detail },
      { name: "Keeper worker", ok: keeperAlive, detail: keeper ? `last tick ${nowWall - keeper.at}s ago · ${keeper.ticks} ticks` : "not running — start it with: pnpm --filter @maybe/server worker" },
      { name: "Ledger reconciliation", ok: rec[0]?.ok ?? true, detail: rec[0]?.detail ?? "not run yet" },
      { name: "Database", ok: true, detail: "PostgreSQL (projections, intents, jobs, outbox)" },
      { name: "Emergency pause", ok: !ctx.executionPaused, detail: ctx.executionPaused ? "New steps are paused; withdrawals and refunds still work" : "Not paused" },
      { name: "Attestors", ok: true, detail: chainKv?.allowDevAttestors ? `Development set: ${app.book.attestorSet.threshold} of ${app.book.attestorSet.keys.length} localnet keys (not for production)` : "Development attestors disabled on-chain" },
    ],
  };
}
