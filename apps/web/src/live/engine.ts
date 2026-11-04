/**
 * The Odds engine: turns live mainnet streams into tokens, questions and a live line, and keeps a
 * practice ledger that settles on real outcomes. Runs entirely in the browser; nothing here signs
 * or sends a transaction.
 */

import { aboveProbability, bidPrice, FlowTracker, graduationProbability, linePrice, realizedVolPerSqrtHour } from "./model.ts";
import { bondingCurveAddress, curveFromCreate, curveMcapSol, curveProgress, curveRemainingSol, decodeCurve, decodePool, decodeTokenAccount, TOTAL_SUPPLY_UNITS, type CurveState, WSOL } from "./solana.ts";
import { fetchMeta, ipfsUrl, Jupiter, PumpFeed, SolanaRpc, type CreateEvent, type JupToken, type MigrationEvent, type SourceHealth } from "./sources.ts";

export type Stage = "new" | "stretch" | "graduated";

export interface TokenStats {
  holders?: number;
  devPct?: number;
  top10Pct?: number;
  liquidityUsd?: number;
  buys5m?: number;
  sells5m?: number;
  vol5mUsd?: number;
  traders5m?: number;
  vol1hUsd?: number;
  change5m?: number;
  organic?: string;
  mintRevoked?: boolean;
  freezeRevoked?: boolean;
  devLaunches?: number;
  devGraduations?: number;
  updatedAt: number;
}

export interface LiveToken {
  mint: string;
  symbol: string;
  name: string;
  uri?: string;
  createdAt: number;
  seenAt: number;
  source: "launch" | "seed" | "migration" | "position";
  creator?: string;
  devBuySol?: number;
  devBuyPct?: number;
  stage: Stage;
  stageAt: number;
  curveKey?: string;
  progress?: number;
  remainingSol?: number;
  realSol?: number;
  curveAt?: number;
  graduatedAt?: number;
  poolAddress?: string;
  poolAt?: number;
  mcapSol?: number;
  mcapUsd?: number;
  image?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  stats?: TokenStats;
  enrichedAt?: number;
  /** last time the market cap moved, and which way (row flash) */
  tick?: { at: number; dir: 1 | -1 };
  v: number;
}

export type MarketKind = "grad-1h" | "grad-15m" | "above-1h";

export interface Market {
  id: string;
  kind: MarketKind;
  mint: string;
  question: string;
  opensAt: number;
  closesAt: number;
  strikeUsd?: number;
  p: number;
  status: "open" | "yes" | "no" | "void";
  resolvedAt?: number;
  note?: string;
  v: number;
}

export interface Position {
  id: string;
  marketId: string;
  kind: MarketKind;
  mint: string;
  symbol: string;
  image?: string;
  question: string;
  side: "YES" | "NO";
  stake: number;
  price: number;
  shares: number;
  openedAt: number;
  closesAt: number;
  opensAt: number;
  strikeUsd?: number;
  status: "open" | "won" | "lost" | "void" | "closed";
  payout?: number;
  settledAt?: number;
}

export interface Practice {
  balance: number;
  positions: Position[];
  startedAt: number;
}

export interface LiveStatus {
  feed: SourceHealth;
  chain: SourceHealth & { slot: number; subscriptions: number; polled: number };
  stats: SourceHealth & { queued: number };
  solUsd: number | null;
  launchesPerMin: number;
  lastLaunchAt: number;
  startedAt: number;
}

const STRETCH_ENTER = 0.55;
const STRETCH_LEAVE = 0.4;
const CAP = { new: 80, stretch: 40, graduated: 40 } as const;
const START_BALANCE = 10;
const PRACTICE_KEY = "maybe.odds.practice.v1";
const HISTORY_POINTS = 360;

const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

