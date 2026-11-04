/**
 * Live data sources, all called directly from the visitor's browser:
 *  - PumpPortal websocket: pump.fun launches and graduations, as they happen (free streams)
 *  - Solana mainnet via PublicNode: account subscriptions for bonding curves and PumpSwap pools
 *  - Jupiter token API: holders, dev and top-holder share, volume, socials, icons (5 req / 10 s)
 *  - IPFS (Filebase gateway): the token's own metadata JSON and image
 * Each source reconnects on its own and reports its health for the status bar.
 */

import { fromBase64 } from "./solana.ts";

export type SourceState = "connecting" | "live" | "retrying" | "offline";

export interface SourceHealth {
  state: SourceState;
  /** last message or successful response, ms epoch */
  lastAt: number;
  /** round trip or delivery delay, ms */
  latencyMs: number | null;
  detail: string;
}

const now = () => Date.now();

// ───────────────────────────────────────── PumpPortal

export interface CreateEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "create";
  initialBuy?: number;
  solAmount?: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  pool?: string;
  is_mayhem_mode?: boolean;
}

export interface MigrationEvent {
  signature?: string;
  mint: string;
  txType: "migrate" | string;
  pool?: string;
}

export class PumpFeed {
  health: SourceHealth = { state: "connecting", lastAt: 0, latencyMs: null, detail: "PumpPortal" };
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly handlers: { onCreate(e: CreateEvent): void; onMigrate(e: MigrationEvent): void; onHealth(): void },
    private readonly url = "wss://pumpportal.fun/api/data",
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.health = { ...this.health, state: this.attempt ? "retrying" : "connecting" };
    this.handlers.onHealth();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const opened = now();
    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      this.health = { state: "live", lastAt: now(), latencyMs: now() - opened, detail: "PumpPortal" };
      this.handlers.onHealth();
    };
    ws.onmessage = (e) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.health.lastAt = now();
      if (m.txType === "create" && typeof m.mint === "string") this.handlers.onCreate(m as unknown as CreateEvent);
      else if ((m.txType === "migrate" || m.txType === "migration") && typeof m.mint === "string") this.handlers.onMigrate(m as unknown as MigrationEvent);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      this.attempt++;
      this.health = { ...this.health, state: "retrying" };
      this.handlers.onHealth();
      this.timer = setTimeout(() => this.connect(), Math.min(30_000, 800 * 2 ** Math.min(this.attempt, 5)));
    };
    ws.onerror = () => ws.close();
  }
}

// ───────────────────────────────────────── Solana RPC (websocket subscriptions + HTTP batches)

type AccountHandler = (data: Uint8Array | null, slot: number) => void;

/** PublicNode's free endpoint refuses getMultipleAccounts calls with more than 10 accounts. */
const ACCOUNTS_PER_CALL = 10;
const PARALLEL_READS = 4;

export class SolanaRpc {
  health: SourceHealth = { state: "connecting", lastAt: 0, latencyMs: null, detail: "PublicNode" };
  slot = 0;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { account: string; sentAt: number }>();
  /** account → handler (one subscription per account) */
  private handlers = new Map<string, AccountHandler>();
  private subIdByAccount = new Map<string, number>();
  private accountBySubId = new Map<number, string>();
  private attempt = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private slotSub = false;
  /** accounts whose subscription failed: served by HTTP polling instead */
  readonly polled = new Set<string>();

