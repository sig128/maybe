import {
  activateStrategy,
  actionReadiness,
  allActionsTerminal,
  applyOp,
  buildFixtures,
  chargePolicy,
  checkPolicyForPlan,
  checkVaultInvariants,
  closeStrategy,
  compileStrategy,
  cpSpotE6,
  deposit as ledgerDeposit,
  emptyVault,
  executeAction,
  guardTimes,
  holdingsByMint,
  newVersion,
  planHash,
  reservationByMint,
  setPaused,
  simAddress,
  templateById,
  transition,
  strategyMachine,
  withdraw as ledgerWithdraw,
  SimVenue,
  effectiveEvent,
  type AssetInfo,
  type CapabilityPolicy,
  type ChainContext,
  type CpPool,
  type DescribeLookup,
  type EventView,
  type FixtureSet,
  type Strategy,
  type StrategyLifecycleState,
  type StrategyState,
  type TxState,
  type VaultState,
} from "@maybe/core";
import { capabilityContext, fixtureWorld, newConversation, runLocalTurn, type AgentStrategySummary, type Conversation } from "@maybe/agent";
import {
  QUOTE_BUCKET_SECONDS,
  cloneRoomDoc,
  defaultEventView,
  describeLookup,
  draftStatus,
  environmentInfo,
  fmtUnits,
  marketDetail,
  marketExposure,
  marketSummary,
  opsJobsFromReadiness,
  prepareStrategy,
  receiptActivity,
  roomSlug,
  sampleRooms,
  strategyView,
  type StrategyRecord,
} from "@maybe/api";
import { safeLoad, safeRemove, safeSave } from "../serde.ts";
import type {
  ActivityItem,
  AgentRole,
  AgentSession,
  AgentStep,
  Backend,
  ChangeEvent,
  Environment,
  MarketDetail,
  MarketSummary,
  OpsStatus,
  Portfolio,
  Prepared,
  RoomRecord,
  StrategyView,
  TxRecord,
  WalletState,
} from "../types.ts";

const KEY = "maybe.sim.v2";
const CHALLENGE_SECONDS = 10 * 60;
const DAY = 86_400;

type SimStrategy = StrategyRecord;

type SimSession = AgentSession & { conv: Conversation };

interface SimState {
  v: 2;
  seededAt: number;
  offset: number;
  wallet: { connected: boolean; address: string; balances: Record<string, bigint> };
  vault: VaultState;
  strategies: Record<string, SimStrategy>;
  events: Record<string, EventView>;
  pools: Record<string, CpPool>;
  activity: ActivityItem[];
  policies: CapabilityPolicy[];
  sessions: SimSession[];
  rooms: RoomRecord[];
  failNext: boolean;
  executionPaused: boolean;
  keeper: { ticks: number; lastTickAt: number };
  inflight: {
    transfers: Array<{ id: string; kind: "deposit" | "withdraw"; mint: string; units: bigint; state: TxState }>;
    reservations: Array<{ id: string; strategyId: string; mint: string; units: bigint; state: TxState }>;
  };
  reconciliation: Array<{ at: number; scope: string; ok: boolean; detail: string }>;
  counter: number;
}

const realNow = () => Math.floor(Date.now() / 1000);

export class SimulationBackend implements Backend {
  readonly kind = "simulation" as const;
  private state: SimState;
  private fx: FixtureSet;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private quoteTimer: ReturnType<typeof setInterval> | null = null;
  private pendingSave = false;

  constructor(private readonly opts: { persist?: boolean; autoStart?: boolean } = {}) {
    const loaded = opts.persist === false ? null : safeLoad<SimState>(KEY);
    this.state = loaded && loaded.v === 2 ? loaded : this.seed();
    this.fx = buildFixtures(this.state.seededAt);
    if (opts.autoStart !== false) this.start();
  }

  // ───────────────────────────────────────── plumbing
  now(): number {
    return realNow() + this.state.offset;
  }