function fmtStrike(usd: number): string {
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(usd >= 1e7 ? 0 : 1)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(usd >= 1e5 ? 0 : 1)}K`;
  return `$${Math.round(usd)}`;
}

export class LiveEngine {
  // ── state read by the UI (immutable objects, replaced on change)
  private tokens = new Map<string, LiveToken>();
  private markets = new Map<string, Market>();
  private marketsByMint = new Map<string, string[]>();
  private columns: Record<Stage, string[]> = { new: [], stretch: [], graduated: [] };
  private status: LiveStatus;
  private practice: Practice;

  // ── internal, mutable
  private flows = new Map<string, FlowTracker>();
  private history = new Map<string, Array<[number, number]>>();
  private historyV = new Map<string, number>();
  private pools = new Map<string, { base?: bigint; quote?: bigint; baseVault: string; quoteVault: string; decimals: number; supply: number }>();
  private watchedCurves = new Map<string, string>(); // curve account → mint
  private launches: number[] = [];
  private listeners = new Set<() => void>();
  private emitQueued = false;
  private columnsDirty = true;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private visible = new Set<string>();
  private paused = false;
  private started = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly feed: PumpFeed;
  readonly rpc: SolanaRpc;
  readonly jup: Jupiter;

  constructor() {
    const onHealth = () => this.refreshStatus();
    this.feed = new PumpFeed({ onCreate: (e) => this.onCreate(e), onMigrate: (e) => this.onMigrate(e), onHealth });
    this.rpc = new SolanaRpc(onHealth);
    this.jup = new Jupiter(onHealth);
    this.status = {
      feed: this.feed.health,
      chain: { ...this.rpc.health, slot: 0, subscriptions: 0, polled: 0 },
      stats: { ...this.jup.health, queued: 0 },
      solUsd: null,
      launchesPerMin: 0,
      lastLaunchAt: 0,
      startedAt: Date.now(),
    };
    this.practice = loadPractice();
  }

  // ───────────────────────────────────────── lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    this.status = { ...this.status, startedAt: Date.now() };
    this.feed.start();
    this.rpc.start();
    void this.refreshSol();
    void this.seed();
    this.restorePositions();
    this.timers.push(setInterval(() => this.tick(), 1000));
    this.timers.push(setInterval(() => void this.enrich(), 2200));
    this.timers.push(setInterval(() => void this.refreshSol(), 30_000));
    this.timers.push(setInterval(() => void this.rpc.pollFallbacks().catch(() => undefined), 4000));
  }

  stop(): void {
    this.started = false;
    this.feed.stop();
    this.rpc.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ───────────────────────────────────────── subscriptions for React

  subscribe = (f: () => void): (() => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  getToken = (mint: string) => this.tokens.get(mint);
  getColumn = (stage: Stage) => this.columns[stage];
  getStatus = () => this.status;
  getPractice = () => this.practice;
  getMarket = (id: string) => this.markets.get(id);
  marketsFor = (mint: string): Market[] => (this.marketsByMint.get(mint) ?? []).map((id) => this.markets.get(id)!).filter(Boolean);
  historyFor = (mint: string) => this.history.get(mint) ?? [];
  historyVersion = (mint: string) => this.historyV.get(mint) ?? 0;

  /** The question a row shows: the open one that closes soonest for its stage. */
  headline = (mint: string): Market | undefined => {
    const t = this.tokens.get(mint);
    const list = this.marketsFor(mint);
    const want: MarketKind[] = t?.stage === "graduated" ? ["above-1h", "grad-1h", "grad-15m"] : t?.stage === "stretch" ? ["grad-15m", "grad-1h"] : ["grad-1h"];
    for (const k of want) {
      const open = list.filter((m) => m.kind === k).sort((a, b) => b.opensAt - a.opensAt)[0];
      if (open) return open;
    }
    return list[0];
  };

  setVisible(mints: Iterable<string>): void {
    this.visible = new Set(mints);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.columnsDirty = true;
    this.emit();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    const run = () => {
      this.emitQueued = false;
      if (this.columnsDirty && !this.paused) this.rebuildColumns();
      for (const f of this.listeners) f();
    };
    if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && document.visibilityState === "visible") requestAnimationFrame(run);
    else setTimeout(run, 250);
  }

  private refreshStatus(): void {
    const t = Date.now();
    this.launches = this.launches.filter((x) => t - x < 60_000);
    this.status = {
      ...this.status,
      feed: { ...this.feed.health },
      chain: { ...this.rpc.health, slot: this.rpc.slot, subscriptions: this.rpc.subscriptionCount, polled: this.rpc.polled.size },
      stats: { ...this.jup.health, queued: this.jup.queued },
      launchesPerMin: this.launches.length,
    };
    this.emit();
  }

  // ───────────────────────────────────────── token updates

  private put(mint: string, patch: Partial<LiveToken>): LiveToken | undefined {
    const t = this.tokens.get(mint);
    if (!t) return undefined;
    const next = { ...t, ...patch, v: t.v + 1 };
    if (patch.stage && patch.stage !== t.stage) this.columnsDirty = true;
    this.tokens.set(mint, next);
    this.emit();
    return next;
  }

  private addToken(t: Omit<LiveToken, "v">): LiveToken {
    const existing = this.tokens.get(t.mint);
    if (existing) return existing;
    const tok = { ...t, v: 1 };
    this.tokens.set(t.mint, tok);
    this.flows.set(t.mint, new FlowTracker());
    this.columnsDirty = true;
    this.emit();
    return tok;
  }

  private pushHistory(mint: string, mcapSol: number): void {
    const h = this.history.get(mint) ?? [];
    const t = Date.now();
    const last = h[h.length - 1];
    if (last && t - last[0] < 400) last[1] = mcapSol;
    else h.push([t, mcapSol]);
    if (h.length > HISTORY_POINTS) h.splice(0, h.length - HISTORY_POINTS);
    this.history.set(mint, h);
    this.historyV.set(mint, (this.historyV.get(mint) ?? 0) + 1);
  }

  private setMcap(mint: string, mcapSol: number, extra: Partial<LiveToken> = {}): void {
    const t = this.tokens.get(mint);
    if (!t || !(mcapSol > 0)) return;
    const prev = t.mcapSol;
    const sol = this.status.solUsd;
    const moved = prev !== undefined && Math.abs(mcapSol - prev) / prev > 0.0005;
    this.pushHistory(mint, mcapSol);
    this.put(mint, { ...extra, mcapSol, ...(sol ? { mcapUsd: mcapSol * sol } : {}), ...(moved ? { tick: { at: Date.now(), dir: mcapSol > prev! ? 1 : -1 } } : {}) });
  }

  // ───────────────────────────────────────── launches and graduations

  private onCreate(e: CreateEvent): void {
    if (e.pool && e.pool !== "pump") return; // pump.fun only
    const now = Date.now();
    this.launches.push(now);
    this.status = { ...this.status, lastLaunchAt: now };
    const curve = curveFromCreate(e);
    const devTokens = typeof e.initialBuy === "number" ? e.initialBuy : 0;
    const tok = this.addToken({
      mint: e.mint,
      symbol: (e.symbol ?? "").trim().slice(0, 16) || short(e.mint),
      name: (e.name ?? "").trim().slice(0, 48) || "Unnamed",
      ...(e.uri ? { uri: e.uri } : {}),
      createdAt: now,
      seenAt: now,
      source: "launch",
      ...(e.traderPublicKey ? { creator: e.traderPublicKey } : {}),
      ...(typeof e.solAmount === "number" ? { devBuySol: e.solAmount } : {}),
      devBuyPct: (devTokens / 1e9) * 100,
      stage: "new",
      stageAt: now,
      ...(e.bondingCurveKey ? { curveKey: e.bondingCurveKey } : {}),
    });
    if (curve) this.applyCurve(tok.mint, curve);
    if (e.bondingCurveKey) this.watchCurve(e.mint, e.bondingCurveKey);
    this.openMarket(tok.mint, "grad-1h", now, now + 60 * 60_000);
    void fetchMeta(e.uri).then((m) => {
      if (m) this.put(e.mint, { ...(m.image ? { image: m.image } : {}), ...(m.description ? { description: m.description } : {}), ...(m.twitter ? { twitter: m.twitter } : {}), ...(m.telegram ? { telegram: m.telegram } : {}), ...(m.website ? { website: m.website } : {}) });
    });
    this.trim();
    this.refreshStatus();
  }

  private onMigrate(e: MigrationEvent): void {
    const now = Date.now();
    const t = this.tokens.get(e.mint);
    if (!t) {
      // a graduation we didn't watch launch: show it, and let Jupiter fill in the rest
      this.addToken({ mint: e.mint, symbol: short(e.mint), name: "…", createdAt: now, seenAt: now, source: "migration", stage: "graduated", stageAt: now, graduatedAt: now });
      this.visible.add(e.mint);
      void this.enrich([e.mint]);
    } else {
      this.graduate(e.mint, now);
    }
    this.trim();
  }

  private graduate(mint: string, at: number): void {
    const t = this.tokens.get(mint);
    if (!t || t.stage === "graduated") return;
    if (t.curveKey) this.unwatchCurve(t.curveKey);
    this.put(mint, { stage: "graduated", stageAt: Date.now(), graduatedAt: at, progress: 1, remainingSol: 0 });
    for (const m of this.marketsFor(mint)) if (m.status === "open" && m.kind !== "above-1h") this.resolve(m.id, at <= m.closesAt ? "yes" : "no", at <= m.closesAt ? "The bonding curve filled and the token moved to PumpSwap." : "It graduated after this question closed.");
    void this.enrich([mint]);
  }

  // ───────────────────────────────────────── chain state

  private watchCurve(mint: string, curveKey: string): void {
    if (this.watchedCurves.has(curveKey)) return;
    this.watchedCurves.set(curveKey, mint);
    this.rpc.watch(curveKey, (data) => {
      if (!data) return;
      const c = decodeCurve(data);
      if (c) this.applyCurve(mint, c);
    });
  }

  private unwatchCurve(curveKey: string): void {
    if (!this.watchedCurves.delete(curveKey)) return;
    this.rpc.unwatch(curveKey);
  }

  private applyCurve(mint: string, c: CurveState): void {
    const t = this.tokens.get(mint);
    if (!t) return;
    const now = Date.now();
    const realSol = Number(c.realSol) / 1e9;
    this.flows.get(mint)?.observe(now, realSol);
    const progress = curveProgress(c);
    let stage: Stage = t.stage;
    let stageAt = t.stageAt;
    if (t.stage === "new" && progress >= STRETCH_ENTER) {
      stage = "stretch";
      stageAt = now;
      this.openMarket(mint, "grad-15m", now, now + 15 * 60_000);
    } else if (t.stage === "stretch" && progress < STRETCH_LEAVE) {
      stage = "new";
      stageAt = now;
    }
    this.setMcap(mint, curveMcapSol(c), { progress, remainingSol: curveRemainingSol(c), realSol, curveAt: now, stage, stageAt, ...(c.creator && !t.creator ? { creator: c.creator } : {}) });
    if (c.complete) this.graduate(mint, now);
  }

  private async watchPool(mint: string, poolAddress: string, decimals: number, supply: number): Promise<void> {
    if (this.pools.has(mint)) return;
    try {
      const acct = (await this.rpc.accounts([poolAddress])).get(poolAddress);
      const pool = acct ? decodePool(acct) : null;
      if (!pool || pool.baseMint !== mint || pool.quoteMint !== WSOL) return; // only canonical SOL pools, checked against the mint
      const entry = { baseVault: pool.baseVault, quoteVault: pool.quoteVault, decimals, supply } as { base?: bigint; quote?: bigint; baseVault: string; quoteVault: string; decimals: number; supply: number };
      this.pools.set(mint, entry);
      this.put(mint, { poolAddress });
      const onVault = (which: "base" | "quote") => (data: Uint8Array | null) => {
        const a = data ? decodeTokenAccount(data) : null;
        if (!a) return;
        entry[which] = a.amount;
        if (entry.base && entry.quote && entry.base > 0n) {
          const priceSol = Number(entry.quote) / 1e9 / (Number(entry.base) / 10 ** entry.decimals);
          this.setMcap(mint, priceSol * entry.supply, { poolAt: Date.now() });
          this.openAboveIfReady(mint);
        }
      };
      this.rpc.watch(pool.baseVault, onVault("base"));
      this.rpc.watch(pool.quoteVault, onVault("quote"));
      const vaults = await this.rpc.accounts([pool.baseVault, pool.quoteVault]);
      onVault("base")(vaults.get(pool.baseVault) ?? null);
      onVault("quote")(vaults.get(pool.quoteVault) ?? null);
    } catch {
      // Jupiter's price keeps the row current if the pool can't be read
    }
  }

  private unwatchPool(mint: string): void {
    const p = this.pools.get(mint);
    if (!p) return;
    this.rpc.unwatch(p.baseVault);
    this.rpc.unwatch(p.quoteVault);
    this.pools.delete(mint);
  }

  // ───────────────────────────────────────── Jupiter: seed and enrich

  private async seed(): Promise<void> {
    try {
      const [recent, traded] = await Promise.all([this.jup.list("recent"), this.jup.list("toptraded/5m", 60)]);
      const seen = new Set<string>();
      const all = [...traded, ...recent].filter((x) => x.launchpad === "pump.fun" && !seen.has(x.id) && seen.add(x.id));
      const onCurve = all.filter((x) => !x.graduatedPool);
      const graduated = all.filter((x) => x.graduatedPool && Date.now() - ms(x.graduatedAt) < 3 * 3600_000);
      const now = Date.now();
      // on the curve: read each curve once, then subscribe
      const keys = await Promise.all(onCurve.map(async (x) => [x, await bondingCurveAddress(x.id)] as const));
      const curves = await this.rpc.accounts(keys.map(([, k]) => k));
      for (const [x, key] of keys) {
        const data = curves.get(key);
        const c = data ? decodeCurve(data) : null;
        if (!c || c.complete) continue;
        const created = ms(x.createdAt) || ms(x.firstPool?.createdAt) || now;
        const progress = curveProgress(c);
        if (progress < STRETCH_ENTER && now - created > 60 * 60_000) continue; // stale and nowhere near graduating
        const stage: Stage = progress >= STRETCH_ENTER ? "stretch" : "new";
        this.addToken({ mint: x.id, symbol: x.symbol ?? short(x.id), name: x.name ?? "", createdAt: created, seenAt: now, source: "seed", stage, stageAt: now, curveKey: key, ...(x.dev ? { creator: x.dev } : {}) });
        this.applyJup(x);
        this.applyCurve(x.id, c);
        this.seedFlow(x);
        this.watchCurve(x.id, key);
        if (created + 60 * 60_000 > now) this.openMarket(x.id, "grad-1h", created, created + 60 * 60_000);
        if (stage === "stretch") this.openMarket(x.id, "grad-15m", now, now + 15 * 60_000);
      }
      for (const x of graduated) {
        const at = ms(x.graduatedAt) || now;
        this.addToken({ mint: x.id, symbol: x.symbol ?? short(x.id), name: x.name ?? "", createdAt: ms(x.createdAt) || at, seenAt: now, source: "seed", stage: "graduated", stageAt: at, graduatedAt: at, progress: 1, ...(x.dev ? { creator: x.dev } : {}) });
        this.applyJup(x);
      }
      this.trim();
    } catch {
      // the live streams fill the board on their own
    }
  }

  /** Seed a curve's flow from Jupiter's 5-minute volumes so the first estimate isn't blind. */
  private seedFlow(x: JupToken): void {
    const sol = this.status.solUsd;
    const s = x.stats5m;
    if (!sol || !s) return;
    const net = ((s.buyVolume ?? 0) - (s.sellVolume ?? 0)) / sol / 5;
    const gross = ((s.buyVolume ?? 0) + (s.sellVolume ?? 0)) / sol / 5;
    this.flows.get(x.id)?.seed(net, Math.max(1.2, Math.sqrt(Math.max(gross, 0)) * 1.4), 2);
  }

  private enriching = false;

  private async enrich(force?: string[]): Promise<void> {
    if (this.enriching && !force) return;
    if (!force) this.enriching = true;
    try {
      const now = Date.now();
      let batch: string[];
      if (force) batch = force;
      else {
        const all = [...this.tokens.values()];
        const score = (t: LiveToken) => {
          const age = now - (t.enrichedAt ?? 0);
          const fresh = now - t.seenAt;
          if (!t.enrichedAt && fresh > 3500) return 1e9; // brand new: Jupiter indexes within seconds
          return age * (this.visible.has(t.mint) ? 4 : 1) * (t.stage === "graduated" ? 1.5 : t.stage === "stretch" ? 2 : 1);
        };
        batch = all
          .filter((t) => now - (t.enrichedAt ?? 0) > 2500 && (t.enrichedAt || now - t.seenAt > 3500))
          .sort((a, b) => score(b) - score(a))
          .slice(0, 50)
          .map((t) => t.mint);
      }
      if (!batch.length) return;
      const res = await this.jup.tokens(batch);
      const got = new Set<string>();
      for (const x of res) {
        got.add(x.id);
        this.applyJup(x);
      }
      for (const m of batch) if (!got.has(m) && this.tokens.has(m)) this.put(m, { enrichedAt: now });
    } catch {
      // next round
    } finally {
      if (!force) this.enriching = false;
      this.refreshStatus();
    }
  }

  private applyJup(x: JupToken): void {
    const t = this.tokens.get(x.id);
    if (!t) return;
    const now = Date.now();
    const sol = this.status.solUsd;
    const stats: TokenStats = {
      ...(x.holderCount !== undefined ? { holders: x.holderCount } : {}),
      ...(x.audit?.devBalancePercentage !== undefined ? { devPct: x.audit.devBalancePercentage } : {}),
      ...(x.audit?.topHoldersPercentage !== undefined ? { top10Pct: x.audit.topHoldersPercentage } : {}),
      ...(x.liquidity !== undefined ? { liquidityUsd: x.liquidity } : {}),
      ...(x.stats5m ? { buys5m: x.stats5m.numBuys ?? 0, sells5m: x.stats5m.numSells ?? 0, vol5mUsd: (x.stats5m.buyVolume ?? 0) + (x.stats5m.sellVolume ?? 0), traders5m: x.stats5m.numTraders ?? 0, change5m: x.stats5m.priceChange ?? 0 } : {}),
      ...(x.stats1h ? { vol1hUsd: (x.stats1h.buyVolume ?? 0) + (x.stats1h.sellVolume ?? 0) } : {}),
      ...(x.organicScoreLabel ? { organic: x.organicScoreLabel } : {}),
      ...(x.audit?.mintAuthorityDisabled !== undefined ? { mintRevoked: x.audit.mintAuthorityDisabled } : {}),
      ...(x.audit?.freezeAuthorityDisabled !== undefined ? { freezeRevoked: x.audit.freezeAuthorityDisabled } : {}),
      ...(x.audit?.devMints !== undefined ? { devLaunches: x.audit.devMints } : {}),
      ...(x.audit?.devMigrations !== undefined ? { devGraduations: x.audit.devMigrations } : {}),
      updatedAt: now,
    };
    const patch: Partial<LiveToken> = {
      stats: { ...t.stats, ...stats },
      enrichedAt: now,
      ...(x.symbol && t.symbol.includes("…") ? { symbol: x.symbol.slice(0, 16) } : {}),
      ...(x.name && (t.name === "…" || !t.name) ? { name: x.name.slice(0, 48) } : {}),
      ...(!t.image && x.icon ? { image: ipfsUrl(x.icon) } : {}),
      ...(!t.twitter && x.twitter ? { twitter: x.twitter } : {}),
      ...(!t.telegram && x.telegram ? { telegram: x.telegram } : {}),
      ...(!t.website && x.website ? { website: x.website } : {}),
      ...(!t.creator && x.dev ? { creator: x.dev } : {}),
    };
    // market cap: chain data wins when it's fresh; Jupiter fills in otherwise
    const chainFresh = (t.stage === "graduated" ? t.poolAt : t.curveAt) ?? 0;
    if (x.mcap && sol && now - chainFresh > 6000) {
      this.put(x.id, patch);
      this.setMcap(x.id, x.mcap / sol);
    } else this.put(x.id, patch);
    if (x.graduatedPool) {
      if (t.stage !== "graduated") this.graduate(x.id, ms(x.graduatedAt) || now);
      void this.watchPool(x.id, x.graduatedPool, x.decimals ?? 6, x.totalSupply ?? Number(TOTAL_SUPPLY_UNITS / 1_000_000n));
      this.openAboveIfReady(x.id);
    }
  }

  private async refreshSol(): Promise<void> {
    try {
      const p = await this.jup.solUsd();
      if (p && p > 0) {
        this.status = { ...this.status, solUsd: p };
        for (const t of this.tokens.values()) if (t.mcapSol) this.tokens.set(t.mint, { ...t, mcapUsd: t.mcapSol * p, v: t.v + 1 });
        this.emit();
      }
    } catch {
      // keep the last price
    }
  }

  // ───────────────────────────────────────── board maintenance

  private rebuildColumns(): void {
    this.columnsDirty = false;
    const by: Record<Stage, LiveToken[]> = { new: [], stretch: [], graduated: [] };
    for (const t of this.tokens.values()) by[t.stage].push(t);
    by.new.sort((a, b) => b.createdAt - a.createdAt);
    by.stretch.sort((a, b) => b.stageAt - a.stageAt);
    by.graduated.sort((a, b) => (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0));
    for (const s of ["new", "stretch", "graduated"] as Stage[]) {
      const next = by[s].slice(0, CAP[s]).map((t) => t.mint);
      const prev = this.columns[s];
      if (next.length !== prev.length || next.some((m, i) => m !== prev[i])) this.columns = { ...this.columns, [s]: next };
    }
  }

  /** Keep the board bounded: drop the oldest rows beyond each column's cap (never one you hold a position in). */
  private trim(): void {
    const pinned = new Set(this.practice.positions.filter((p) => p.status === "open").map((p) => p.mint));
    const by: Record<Stage, LiveToken[]> = { new: [], stretch: [], graduated: [] };
    for (const t of this.tokens.values()) by[t.stage].push(t);
    by.new.sort((a, b) => b.createdAt - a.createdAt);
    by.stretch.sort((a, b) => b.stageAt - a.stageAt);
    by.graduated.sort((a, b) => (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0));
    for (const s of ["new", "stretch", "graduated"] as Stage[]) {
      for (const t of by[s].slice(CAP[s] + 10)) if (!pinned.has(t.mint)) this.drop(t.mint);
    }
    this.columnsDirty = true;
  }

  private drop(mint: string): void {
    const t = this.tokens.get(mint);
    if (!t) return;
    if (t.curveKey) this.unwatchCurve(t.curveKey);
    this.unwatchPool(mint);
    this.tokens.delete(mint);
    this.flows.delete(mint);
    this.history.delete(mint);
    this.historyV.delete(mint);
    for (const id of this.marketsByMint.get(mint) ?? []) this.markets.delete(id);
    this.marketsByMint.delete(mint);
  }

  // ───────────────────────────────────────── questions and the live line

  private openMarket(mint: string, kind: MarketKind, opensAt: number, closesAt: number, strikeUsd?: number): Market | undefined {
    const id = `${kind}:${mint}:${opensAt}`;
    if (this.markets.has(id)) return this.markets.get(id);
    if (closesAt <= Date.now()) return undefined;
    if (this.marketsFor(mint).some((m) => m.kind === kind && m.status === "open")) return undefined;
    const question = kind === "grad-1h" ? "Graduates within 1 hour of launch?" : kind === "grad-15m" ? "Graduates in the next 15 minutes?" : `Above ${fmtStrike(strikeUsd ?? 0)} market cap in 1 hour?`;
    const m: Market = { id, kind, mint, question, opensAt, closesAt, ...(strikeUsd ? { strikeUsd } : {}), p: 0.5, status: "open", v: 1 };
    this.markets.set(id, m);
    this.marketsByMint.set(mint, [...(this.marketsByMint.get(mint) ?? []), id]);
    this.reprice(m);
    return this.markets.get(id);
  }

  private openAboveIfReady(mint: string): void {
    const t = this.tokens.get(mint);
    if (!t || t.stage !== "graduated" || !t.mcapUsd) return;
    if (this.marketsFor(mint).some((m) => m.kind === "above-1h")) return;
    const now = Date.now();
    // watched live: strike at its graduation value; joined later: strike at today's value
    const strike = t.mcapUsd;
    this.openMarket(mint, "above-1h", now, now + 60 * 60_000, strike);
  }

  private reprice(m: Market): void {
    if (m.status !== "open") return;
    const t = this.tokens.get(m.mint);
    if (!t) return;
    const now = Date.now();
    let p = m.p;
    if (m.kind === "above-1h") {
      if (!t.mcapUsd || !m.strikeUsd) return;
      const hist = this.history.get(m.mint) ?? [];
      const vol = realizedVolPerSqrtHour(hist.slice(-120));
      const sigma = vol === null ? 1.6 : Math.min(6, 0.5 * vol + 0.5 * 1.6);
      p = aboveProbability(t.mcapUsd / m.strikeUsd, (m.closesAt - now) / 3_600_000, sigma);
    } else {
      if (t.stage === "graduated") return;
      if (t.remainingSol === undefined) return;
      const flow = this.flows.get(m.mint)?.estimate(now);
      if (!flow) return;
      p = graduationProbability(t.remainingSol, flow, (m.closesAt - now) / 60_000);
    }
    if (Math.abs(p - m.p) < 0.0005 && m.v > 1) return;
    this.markets.set(m.id, { ...m, p, v: m.v + 1 });
    this.emit();
  }

  private resolve(id: string, outcome: "yes" | "no" | "void", note: string): void {
    const m = this.markets.get(id);
    if (!m || m.status !== "open") return;
    this.markets.set(id, { ...m, status: outcome, resolvedAt: Date.now(), note, p: outcome === "yes" ? 1 : outcome === "no" ? 0 : m.p, v: m.v + 1 });
    this.settle(id, outcome);
    this.emit();
  }

  private tick(): void {
    const now = Date.now();
    for (const m of this.markets.values()) {
      if (m.status !== "open") continue;
      if (now >= m.closesAt) void this.close(m);
      else this.reprice(m);
    }
    this.refreshStatus();
  }

  private closing = new Set<string>();

  private async close(m: Market): Promise<void> {
    if (this.closing.has(m.id)) return;
    this.closing.add(m.id);
    try {
      const t = this.tokens.get(m.mint);
      if (m.kind === "above-1h") {
        const fresh = t && t.mcapUsd && now() - Math.max(t.poolAt ?? 0, t.stats?.updatedAt ?? 0) < 20_000;
        if (t && fresh && m.strikeUsd) this.resolve(m.id, t.mcapUsd! >= m.strikeUsd ? "yes" : "no", `Market cap at the close: ${fmtStrike(t.mcapUsd!)}.`);
        else this.resolve(m.id, "void", "No fresh price at the close, so stakes are returned.");
        return;
      }
      if (t?.stage === "graduated" && (t.graduatedAt ?? Infinity) <= m.closesAt) return this.resolve(m.id, "yes", "Graduated before the close.");
      // confirm on-chain before calling it a no
      if (t?.curveKey) {
        const data = (await this.rpc.accounts([t.curveKey])).get(t.curveKey);
        const c = data ? decodeCurve(data) : null;
        if (c?.complete) return this.graduate(m.mint, Date.now());
        if (c) return this.resolve(m.id, "no", `The curve was ${Math.round(curveProgress(c) * 100)}% full at the close.`);
      }
      // not watching the curve (joined after launch): Jupiter knows whether and when it graduated
      const [x] = await this.jup.tokens([m.mint]);
      if (x?.graduatedAt && ms(x.graduatedAt) <= m.closesAt) this.resolve(m.id, "yes", "Graduated before the close.");
      else if (x) this.resolve(m.id, "no", "Still on the bonding curve at the close.");
    } catch {
      // retried on the next tick
    } finally {
      this.closing.delete(m.id);
    }
  }

  // ───────────────────────────────────────── practice ledger

  buy(marketId: string, side: "YES" | "NO", stake: number): { ok: true; position: Position } | { ok: false; reason: string } {
    const m = this.markets.get(marketId);
    if (!m || m.status !== "open") return { ok: false, reason: "This question has closed." };
    if (Date.now() > m.closesAt - 5000) return { ok: false, reason: "Closing in seconds — too late to take a side." };
    if (!(stake > 0)) return { ok: false, reason: "Pick a stake first." };
    if (stake > this.practice.balance + 1e-9) return { ok: false, reason: `Only ${this.practice.balance.toFixed(2)} practice SOL left.` };
    const t = this.tokens.get(m.mint);
    const price = linePrice(m.p, side);
    const position: Position = {
      id: `pos_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      marketId,
      kind: m.kind,
      mint: m.mint,
      symbol: t?.symbol ?? short(m.mint),
      ...(t?.image ? { image: t.image } : {}),
      question: m.question,
      side,
      stake,
      price,
      shares: stake / price,
      openedAt: Date.now(),
      closesAt: m.closesAt,
      opensAt: m.opensAt,
      ...(m.strikeUsd ? { strikeUsd: m.strikeUsd } : {}),
      status: "open",
    };
    this.practice = { ...this.practice, balance: this.practice.balance - stake, positions: [position, ...this.practice.positions].slice(0, 200) };
    this.savePractice();
    this.emit();
    return { ok: true, position };
  }

  /** Sell a position back at the line before its question closes. */
  sell(positionId: string): number | null {
    const pos = this.practice.positions.find((p) => p.id === positionId);
    const m = pos ? this.markets.get(pos.marketId) : undefined;
    if (!pos || pos.status !== "open" || !m || m.status !== "open") return null;
    const value = pos.shares * bidPrice(m.p, pos.side);
    this.practice = { ...this.practice, balance: this.practice.balance + value, positions: this.practice.positions.map((p) => (p.id === positionId ? { ...p, status: "closed", payout: value, settledAt: Date.now() } : p)) };
    this.savePractice();
    this.emit();
    return value;
  }

  /** What a position would sell for right now. */
  value(p: Position): number | null {
    const m = this.markets.get(p.marketId);
    if (p.status !== "open" || !m || m.status !== "open") return null;
    return p.shares * bidPrice(m.p, p.side);
  }

  resetPractice(): void {
    this.practice = { balance: START_BALANCE, positions: [], startedAt: Date.now() };
    this.savePractice();
    this.emit();
  }

  private settle(marketId: string, outcome: "yes" | "no" | "void"): void {
    let changed = false;
    let balance = this.practice.balance;
    const positions = this.practice.positions.map((p) => {
      if (p.marketId !== marketId || p.status !== "open") return p;
      changed = true;
      if (outcome === "void") {
        balance += p.stake;
        return { ...p, status: "void" as const, payout: p.stake, settledAt: Date.now() };
      }
      const won = (outcome === "yes") === (p.side === "YES");
      if (won) balance += p.shares;
      return { ...p, status: won ? ("won" as const) : ("lost" as const), payout: won ? p.shares : 0, settledAt: Date.now() };
    });
    if (!changed) return;
    this.practice = { ...this.practice, balance, positions };
    this.savePractice();
  }

  private savePractice(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(PRACTICE_KEY, JSON.stringify(this.practice));
      } catch {
        // private window or storage blocked: practice lasts for this visit
      }
    }, 300);
  }

  /** Positions from an earlier visit: bring their tokens and questions back so they can settle. */
  private restorePositions(): void {
    const open = this.practice.positions.filter((p) => p.status === "open");
    if (!open.length) return;
    const now = Date.now();
    for (const p of open) {
      if (!this.tokens.has(p.mint)) this.addToken({ mint: p.mint, symbol: p.symbol, name: "", ...(p.image ? { image: p.image } : {}), createdAt: p.opensAt, seenAt: now, source: "position", stage: p.kind === "above-1h" ? "graduated" : "new", stageAt: now });
      if (!this.markets.has(p.marketId)) {
        const m: Market = { id: p.marketId, kind: p.kind, mint: p.mint, question: p.question, opensAt: p.opensAt, closesAt: p.closesAt, ...(p.strikeUsd ? { strikeUsd: p.strikeUsd } : {}), p: p.price, status: "open", v: 1 };
        this.markets.set(m.id, m);
        this.marketsByMint.set(p.mint, [...(this.marketsByMint.get(p.mint) ?? []), m.id]);
        // a price question that closed while nobody was watching can't be judged fairly
        if (p.kind === "above-1h" && p.closesAt < now) this.resolve(m.id, "void", "It closed while this page was closed, so stakes are returned.");
      }
    }
    void (async () => {
      for (const p of open) {
        const t = this.tokens.get(p.mint);
        if (!t || t.curveKey || t.stage === "graduated") continue;
        const key = await bondingCurveAddress(p.mint).catch(() => null);
        if (!key) continue;
        this.put(p.mint, { curveKey: key });
        this.watchCurve(p.mint, key);
        // a quiet curve sends no updates: read it once so the line has something to work with
        const data = (await this.rpc.accounts([key]).catch(() => null))?.get(key);
        const c = data ? decodeCurve(data) : null;
        if (c) this.applyCurve(p.mint, c);
      }
      await this.enrich(open.map((p) => p.mint));
    })();
  }
}

function now(): number {
  return Date.now();
}

function loadPractice(): Practice {
  try {
    const raw = localStorage.getItem(PRACTICE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Practice;
      if (typeof p.balance === "number" && Array.isArray(p.positions)) return p;
    }
  } catch {
    // fall through to a fresh balance
  }
  return { balance: START_BALANCE, positions: [], startedAt: Date.now() };
}

let singleton: LiveEngine | null = null;
export function liveEngine(): LiveEngine {
  singleton ??= new LiveEngine();
  return singleton;
}