  constructor(
    private readonly onHealth: () => void,
    private readonly http = "https://solana-rpc.publicnode.com",
    private readonly wsUrl = "wss://solana-rpc.publicnode.com",
    private readonly maxSubscriptions = 220,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  get subscriptionCount(): number {
    return this.handlers.size;
  }

  watch(account: string, handler: AccountHandler): void {
    const had = this.handlers.has(account);
    this.handlers.set(account, handler);
    if (had) return;
    if (this.handlers.size > this.maxSubscriptions) {
      this.polled.add(account);
      return;
    }
    this.sendSubscribe(account);
  }

  unwatch(account: string): void {
    if (!this.handlers.delete(account)) return;
    this.polled.delete(account);
    const sub = this.subIdByAccount.get(account);
    this.subIdByAccount.delete(account);
    if (sub !== undefined) {
      this.accountBySubId.delete(sub);
      this.send({ jsonrpc: "2.0", id: this.nextId++, method: "accountUnsubscribe", params: [sub] });
    }
  }

  private send(msg: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private sendSubscribe(account: string): void {
    const id = this.nextId++;
    if (this.send({ jsonrpc: "2.0", id, method: "accountSubscribe", params: [account, { encoding: "base64", commitment: "confirmed" }] })) this.pending.set(id, { account, sentAt: now() });
  }

  private connect(): void {
    if (this.closed) return;
    this.health = { ...this.health, state: this.attempt ? "retrying" : "connecting" };
    this.onHealth();
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.pending.clear();
      this.subIdByAccount.clear();
      this.accountBySubId.clear();
      this.send({ jsonrpc: "2.0", id: this.nextId++, method: "slotSubscribe" });
      this.slotSub = true;
      let n = 0;
      for (const account of this.handlers.keys()) {
        if (n++ >= this.maxSubscriptions) {
          this.polled.add(account);
          continue;
        }
        this.polled.delete(account);
        this.sendSubscribe(account);
      }
      this.health = { ...this.health, state: "live", lastAt: now() };
      this.onHealth();
    };
    ws.onmessage = (e) => {
      let m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { subscription: number; result: { context?: { slot: number }; value?: { data?: [string, string] } | null } | number | { slot: number } } };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.health.lastAt = now();
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (typeof m.result === "number" && this.handlers.has(p.account)) {
          this.subIdByAccount.set(p.account, m.result);
          this.accountBySubId.set(m.result, p.account);
          this.health.latencyMs = now() - p.sentAt;
        } else if (m.error) {
          this.polled.add(p.account);
        }
        return;
      }
      if (m.method === "slotNotification" && m.params && typeof m.params.result === "object" && m.params.result && "slot" in m.params.result) {
        this.slot = (m.params.result as { slot: number }).slot;
        return;
      }
      if (m.method === "accountNotification" && m.params) {
        const account = this.accountBySubId.get(m.params.subscription);
        if (!account) return;
        const r = m.params.result as { context?: { slot: number }; value?: { data?: [string, string] } | null };
        const handler = this.handlers.get(account);
        const raw = r.value?.data?.[0];
        handler?.(raw ? fromBase64(raw) : null, r.context?.slot ?? this.slot);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.slotSub = false;
      if (this.closed) return;
      this.attempt++;
      this.health = { ...this.health, state: "retrying" };
      this.onHealth();
      this.timer = setTimeout(() => this.connect(), Math.min(20_000, 600 * 2 ** Math.min(this.attempt, 5)));
    };
    ws.onerror = () => ws.close();
  }

  /** getMultipleAccounts in batches of 100. */
  /**
   * Read accounts over HTTP. PublicNode's free endpoint takes at most 10 accounts per call, so reads
   * go out in chunks of 10, a few at a time. The map holds an entry for every account that was read
   * (null when it doesn't exist); a chunk that failed is simply missing. Throws only when nothing
   * could be read at all.
   */
  async accounts(addresses: string[]): Promise<Map<string, Uint8Array | null>> {
    const out = new Map<string, Uint8Array | null>();
    const chunks: string[][] = [];
    for (let i = 0; i < addresses.length; i += ACCOUNTS_PER_CALL) chunks.push(addresses.slice(i, i + ACCOUNTS_PER_CALL));
    let failure: unknown = null;
    let read = 0;
    const readChunk = async (chunk: string[]) => {
      const t0 = now();
      const res = await fetch(this.http, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [chunk, { encoding: "base64", commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(8000),
      });
      const j = (await res.json()) as { result?: { context: { slot: number }; value: Array<{ data: [string, string] } | null> }; error?: { message: string } };
      if (!j.result) throw new Error(j.error?.message ?? `RPC ${res.status}`);
      this.slot = Math.max(this.slot, j.result.context.slot);
      this.health.lastAt = now();
      this.health.latencyMs = now() - t0;
      j.result.value.forEach((v, k) => out.set(chunk[k]!, v ? fromBase64(v.data[0]) : null));
      read++;
    };
    const queue = [...chunks];
    const worker = async () => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        try {
          await readChunk(chunk);
        } catch (e) {
          failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, chunks.length) }, worker));
    if (chunks.length && !read) throw failure ?? new Error("RPC read failed");
    return out;
  }

  /** Poll the accounts whose subscriptions couldn't be opened. */
  async pollFallbacks(): Promise<void> {
    const list = [...this.polled].filter((a) => this.handlers.has(a));
    if (!list.length) return;
    const data = await this.accounts(list);
    for (const [a, d] of data) this.handlers.get(a)?.(d, this.slot);
  }

  get live(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.slotSub;
  }
}

// ───────────────────────────────────────── Jupiter token data (rate limited: 5 requests / 10 s)

export interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  dev?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  launchpad?: string;
  graduatedPool?: string;
  graduatedAt?: string;
  holderCount?: number;
  mcap?: number;
  fdv?: number;
  usdPrice?: number;
  liquidity?: number;
  totalSupply?: number;
  createdAt?: string;
  organicScoreLabel?: string;
  audit?: { devBalancePercentage?: number; topHoldersPercentage?: number; mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; devMints?: number; devMigrations?: number };
  stats5m?: { buyVolume?: number; sellVolume?: number; numBuys?: number; numSells?: number; numTraders?: number; priceChange?: number };
  stats1h?: { buyVolume?: number; sellVolume?: number; numBuys?: number; numSells?: number; numTraders?: number; priceChange?: number };
  firstPool?: { id: string; createdAt: string };
}