  private id(prefix: string): string {
    this.state.counter += 1;
    return `${prefix}_${this.state.counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  private emit(...topics: ChangeEvent["topics"]) {
    for (const l of this.listeners) l({ topics });
    if (!this.pendingSave && this.opts.persist !== false) {
      this.pendingSave = true;
      queueMicrotask(() => {
        this.pendingSave = false;
        safeSave(KEY, this.state);
      });
    }
  }

  subscribe(cb: (e: ChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start() {
    if (typeof window === "undefined") return;
    this.timer ??= setInterval(() => this.tick(), 1500);
    this.quoteTimer ??= setInterval(() => this.emit("quotes"), QUOTE_BUCKET_SECONDS * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.quoteTimer) clearInterval(this.quoteTimer);
    this.timer = this.quoteTimer = null;
  }

  private asset(mint: string): AssetInfo | undefined {
    return this.fx.assets.find((a) => a.mint === mint);
  }

  private fmt(mint: string, units: bigint): string {
    return fmtUnits(this.fx, mint, units);
  }

  private log(item: Omit<ActivityItem, "id">) {
    this.state.activity.unshift({ id: this.id("act"), ...item });
    if (this.state.activity.length > 400) this.state.activity.length = 400;
  }

  private ctx(now = this.now()): ChainContext {
    const strategies: Record<string, StrategyState> = {};
    for (const s of Object.values(this.state.strategies)) if (s.runtime) strategies[s.runtime.address] = s.runtime;
    return { now, executionPaused: this.state.executionPaused, events: this.state.events, strategies };
  }

  private venue(): SimVenue {
    return new SimVenue({
      cp: this.state.pools,
      outcome: Object.fromEntries(this.fx.outcomeMarkets.map((o) => [o.address, o])),
      eventOutcome: (e) => {
        const eff = effectiveEvent(this.state.events[e], this.now());
        return eff.final ? (eff.outcome ?? null) : null;
      },
    });
  }

  // ───────────────────────────────────────── seed (clearly labelled sample data)
  private seed(): SimState {
    const seededAt = Math.floor(realNow() / 3600) * 3600;
    const fx = buildFixtures(seededAt);
    const usdc = fx.assetByKey.USDC!.mint;
    const maybe = fx.assetByKey.MAYBE!.mint;
    const owner = simAddress("wallet:you");
    let vault = emptyVault(simAddress("vault:you:0"), owner);
    const st: SimState = {
      v: 2,
      seededAt,
      offset: 0,
      wallet: { connected: true, address: owner, balances: { [usdc]: 2_500_000_000n, [maybe]: 40_000_000_000n } },
      vault,
      strategies: {},
      events: {},
      pools: Object.fromEntries(fx.pools.map((p) => [p.address, { ...p }])),
      activity: [],
      policies: [],
      sessions: [],
      rooms: [],
      failNext: false,
      executionPaused: false,
      keeper: { ticks: 0, lastTickAt: seededAt },
      inflight: { transfers: [], reservations: [] },
      reconciliation: [],
      counter: 0,
    };
    for (const m of fx.markets) st.events[m.eventKey] = defaultEventView(m, seededAt);
    vault = ledgerDeposit(vault, usdc, 900_000_000n);
    st.activity.push({ id: "seed-dep", at: seededAt - 3 * DAY, kind: "deposit", title: "Deposited 900 USDC", actor: "you", amounts: [{ mint: usdc, units: 900_000_000n, dir: "in" }], sample: true });
    let n = 0;
    const env = { now: seededAt - 6 * DAY, fixtures: fx, id: () => `sample_${n++}`, nonce: () => String(900_000 + n++), recipient: owner };
    // sample 1: an exhibition-match future that was refunded when the match was voided
    const exhibition = fx.markets.find((m) => m.key === "exhibition-match")!;
    let d1 = templateById("delay-after-settlement")!.build(env);
    d1 = applyOp(d1, { op: "replaceEvent", ref: "A", event: { ...d1.events[0]!, eventKey: exhibition.eventKey, venueMarketId: exhibition.venueMarketId, ruleHash: exhibition.ruleHash, title: exhibition.title } });
    d1 = { ...d1, title: "Exhibition match → Moss", thesis: "Sample: a future whose event was voided. Nothing was bought; the allocation came back." };
    const c1 = compileStrategy(d1);
    const a1 = activateStrategy(vault, c1.bytes, { now: seededAt - 6 * DAY, address: simAddress("strategy:sample1"), owner });
    vault = a1.vault;
    const close1 = closeStrategy(vault, a1.strategy, "COMPLETE", { now: seededAt - 2 * DAY + 60, executionPaused: false, events: st.events, strategies: {} });
    let r1 = a1.strategy;
    if (close1.ok) {
      vault = close1.vault;
      r1 = close1.strategy;
    }
    st.strategies[d1.id] = { id: d1.id, doc: d1, status: "COMPLETED", createdAt: seededAt - 6 * DAY, updatedAt: seededAt - 2 * DAY, sample: true, bytes: c1.bytes, hash: c1.hash, signedAt: seededAt - 6 * DAY, runtime: r1, receipts: [] };
    st.activity.push(
      { id: "seed-a1", at: seededAt - 6 * DAY, kind: "activate", title: "Authorized “Exhibition match → Moss”", detail: "Reserved 80 USDC", actor: "you", strategyId: d1.id, amounts: [{ mint: usdc, units: 80_000_000n, dir: "move" }], sample: true },
      { id: "seed-e1", at: seededAt - 2 * DAY, kind: "event", title: "Exhibition match voided", detail: "Final VOID — every condition on it is false", actor: "attestor", marketKey: exhibition.key, sample: true },
      { id: "seed-r1", at: seededAt - 2 * DAY + 60, kind: "refund", title: "80 USDC returned to available", detail: "Nothing executed; the future completed with a full refund", actor: "keeper", strategyId: d1.id, amounts: [{ mint: usdc, units: 80_000_000n, dir: "move" }], sample: true },
    );
    // sample 2: an active branching future on the treasury vote
    env.now = seededAt - 2 * DAY;
    const d2 = { ...templateById("yes-a-no-b")!.build(env), thesis: "Sample: one reservation, two exclusive portfolios." };
    const c2 = compileStrategy(d2);
    const a2 = activateStrategy(vault, c2.bytes, { now: seededAt - 2 * DAY, address: simAddress("strategy:sample2"), owner });
    vault = a2.vault;
    st.strategies[d2.id] = { id: d2.id, doc: d2, status: "ACTIVE", createdAt: seededAt - 2 * DAY, updatedAt: seededAt - 2 * DAY, sample: true, bytes: c2.bytes, hash: c2.hash, signedAt: seededAt - 2 * DAY, runtime: a2.strategy, receipts: [] };
    st.activity.push({ id: "seed-a2", at: seededAt - 2 * DAY, kind: "activate", title: "Authorized “Treasury vote: two portfolios”", detail: "Reserved 300 USDC", actor: "you", strategyId: d2.id, amounts: [{ mint: usdc, units: 300_000_000n, dir: "move" }], sample: true });
    // sample 3: the flagship as an unfunded draft
    env.now = seededAt;
    const d3 = templateById("flagship")!.build(env);
    st.strategies[d3.id] = { id: d3.id, doc: d3, status: "READY", createdAt: seededAt - 3600, updatedAt: seededAt - 3600, sample: true, receipts: [] };
    st.vault = vault;
    st.activity.sort((a, b) => b.at - a.at);
    st.rooms = sampleRooms(fx, seededAt);
    return st;
  }

  // ───────────────────────────────────────── keeper (permissionless crank, like the worker)
  tick() {
    const now = this.now();
    let changed = false;
    this.state.keeper.ticks += 1;
    this.state.keeper.lastTickAt = now;
    const ctx = this.ctx(now);
    for (const s of Object.values(this.state.strategies)) {
      if (!s.runtime || (s.status !== "ACTIVE" && s.status !== "PAUSED")) continue;
      if (s.status === "ACTIVE" && !this.state.executionPaused) {
        for (let guard = 0; guard < 20; guard++) {
          const times = guardTimes(s.runtime, ctx);
          const i = s.runtime.plan.actions.findIndex((_, k) => actionReadiness(s.runtime!, k, ctx, times).state === "executable");
          if (i < 0) break;
          const r = actionReadiness(s.runtime, i, ctx, times);
          if (r.state !== "executable") break;
          const res = executeAction(this.state.vault, s.runtime, i, ctx, this.venue(), { expectedPlanHash: s.runtime.planHash, expectedRun: r.run });
          if (!res.ok) {
            s.lastError = `Step ${i + 1}: ${res.code.replaceAll("_", " ").toLowerCase()}${res.detail ? ` (${res.detail})` : ""}`;
            this.log({ at: now, kind: "failure", title: `Step ${i + 1} of “${s.doc.title}” did not execute`, detail: `${s.lastError}. Nothing was spent; it will be retried.`, actor: "keeper", strategyId: s.id });
            changed = true;
            break;
          }
          this.state.vault = res.vault;
          s.runtime = res.strategy;
          s.receipts.push(res.receipt);
          s.updatedAt = now;
          s.lastError = undefined;
          const label = s.doc.actions[i]?.label ?? `Step ${i + 1}`;
          const sig = this.fakeSignature();
          this.log({ at: now, ...receiptActivity(this.fx, res.receipt, { label, title: s.doc.title, strategyId: s.id }), tx: { id: this.id("tx"), label: "Execute step", state: "FINALIZED", signature: sig, createdAt: now, updatedAt: now, simulated: true } });
          changed = true;
        }
      }
      const c2 = this.ctx(now);
      const mode = now >= s.runtime.plan.expiresAt ? "EXPIRE" : s.status === "ACTIVE" && allActionsTerminal(s.runtime, c2) ? "COMPLETE" : null;
      if (mode) {
        const closed = closeStrategy(this.state.vault, s.runtime, mode, c2);
        if (closed.ok) {
          this.state.vault = closed.vault;
          s.runtime = closed.strategy;
          s.status = mode === "EXPIRE" ? "EXPIRED" : "COMPLETED";
          s.updatedAt = now;
          const refunded = Object.entries(closed.refunded).filter(([, v]) => v > 0n);
          this.log({
            at: now,
            kind: "refund",
            title: mode === "EXPIRE" ? `“${s.doc.title}” expired` : `“${s.doc.title}” completed`,
            detail: refunded.length ? `Returned to available: ${refunded.map(([m, v]) => this.fmt(m, v)).join(", ")}` : "Nothing left to return",
            actor: "keeper",
            strategyId: s.id,
            amounts: refunded.map(([mint, units]) => ({ mint, units, dir: "move" as const })),
          });
          changed = true;
        }
      }
    }
    if (this.state.keeper.ticks % 4 === 0 || changed) this.reconcile(now);
    this.emit(...(changed ? (["portfolio", "strategies", "activity", "ops"] as const) : (["ops", "clock"] as const)));
  }

  private reconcile(now: number) {
    const active = Object.values(this.state.strategies)
      .filter((s) => s.runtime && (s.runtime.status === "ACTIVE" || s.runtime.status === "PAUSED"))
      .map((s) => s.runtime!);
    const v = checkVaultInvariants(this.state.vault, holdingsByMint(active));
    this.state.reconciliation.unshift({ at: now, scope: "vault ledger vs strategy holdings", ok: v.length === 0, detail: v.length ? v.map((x) => x.message).join("; ") : "token balances = available + reserved; reserved = Σ holdings" });
    if (this.state.reconciliation.length > 30) this.state.reconciliation.length = 30;
  }

  private fakeSignature(): string {
    return simAddress(`sig:${this.state.counter++}:${Math.random()}`) + simAddress(`sig2:${this.state.counter}`).slice(0, 44);
  }

  /** Simulated transaction lifecycle: BUILT → SIGNED → SUBMITTED → PROCESSED → CONFIRMED → FINALIZED. Effects apply at CONFIRMED. */
  private runTx(label: string, effect: string, onConfirm: () => void, onFail: (err: string) => void, onState?: (tx: TxRecord) => void): TxRecord {
    const now = this.now();
    const tx: TxRecord = { id: this.id("tx"), label, state: "SIGNED", signature: this.fakeSignature(), createdAt: now, updatedAt: now, simulated: true, effect };
    const fail = this.state.failNext;
    this.state.failNext = false;
    const steps: Array<[number, TxState]> = fail
      ? [
          [350, "SUBMITTED"],
          [1600, "EXPIRED"],
        ]
      : [
          [350, "SUBMITTED"],
          [800, "PROCESSED"],
          [1400, "CONFIRMED"],
          [2800, "FINALIZED"],
        ];
    onState?.(tx);
    for (const [delay, state] of steps) {
      setTimeout(() => {
        tx.state = state;
        tx.updatedAt = this.now();
        if (state === "CONFIRMED") onConfirm();
        if (state === "EXPIRED") {
          tx.error = "Simulated failure: the blockhash expired before the transaction landed. Nothing changed; you can try again.";
          onFail(tx.error);
        }
        onState?.(tx);
        this.emit("portfolio", "strategies", "activity", "wallet", "ops");
      }, delay);
    }
    return tx;
  }

  // ───────────────────────────────────────── environment & assets
  async environment(): Promise<Environment> {
    return environmentInfo("simulation");
  }

  async fixtures(): Promise<FixtureSet> {
    return this.fx;
  }

  async assets(): Promise<AssetInfo[]> {
    return this.fx.assets.map((a) => {
      if (a.kind === "stablecoin") return { ...a, priceAt: this.now(), priceSource: "Assumed $1.00 peg (estimate)" };
      if (a.kind === "outcome-token") return a;
      const pool = this.fx.pools.find((p) => p.mintB === a.mint);
      const live = pool ? this.state.pools[pool.address] : undefined;
      const usdc = this.fx.assetByKey.USDC!;
      return live ? { ...a, priceE6: cpSpotE6(live, a.mint, a.decimals, usdc.decimals), priceAt: this.now(), priceSource: "Simulated pool spot price" } : a;
    });
  }

  // ───────────────────────────────────────── wallet & money
  async wallet(): Promise<WalletState> {
    const w = this.state.wallet;
    return { status: w.connected ? "connected" : "disconnected", ...(w.connected ? { address: w.address } : {}), label: "Simulation wallet", kind: "simulated", balances: w.connected ? { ...w.balances } : {} };
  }

  async connectWallet(): Promise<WalletState> {
    this.state.wallet.connected = true;
    this.emit("wallet", "portfolio");
    return this.wallet();
  }

  async disconnectWallet(): Promise<void> {
    this.state.wallet.connected = false;
    this.emit("wallet", "portfolio");
  }

  async portfolio(): Promise<Portfolio> {
    const estimates: Portfolio["estimates"] = {};
    for (const a of await this.assets()) if (a.priceE6 !== undefined) estimates[a.mint] = { priceE6: a.priceE6, source: a.priceSource ?? "sample", asOf: a.priceAt ?? this.now() };
    return {
      asOf: this.now(),
      wallet: this.state.wallet.connected ? { ...this.state.wallet.balances } : {},
      vault: structuredClone(this.state.vault),
      strategies: await this.strategies(),
      pendingReservations: this.state.inflight.reservations.filter((r) => r.state !== "CONFIRMED" && r.state !== "FINALIZED" && r.state !== "EXPIRED" && r.state !== "FAILED"),
      pendingTransfers: this.state.inflight.transfers.filter((t) => t.state === "SIGNED" || t.state === "SUBMITTED" || t.state === "PROCESSED"),
      estimates,
    };
  }

  private requireWallet() {
    if (!this.state.wallet.connected) throw new Error("Connect the simulation wallet first.");
  }

  async deposit(mint: string, units: bigint): Promise<TxRecord> {
    this.requireWallet();
    if (units <= 0n) throw new Error("Enter an amount greater than zero.");
    const have = this.state.wallet.balances[mint] ?? 0n;
    if (units > have) throw new Error(`Your wallet holds ${this.fmt(mint, have)}.`);
    const flight = { id: this.id("in"), kind: "deposit" as const, mint, units, state: "SIGNED" as TxState };
    this.state.inflight.transfers.push(flight);
    const tx = this.runTx(
      `Deposit ${this.fmt(mint, units)}`,
      `${this.fmt(mint, units)} moves from your wallet to available in your vault`,
      () => {
        this.state.wallet.balances[mint] = (this.state.wallet.balances[mint] ?? 0n) - units;
        this.state.vault = ledgerDeposit(this.state.vault, mint, units);
        this.log({ at: this.now(), kind: "deposit", title: `Deposited ${this.fmt(mint, units)}`, actor: "you", amounts: [{ mint, units, dir: "in" }], tx });
      },
      (err) => this.log({ at: this.now(), kind: "failure", title: `Deposit of ${this.fmt(mint, units)} did not land`, detail: err, actor: "system", tx }),
      (t) => (flight.state = t.state),
    );
    this.emit("portfolio", "activity");
    return tx;
  }

  async withdraw(mint: string, units: bigint): Promise<TxRecord> {
    this.requireWallet();
    const avail = this.state.vault.balances[mint]?.available ?? 0n;
    if (units <= 0n) throw new Error("Enter an amount greater than zero.");
    if (units > avail) throw new Error(`Only ${this.fmt(mint, avail)} is available. Reserved funds can't be withdrawn until their future releases them.`);
    const flight = { id: this.id("out"), kind: "withdraw" as const, mint, units, state: "SIGNED" as TxState };
    this.state.inflight.transfers.push(flight);
    const tx = this.runTx(
      `Withdraw ${this.fmt(mint, units)}`,
      `${this.fmt(mint, units)} moves from available to your wallet`,
      () => {
        try {
          this.state.vault = ledgerWithdraw(this.state.vault, mint, units);
          this.state.wallet.balances[mint] = (this.state.wallet.balances[mint] ?? 0n) + units;
          this.log({ at: this.now(), kind: "withdraw", title: `Withdrew ${this.fmt(mint, units)}`, actor: "you", amounts: [{ mint, units, dir: "out" }], tx });
        } catch (e) {
          this.log({ at: this.now(), kind: "failure", title: "Withdrawal rejected", detail: (e as Error).message, actor: "system", tx });
        }
      },
      (err) => this.log({ at: this.now(), kind: "failure", title: `Withdrawal of ${this.fmt(mint, units)} did not land`, detail: err, actor: "system", tx }),
      (t) => (flight.state = t.state),
    );
    this.emit("portfolio", "activity");
    return tx;
  }

