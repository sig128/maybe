import { emptyVault, type AssetInfo, type CapabilityPolicy, type FixtureSet, type Strategy } from "@maybe/core";
import { parse, stringify } from "../serde.ts";
import type {
  ActivityItem,
  AgentRole,
  AgentSession,
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
import { DevWallet } from "./devWallet.ts";

/**
 * Talks to apps/server (local validator or devnet). The server builds
 * unsigned transactions; this client signs them with the user's key, which
 * never leaves the browser, then hands the signed bytes back for submission
 * and tracking. Live changes arrive over Server-Sent Events.
 */
export class HttpBackend implements Backend {
  readonly kind = "localnet" as const;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private es: EventSource | null = null;
  private clockSkew = 0;
  private wallet_: DevWallet;

  constructor(private readonly base: string) {
    this.wallet_ = new DevWallet();
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base.replace(/\/$/, "")}/v1${path}`, {
      ...init,
      // bearer-token auth only: no cookies cross the origin boundary
      headers: { "content-type": "application/json", ...(init.method && init.method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}), ...(this.wallet_.session ? { authorization: `Bearer ${this.wallet_.session}` } : {}), ...(init.headers ?? {}) },
    });
    const text = await res.text();
    const body = text ? parse<{ error?: string } & T>(text) : ({} as T & { error?: string });
    if (res.status === 401 && this.wallet_.session) {
      // the sign-in expired or the server was reset: back to a clean disconnected state
      this.wallet_.session = null;
      this.emit("wallet", "portfolio", "strategies", "activity", "agents");
    }
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.req<T>(path, { method: "POST", body: stringify(body) });
  }

  now(): number {
    return Math.floor(Date.now() / 1000) + this.clockSkew;
  }

  subscribe(cb: (e: ChangeEvent) => void): () => void {
    this.listeners.add(cb);
    if (!this.es && typeof EventSource !== "undefined") {
      this.es = new EventSource(`${this.base.replace(/\/$/, "")}/v1/stream`);
      this.es.onmessage = (m) => {
        try {
          const e = parse<ChangeEvent & { now?: number }>(m.data);
          if (e.now) this.clockSkew = e.now - Math.floor(Date.now() / 1000);
          for (const l of this.listeners) l(e);
        } catch {
          /* ignore malformed */
        }
      };
    }
    return () => this.listeners.delete(cb);
  }

  environment = () => this.req<Environment>("/environment");
  fixtures = () => this.req<FixtureSet>("/fixtures");
  assets = () => this.req<AssetInfo[]>("/assets");

  async wallet(): Promise<WalletState> {
    if (!this.wallet_.address || !this.wallet_.session) return { status: "disconnected", label: "Local dev wallet", kind: "dev-keypair", balances: {} };
    const balances = await this.req<Record<string, bigint>>(`/wallet/${this.wallet_.address}/balances`);
    return { status: "connected", address: this.wallet_.address, label: "Local dev wallet (localnet only)", kind: "dev-keypair", balances };
  }

  async connectWallet(): Promise<WalletState> {
    const { address } = await this.wallet_.ensure();
    const ch = await this.post<{ message: string }>("/auth/challenge", { address });
    const signature = this.wallet_.signMessage(ch.message);
    const s = await this.post<{ session: string }>("/auth/verify", { address, message: ch.message, signature });
    this.wallet_.session = s.session;
    await this.post("/wallet/airdrop", { address });
    this.emit("wallet", "portfolio");
    return this.wallet();
  }

  async disconnectWallet(): Promise<void> {
    await this.post("/auth/logout", {}).catch(() => undefined);
    this.wallet_.session = null;
    this.emit("wallet", "portfolio");
  }

  private emit(...topics: ChangeEvent["topics"]) {
    for (const l of this.listeners) l({ topics });
  }

  /** server returns base64 unsigned transactions; sign locally; submit */
  private async signAndSubmit(path: string, body: unknown): Promise<TxRecord[]> {
    const built = await this.post<{ txs: string[]; labels: string[]; intent: string }>(path, body);
    const signed = built.txs.map((t) => this.wallet_.signTransaction(t));
    return this.post<TxRecord[]>("/tx/submit", { intent: built.intent, signed, labels: built.labels });
  }

  /** Disconnected is a normal state: user-scoped reads are empty rather than errors. */
  private get signedIn(): boolean {
    return !!this.wallet_.session;
  }

  portfolio = async (): Promise<Portfolio> =>
    this.signedIn
      ? this.req<Portfolio>(`/portfolio`)
      : { asOf: this.now(), wallet: {}, vault: emptyVault("", ""), strategies: [], pendingReservations: [], pendingTransfers: [], estimates: {} };
  deposit = async (mint: string, units: bigint) => (await this.signAndSubmit("/money/deposit", { mint, units }))[0]!;
  withdraw = async (mint: string, units: bigint) => (await this.signAndSubmit("/money/withdraw", { mint, units }))[0]!;
  markets = () => this.req<MarketSummary[]>("/markets");
  market = (key: string) => this.req<MarketDetail | null>(`/markets/${encodeURIComponent(key)}`);
  strategies = async () => (this.signedIn ? this.req<StrategyView[]>("/strategies") : []);
  strategy = async (id: string) => (this.signedIn ? this.req<StrategyView | null>(`/strategies/${encodeURIComponent(id)}`) : null);
  saveDraft = (doc: Strategy) => this.post<StrategyView>("/strategies", { doc });
  deleteDraft = async (id: string) => {
    await this.req(`/strategies/${encodeURIComponent(id)}`, { method: "DELETE" });
  };
  prepare = (doc: Strategy) => this.post<Prepared>("/strategies/prepare", { doc });
  authorize = (id: string, expectedHash: string) => this.signAndSubmit(`/strategies/${encodeURIComponent(id)}/authorize`, { expectedHash });
  fundWithPolicy = (id: string, policyAddress: string) => this.post<TxRecord[]>(`/strategies/${encodeURIComponent(id)}/fund-with-policy`, { policyAddress });
  newVersionOf = (id: string) => this.post<StrategyView>(`/strategies/${encodeURIComponent(id)}/new-version`, {});
  pause = async (id: string, paused: boolean) => (await this.signAndSubmit(`/strategies/${encodeURIComponent(id)}/pause`, { paused }))[0]!;
  cancel = async (id: string) => (await this.signAndSubmit(`/strategies/${encodeURIComponent(id)}/cancel`, {}))[0]!;
  activity = async () => (this.signedIn ? this.req<ActivityItem[]>("/activity") : []);
  agentSessions = async () => (this.signedIn ? this.req<AgentSession[]>("/agents/sessions") : []);
  sendAgentMessage = (sessionId: string | null, role: AgentRole, text: string) => this.post<AgentSession>("/agents/message", { sessionId, role, text });
  policies = async () => (this.signedIn ? this.req<CapabilityPolicy[]>("/agents/policies") : []);
  createPolicy = (p: Parameters<Backend["createPolicy"]>[0]) => this.signAndSubmit("/agents/policies", p).then(() => this.req<CapabilityPolicy[]>("/agents/policies").then((l) => l[0]!));
  revokePolicy = async (address: string) => {
    await this.signAndSubmit(`/agents/policies/${encodeURIComponent(address)}/revoke`, {});
  };
  killSwitch = async () => {
    await this.signAndSubmit("/agents/kill-switch", {});
  };
  rooms = () => this.req<RoomRecord[]>("/rooms");
  room = (slug: string) => this.req<RoomRecord | null>(`/rooms/${encodeURIComponent(slug)}`);
  publishRoom = (strategyId: string, thesis: string, risk: string[]) => this.post<RoomRecord>("/rooms", { strategyId, thesis, risk });
  cloneRoom = (slug: string, version: number) => this.post<StrategyView>(`/rooms/${encodeURIComponent(slug)}/clone`, { version });
  ops = () => this.req<OpsStatus>("/ops");

  /** local-validator controls; the server refuses them anywhere else */
  dev = {
    label: "Local validator controls",
    resolveEvent: async (eventKey: string, outcome: "YES" | "NO" | "VOID") => {
      await this.post(`/dev/events/${encodeURIComponent(eventKey)}/resolve`, { outcome });
      this.emit("markets", "strategies", "activity");
    },
    disputeEvent: async (eventKey: string) => {
      await this.post(`/dev/events/${encodeURIComponent(eventKey)}/dispute`, {});
      this.emit("markets", "strategies", "activity");
    },
    observeBalance: async (eventKey: string, units: bigint) => {
      await this.post(`/dev/events/${encodeURIComponent(eventKey)}/observe`, { units });
      this.emit("markets", "strategies", "activity");
    },
    setExecutionPaused: async (on: boolean) => {
      await this.post("/dev/pause", { paused: on });
      this.emit("ops", "strategies", "activity");
    },
  };
}