class RateLimited extends Error {
  constructor() {
    super("rate limited");
  }
}

export class Jupiter {
  health: SourceHealth = { state: "connecting", lastAt: 0, latencyMs: null, detail: "Jupiter" };
  private queue: Array<() => Promise<void>> = [];
  private running = false;
  private blockedUntil = 0;
  private stamps: number[] = [];

  constructor(
    private readonly onHealth: () => void,
    private readonly base = "https://lite-api.jup.ag",
    private readonly perWindow = 5,
    private readonly windowMs = 10_500,
  ) {}

  private schedule<T>(f: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => f().then(resolve, reject));
      void this.pump();
    });
  }

  get queued(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const t = now();
        this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
        const wait = Math.max(this.blockedUntil - t, this.stamps.length >= this.perWindow ? this.windowMs - (t - this.stamps[0]!) : 0);
        if (wait > 0) {
          await new Promise((r) => setTimeout(r, wait + 25));
          continue;
        }
        this.stamps.push(now());
        const job = this.queue.shift()!;
        await job().catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  /** A rate-limited request waits out the window and goes again (twice at most) instead of failing. */
  private async get<T>(path: string, retries = 2): Promise<T> {
    try {
      return await this.request<T>(path);
    } catch (e) {
      if (e instanceof RateLimited && retries > 0) return this.get<T>(path, retries - 1);
      throw e;
    }
  }

  private request<T>(path: string): Promise<T> {
    return this.schedule(async () => {
      const t0 = now();
      const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(8000) });
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        this.blockedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 + 200 : now() + 10_000;
        this.health = { ...this.health, state: "retrying", detail: "Jupiter (rate limited)" };
        this.onHealth();
        throw new RateLimited();
      }
      if (!res.ok) throw new Error(`Jupiter ${res.status}`);
      const body = (await res.json()) as T;
      this.health = { state: "live", lastAt: now(), latencyMs: now() - t0, detail: "Jupiter" };
      this.onHealth();
      return body;
    });
  }

  tokens(mints: string[]): Promise<JupToken[]> {
    return this.get<JupToken[]>(`/tokens/v2/search?query=${mints.slice(0, 50).join(",")}`);
  }

  list(kind: "recent" | "toptraded/5m" | "toptrending/5m", limit = 50): Promise<JupToken[]> {
    return this.get<JupToken[]>(`/tokens/v2/${kind}${kind === "recent" ? "" : `?limit=${limit}`}`);
  }

  async solUsd(): Promise<number | null> {
    const j = await this.get<Record<string, { usdPrice?: number }>>("/price/v3?ids=So11111111111111111111111111111111111111112");
    return j.So11111111111111111111111111111111111111112?.usdPrice ?? null;
  }
}

// ───────────────────────────────────────── metadata (the token's own JSON, via an IPFS gateway that allows browser reads)

export interface TokenMeta {
  image?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

const GATEWAY = "https://ipfs.filebase.io/ipfs/";

/** Rewrite any IPFS URL to a gateway that browsers can read from (ipfs.io refuses cross-site reads). */
export function ipfsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /\/ipfs\/([A-Za-z0-9]+)(\/.*)?$/.exec(url) ?? /^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/.exec(url);
  return m ? `${GATEWAY}${m[1]}${m[2] ?? ""}` : url;
}

let inflight = 0;
const waiting: Array<() => void> = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (inflight >= 6) await new Promise<void>((r) => waiting.push(r));
  inflight++;
  try {
    return await f();
  } finally {
    inflight--;
    waiting.shift()?.();
  }
}

const metaCache = new Map<string, Promise<TokenMeta | null>>();

export function fetchMeta(uri: string | undefined): Promise<TokenMeta | null> {
  if (!uri || !/^https?:|^ipfs:/.test(uri)) return Promise.resolve(null);
  const hit = metaCache.get(uri);
  if (hit) return hit;
  const p = slot(async () => {
    try {
      const res = await fetch(ipfsUrl(uri)!, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      const str = (k: string) => (typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim() : undefined);
      return { image: ipfsUrl(str("image")), description: str("description")?.slice(0, 400), twitter: str("twitter"), telegram: str("telegram"), website: str("website") };
    } catch {
      return null;
    }
  });
  metaCache.set(uri, p);
  if (metaCache.size > 800) metaCache.delete(metaCache.keys().next().value!);
  return p;
}