  // ───────────────────────────────────────── markets
  private marketSummary(m: FixtureSet["markets"][number]): MarketSummary {
    return marketSummary(m, this.state.events[m.eventKey], this.now(), "simulation");
  }

  async markets(): Promise<MarketSummary[]> {
    return this.fx.markets.map((m) => this.marketSummary(m));
  }

  async market(key: string): Promise<MarketDetail | null> {
    const m = this.fx.markets.find((x) => x.key === key);
    if (!m) return null;
    const exposure = marketExposure(m, Object.values(this.state.strategies));
    return marketDetail(m, this.marketSummary(m), { historyFrom: this.state.seededAt, exposure, fx: this.fx, ...(m.balance ? { watched: simAddress(`watched:${m.balance.watched}`) } : {}) });
  }

  // ───────────────────────────────────────── strategies
  private view(s: SimStrategy): StrategyView {
    return strategyView(s, this.ctx());
  }

  async strategies(): Promise<StrategyView[]> {
    return Object.values(this.state.strategies)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => this.view(s));
  }

  async strategy(id: string): Promise<StrategyView | null> {
    const s = this.state.strategies[id];
    return s ? this.view(s) : null;
  }

  private validationCtx() {
    const available: Record<string, bigint> = {};
    for (const [m, b] of Object.entries(this.state.vault.balances)) available[m] = b.available;
    return capabilityContext(this.fx, this.now(), available);
  }

  async saveDraft(doc: Strategy): Promise<StrategyView> {
    const now = this.now();
    const existing = this.state.strategies[doc.id];
    if (existing && existing.status !== "DRAFT" && existing.status !== "INVALID" && existing.status !== "READY" && existing.status !== "ACTIVATION_FAILED") {
      throw new Error("This future is already authorized. Editing creates a new version that needs a new signature.");
    }
    const status: StrategyLifecycleState = draftStatus(doc, this.fx, now);
    this.state.strategies[doc.id] = { id: doc.id, doc, status, createdAt: existing?.createdAt ?? now, updatedAt: now, receipts: [], ...(existing?.sample ? { sample: true } : {}) };
    this.emit("strategies");
    return this.view(this.state.strategies[doc.id]!);
  }

  async deleteDraft(id: string): Promise<void> {
    const s = this.state.strategies[id];
    if (!s) return;
    if (s.runtime) throw new Error("Authorized futures can't be deleted; cancel them instead.");
    delete this.state.strategies[id];
    this.emit("strategies");
  }

  private lookup(): DescribeLookup {
    return describeLookup(this.fx, { mode: "simulation", wallet: this.state.wallet.address, strategies: Object.values(this.state.strategies).map((s) => ({ ...(s.runtime ? { address: s.runtime.address } : {}), title: s.doc.title })) });
  }

  async prepare(doc: Strategy): Promise<Prepared> {
    const available: Record<string, bigint> = {};
    for (const [m, b] of Object.entries(this.state.vault.balances)) available[m] = b.available;
    return prepareStrategy(doc, { fx: this.fx, now: this.now(), available, lookup: this.lookup(), environment: "Simulation — no chain, no real funds" });
  }

  async authorize(id: string, expectedHash: string, policy?: CapabilityPolicy): Promise<TxRecord[]> {
    this.requireWallet();
    const s = this.state.strategies[id];
    if (!s) throw new Error("Unknown future.");
    if (s.runtime) throw new Error("Already authorized.");
    const prep = await this.prepare(s.doc);
    if (!prep.ok || !prep.bytes || !prep.hash) throw new Error(prep.issues.find((i) => i.severity === "error")?.message ?? "This future has problems to fix first.");
    if (prep.hash !== expectedHash) throw new Error("The plan changed since you reviewed it. Review it again before signing.");
    if (policy) {
      const check = checkPolicyForPlan(policy, prep.plan!, this.state.vault, this.now());
      if (!check.ok) throw new Error(`Outside the policy: ${check.violations.join("; ")}`);
    }
    s.status = transition(strategyMachine, transition(strategyMachine, s.status === "ACTIVATION_FAILED" ? "READY" : s.status, "REQUEST_SIGNATURE"), "SIGNED");
    s.bytes = prep.bytes;
    s.hash = prep.hash;
    s.signedAt = this.now();
    const perMint = reservationByMint(prep.plan!);
    const flights = Object.entries(perMint).map(([mint, units]) => ({ id: this.id("rsv"), strategyId: id, mint, units, state: "SIGNED" as TxState }));
    this.state.inflight.reservations.push(...flights);
    const supersedes = s.doc.meta?.supersedes?.split("@")[0];
    const old = supersedes ? Object.values(this.state.strategies).find((x) => x.doc.id === supersedes && x.id !== id && (x.status === "ACTIVE" || x.status === "PAUSED")) : undefined;
    const chunks = Math.ceil(prep.bytes.length / 800);
    const upload: TxRecord = { id: this.id("tx"), label: `Upload plan (${chunks} part${chunks > 1 ? "s" : ""}, ${prep.bytes.length} bytes)`, state: "FINALIZED", signature: this.fakeSignature(), createdAt: this.now(), updatedAt: this.now(), simulated: true };
    s.status = "ACTIVATING";
    const tx = this.runTx(
      old ? "Replace previous version and reserve" : "Activate and reserve",
      `Reserves ${Object.entries(perMint).map(([m, v]) => this.fmt(m, v)).join(" + ")} from available`,
      () => {
        try {
          let vault = this.state.vault;
          if (old?.runtime) {
            const closed = closeStrategy(vault, old.runtime, "CANCEL", this.ctx(), this.state.vault.owner);
            if (closed.ok) {
              vault = closed.vault;
              old.runtime = closed.strategy;
              old.status = "SUPERSEDED";
              old.updatedAt = this.now();
            }
          }
          const act = activateStrategy(vault, prep.bytes!, { now: this.now(), address: simAddress(`strategy:${id}:${s.hash}`), owner: this.state.vault.owner, createdBy: policy ? { kind: "policy", policy: policy.address } : { kind: "owner" } });
          this.state.vault = act.vault;
          s.runtime = act.strategy;
          s.status = "ACTIVE";
          s.updatedAt = this.now();
          if (policy) {
            const idx = this.state.policies.findIndex((p) => p.address === policy.address);
            if (idx >= 0) this.state.policies[idx] = chargePolicy(this.state.policies[idx]!, prep.plan!);
          }
          this.log({ at: this.now(), kind: "activate", title: `Authorized “${s.doc.title}”`, detail: `${policy ? `Funded by agent session under “${policy.label}”. ` : ""}Reserved ${Object.entries(perMint).map(([m, v]) => this.fmt(m, v)).join(" + ")}. Plan ${s.hash!.slice(0, 12)}…`, actor: policy ? "agent" : "you", strategyId: id, amounts: Object.entries(perMint).map(([mint, units]) => ({ mint, units, dir: "move" as const })), tx });
        } catch (e) {
          s.status = "ACTIVATION_FAILED";
          s.lastError = (e as Error).message;
          this.log({ at: this.now(), kind: "failure", title: `Activation of “${s.doc.title}” was rejected`, detail: s.lastError, actor: "system", strategyId: id, tx });
        }
      },
      (err) => {
        s.status = "ACTIVATION_FAILED";
        s.lastError = err;
        this.log({ at: this.now(), kind: "failure", title: `Authorization of “${s.doc.title}” did not land`, detail: `${err} No funds were reserved.`, actor: "system", strategyId: id, tx });
      },
      (t) => {
        for (const f of flights) f.state = t.state;
        s.pendingTx = [upload, { ...t }];
        if (t.state === "FINALIZED" || t.state === "EXPIRED" || t.state === "FAILED") setTimeout(() => (s.pendingTx = undefined), 4000);
      },
    );
    this.emit("strategies", "portfolio");
    return [upload, tx];
  }

  async fundWithPolicy(id: string, policyAddress: string): Promise<TxRecord[]> {
    const p = this.state.policies.find((x) => x.address === policyAddress);
    if (!p) throw new Error("Unknown policy.");
    const prep = await this.prepare(this.state.strategies[id]!.doc);
    return this.authorize(id, prep.hash!, p);
  }

  async pause(id: string, paused: boolean): Promise<TxRecord> {
    const s = this.state.strategies[id];
    if (!s?.runtime) throw new Error("Not active.");
    return this.runTx(
      paused ? "Pause new steps" : "Resume",
      paused ? "Stops new steps; funds stay reserved" : "Allows steps to execute again",
      () => {
        s.runtime = setPaused(s.runtime!, paused, this.state.vault.owner);
        s.status = paused ? "PAUSED" : "ACTIVE";
        s.updatedAt = this.now();
        this.log({ at: this.now(), kind: "pause", title: `${paused ? "Paused" : "Resumed"} “${s.doc.title}”`, actor: "you", strategyId: id });
      },
      (err) => this.log({ at: this.now(), kind: "failure", title: "Pause did not land", detail: err, actor: "system", strategyId: id }),
    );
  }

  async cancel(id: string): Promise<TxRecord> {
    const s = this.state.strategies[id];
    if (!s?.runtime) throw new Error("Not active.");
    return this.runTx(
      "Cancel and release",
      "Returns everything unspent to available",
      () => {
        const closed = closeStrategy(this.state.vault, s.runtime!, "CANCEL", this.ctx(), this.state.vault.owner);
        if (!closed.ok) {
          this.log({ at: this.now(), kind: "failure", title: "Cancel rejected", detail: closed.code === "CANCEL_LOCKED" ? "This plan locks cancellation until expiry." : closed.code, actor: "system", strategyId: id });
          return;
        }
        this.state.vault = closed.vault;
        s.runtime = closed.strategy;
        s.status = "CANCELLED";
        s.updatedAt = this.now();
        const refunded = Object.entries(closed.refunded).filter(([, v]) => v > 0n);
        this.log({ at: this.now(), kind: "cancel", title: `Cancelled “${s.doc.title}”`, detail: refunded.length ? `Returned to available: ${refunded.map(([m, v]) => this.fmt(m, v)).join(", ")}. Completed trades are not reversed.` : "Nothing was left to return.", actor: "you", strategyId: id, amounts: refunded.map(([mint, units]) => ({ mint, units, dir: "move" as const })) });
      },
      (err) => this.log({ at: this.now(), kind: "failure", title: "Cancel did not land", detail: err, actor: "system", strategyId: id }),
    );
  }

  /** Start a new version of an authorized future (edits never change the signed one). */
  newVersionOf(id: string): StrategyView {
    const s = this.state.strategies[id]!;
    const doc = newVersion({ ...s.doc, id: this.id("fut") }, String(Math.floor(Math.random() * 2 ** 40)));
    const d = { ...doc, meta: { ...doc.meta, supersedes: `${s.doc.id}@${s.doc.version}` } };
    this.state.strategies[d.id] = { id: d.id, doc: d, status: "DRAFT", createdAt: this.now(), updatedAt: this.now(), receipts: [] };
    this.emit("strategies");
    return this.view(this.state.strategies[d.id]!);
  }

  async activity(): Promise<ActivityItem[]> {
    return this.state.activity.map((a) => ({ ...a }));
  }

  // ───────────────────────────────────────── agents
  private world() {
    return fixtureWorld(() => this.now(), {
      fixtures: this.fx,
      strategies: (): AgentStrategySummary[] =>
        Object.values(this.state.strategies).map((s) => {
          const v = this.view(s);
          const waiting = v.readiness
            .map((r, i) => (r.state === "waiting" ? `${s.doc.actions[i]?.label ?? `step ${i + 1}`}` : r.state === "scheduled" ? `${s.doc.actions[i]?.label ?? `step ${i + 1}`} (scheduled)` : null))
            .filter((x): x is string => !!x);
          const reserved = s.runtime ? s.runtime.holdings.flatMap((row) => row.map((u, mi) => (u > 0n ? this.fmt(s.runtime!.plan.mints[mi]!, u) : null))).filter(Boolean).join(" + ") : "";
          return { id: s.id, title: s.doc.title, status: s.status, reserved, waiting, ...(v.nextWake && v.nextWake !== Infinity ? { nextAt: v.nextWake } : {}), issues: s.lastError ? [s.lastError] : [] };
        }),
      policies: () => this.state.policies.filter((p) => !p.revoked && p.epoch === this.state.vault.policyEpoch),
      epoch: () => this.state.vault.policyEpoch,
      available: () => Object.fromEntries(Object.entries(this.state.vault.balances).map(([m, b]) => [m, b.available])),
    });
  }

  async agentSessions(): Promise<AgentSession[]> {
    return this.state.sessions.map(({ conv: _c, ...rest }) => rest);
  }

  async sendAgentMessage(sessionId: string | null, role: AgentRole, text: string): Promise<AgentSession> {
    let session = sessionId ? this.state.sessions.find((s) => s.id === sessionId) : undefined;
    if (!session) {
      session = { id: this.id("ses"), role, title: text.slice(0, 60), createdAt: this.now(), steps: [], provider: "Local assistant (deterministic, not an AI model)", costUsd: 0, conv: newConversation(role) };
      this.state.sessions.unshift(session);
    }
    const now = this.now();
    session.steps.push({ id: this.id("st"), at: now, kind: "message", role: "user", text: text.replace(/(map|act|rem):[^\s]+/g, (m) => m) });
    const result = runLocalTurn(this.world(), session.conv, text, { draftId: () => this.id("fut"), nonce: () => String(Math.floor(Math.random() * 2 ** 40)) });
    for (const st of result.steps) {
      session.steps.push({
        id: this.id("st"),
        at: this.now(),
        kind: st.kind,
        role: "agent",
        agent: role,
        text: st.text,
        ...(st.detail ? { detail: st.detail } : {}),
        ...(st.data !== undefined || st.options ? { data: { ...(typeof st.data === "object" && st.data ? st.data : st.data !== undefined ? { value: st.data } : {}), ...(st.options ? { options: st.options } : {}) } } : {}),
        ...(st.untrusted ? { untrusted: true } : {}),
      } satisfies AgentStep);
    }
    if (result.draft) {
      const view = await this.saveDraft(result.draft);
      session.draftId = view.id;
      this.log({ at: this.now(), kind: "agent", title: `Strategy Builder drafted “${result.draft.title}”`, detail: "Unfunded draft — review and sign it yourself.", actor: "agent", strategyId: view.id });
    }
    this.emit("agents", "strategies", "activity");
    const { conv: _c, ...rest } = session;
    return rest;
  }

  async policies(): Promise<CapabilityPolicy[]> {
    return this.state.policies.map((p) => ({ ...p, revoked: p.revoked || p.epoch !== this.state.vault.policyEpoch }));
  }

  async createPolicy(p: Omit<CapabilityPolicy, "address" | "vault" | "owner" | "epoch" | "spent" | "revoked" | "sessionKey">): Promise<CapabilityPolicy> {
    const policy: CapabilityPolicy = { ...p, address: simAddress(`policy:${this.state.counter++}`), vault: this.state.vault.address, owner: this.state.vault.owner, sessionKey: simAddress(`session:${this.state.counter++}`), epoch: this.state.vault.policyEpoch, spent: {}, revoked: false };
    this.state.policies.unshift(policy);
    this.log({ at: this.now(), kind: "policy", title: `Granted “${policy.label}”`, detail: "Agent session key may create and fund futures within these limits until it expires or you revoke it.", actor: "you" });
    this.emit("agents", "activity");
    return policy;
  }

  async revokePolicy(address: string): Promise<void> {
    const p = this.state.policies.find((x) => x.address === address);
    if (p) {
      p.revoked = true;
      this.log({ at: this.now(), kind: "policy", title: `Revoked “${p.label}”`, actor: "you" });
      this.emit("agents", "activity");
    }
  }

  async killSwitch(): Promise<void> {
    this.state.vault = { ...this.state.vault, policyEpoch: this.state.vault.policyEpoch + 1 };
    this.log({ at: this.now(), kind: "policy", title: "Kill switch: all agent authority revoked", detail: "Every policy for this vault is void. Withdrawals and refunds are unaffected.", actor: "you" });
    this.emit("agents", "activity", "portfolio");
  }

  // ───────────────────────────────────────── rooms
  async rooms(): Promise<RoomRecord[]> {
    return this.state.rooms;
  }

  async room(slug: string): Promise<RoomRecord | null> {
    return this.state.rooms.find((r) => r.slug === slug) ?? null;
  }

  async publishRoom(strategyId: string, thesis: string, risk: string[]): Promise<RoomRecord> {
    const s = this.state.strategies[strategyId];
    if (!s) throw new Error("Unknown future.");
    const doc: Strategy = { ...structuredClone(s.doc), layout: undefined };
    const bytes = compileStrategy(doc).bytes;
    const existing = this.state.rooms.find((r) => r.versions.some((v) => v.doc.id === doc.id) && !r.sample);
    const version = { version: (existing?.versions.length ?? 0) + 1, publishedAt: this.now(), doc, hash: planHash(bytes), thesis, risk };
    if (existing) {
      existing.versions.push(version);
      this.log({ at: this.now(), kind: "room", title: `Published version ${version.version} of “${existing.title}”`, detail: "Existing copies keep the version they cloned.", actor: "you" });
      this.emit("rooms", "activity");
      return existing;
    }
    const slug = roomSlug(doc.title, this.state.counter++);
    const room: RoomRecord = { id: this.id("room"), slug, title: doc.title, author: "you", createdAt: this.now(), sample: false, versions: [version], record: { kind: s.receipts.length ? "live" : "none", note: s.receipts.length ? "Live results from your own funded copy in this simulation." : "No track record yet.", outcomes: [] }, copies: 0 };
    this.state.rooms.unshift(room);
    this.log({ at: this.now(), kind: "room", title: `Published “${room.title}”`, detail: "Followers get the rules, never your holdings or your spending authority.", actor: "you" });
    this.emit("rooms", "activity");
    return room;
  }

  async cloneRoom(slug: string, version: number): Promise<StrategyView> {
    const r = this.state.rooms.find((x) => x.slug === slug);
    const v = r?.versions.find((x) => x.version === version);
    if (!r || !v) throw new Error("Unknown room version.");
    const id = this.id("fut");
    const doc: Strategy = cloneRoomDoc(r, version, { id, nonce: String(Math.floor(Math.random() * 2 ** 40)), now: this.now() });
    r.copies += 1;
    const view = await this.saveDraft(doc);
    this.log({ at: this.now(), kind: "room", title: `Copied “${r.title}” v${v.version} into your futures`, detail: "Independent draft in your own vault. It needs your own review and signature.", actor: "you", strategyId: id });
    this.emit("rooms", "activity");
    return view;
  }

  // ───────────────────────────────────────── ops
  async ops(): Promise<OpsStatus> {
    const now = this.now();
    const jobs = opsJobsFromReadiness(Object.values(this.state.strategies), this.ctx(now));
    const lastRec = this.state.reconciliation[0];
    return {
      mode: "simulation",
      keeper: { running: this.timer !== null, lastTickAt: this.state.keeper.lastTickAt, ticks: this.state.keeper.ticks },
      jobs,
      reconciliation: this.state.reconciliation,
      health: [
        { name: "Strategy engine", ok: true, detail: "@maybe/core loaded in the browser" },
        { name: "Ledger reconciliation", ok: lastRec?.ok ?? true, detail: lastRec?.detail ?? "not run yet" },
        { name: "Persistence", ok: typeof localStorage !== "undefined", detail: "localStorage (this browser only)" },
        { name: "Emergency pause", ok: !this.state.executionPaused, detail: this.state.executionPaused ? "New steps are paused; withdrawals and refunds still work" : "Not paused" },
        { name: "Clock", ok: true, detail: this.state.offset ? `Simulated time is ${Math.round(this.state.offset / 3600)}h ahead of real time` : "Real time" },
      ],
    };
  }

  // ───────────────────────────────────────── simulation controls
  sim = {
    resolveEvent: async (eventKey: string, outcome: "YES" | "NO" | "VOID") => {
      const e = this.state.events[eventKey];
      if (!e) throw new Error("Unknown event");
      const m = this.fx.markets.find((x) => x.eventKey === eventKey);
      const now = this.now();
      if (e.adapter === "BALANCE") throw new Error("Balance-threshold events resolve from an on-chain observation, not an attestation.");
      if (e.status === "FINAL") throw new Error("Already final.");
      if (e.status === "PENDING" && e.outcome !== outcome) {
        this.state.events[eventKey] = { ...e, status: "DISPUTED" };
        this.log({ at: now, kind: "event", title: `${m?.title ?? "Event"}: conflicting attestation — disputed`, detail: "Not final. Futures waiting on it keep waiting; at expiry they refund.", actor: "attestor", marketKey: m?.key });
      } else {
        this.state.events[eventKey] = { status: "PENDING", outcome, finalAt: now + CHALLENGE_SECONDS, adapter: "ATTESTATION" };
        this.log({ at: now, kind: "event", title: `${m?.title ?? "Event"}: ${outcome} proposed`, detail: `Signed by 2 of 3 development attestors (simulated). Final after a ${CHALLENGE_SECONDS / 60}-minute challenge window.`, actor: "attestor", marketKey: m?.key });
      }
      this.emit("markets", "strategies", "activity");
      this.tick();
    },
    disputeEvent: async (eventKey: string) => {
      const e = this.state.events[eventKey];
      if (!e || e.status !== "PENDING") throw new Error("Only a proposed (pending) outcome can be disputed.");
      this.state.events[eventKey] = { ...e, status: "DISPUTED" };
      const m = this.fx.markets.find((x) => x.eventKey === eventKey);
      this.log({ at: this.now(), kind: "event", title: `${m?.title ?? "Event"}: disputed`, detail: "Not final until adjudicated, or voided after the dispute timeout.", actor: "attestor", marketKey: m?.key });
      this.emit("markets", "strategies", "activity");
    },
    observeBalance: async (eventKey: string, units: bigint) => {
      const e = this.state.events[eventKey];
      const m = this.fx.markets.find((x) => x.eventKey === eventKey);
      if (!e || e.adapter !== "BALANCE" || !m?.balance) throw new Error("Not a balance event.");
      const now = this.now();
      if (e.status === "FINAL") throw new Error("Already final.");
      if (now > (e.deadline ?? 0)) throw new Error("The observation deadline has passed; this event is final NO.");
      if (units >= m.balance.thresholdUnits) {
        this.state.events[eventKey] = { ...e, status: "FINAL", outcome: "YES", finalAt: now };
        this.log({ at: now, kind: "event", title: `${m.title}: YES`, detail: `Observed ${this.fmt(this.fx.assetByKey.USDC!.mint, units)} in the watched account at or before the deadline.`, actor: "keeper", marketKey: m.key });
      } else {
        this.log({ at: now, kind: "event", title: `${m.title}: observation below threshold`, detail: `${this.fmt(this.fx.assetByKey.USDC!.mint, units)} observed; still open until the deadline.`, actor: "keeper", marketKey: m.key });
      }
      this.emit("markets", "strategies", "activity");
      this.tick();
    },
    advance: async (seconds: number) => {
      this.state.offset += seconds;
      this.log({ at: this.now(), kind: "system", title: `Simulated time moved forward ${seconds >= DAY ? `${Math.round(seconds / DAY)} day(s)` : `${Math.round(seconds / 3600)} hour(s)`}`, actor: "system" });
      this.tick();
      this.emit("clock", "markets", "strategies", "activity", "quotes");
    },
    setFailNext: async (on: boolean) => {
      this.state.failNext = on;
      this.emit("ops");
    },
    setExecutionPaused: async (on: boolean) => {
      this.state.executionPaused = on;
      this.log({ at: this.now(), kind: "system", title: on ? "Emergency pause: new steps stopped" : "Emergency pause lifted", detail: on ? "Withdrawals, cancellations and refunds still work." : undefined, actor: "system" });
      this.emit("ops", "strategies", "activity");
    },
    reset: async () => {
      safeRemove(KEY);
      this.state = this.seed();
      this.fx = buildFixtures(this.state.seededAt);
      this.emit("wallet", "portfolio", "markets", "strategies", "activity", "agents", "rooms", "ops", "quotes", "clock");
    },
    clockOffset: () => this.state.offset,
    failNext: () => this.state.failNext,
    executionPaused: () => this.state.executionPaused,
  };
}

