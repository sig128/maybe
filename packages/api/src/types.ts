import type {
  AssetInfo,
  AuthorizationSummary,
  CapabilityPolicy,
  CompileIssue,
  EventView,
  Issue,
  MarketFixture,
  Readiness,
  Receipt,
  SimulationReport,
  Strategy,
  StrategyLifecycleState,
  StrategyState,
  TxState,
  VaultState,
  Plan,
  SourceMap,
  FixtureSet,
} from "@maybe/core";

export type Mode = "simulation" | "localnet" | "devnet";

export interface VenueCapability {
  id: string;
  label: string;
  discovery: "fixture" | "live" | "unavailable";
  quotes: "sample" | "live" | "unavailable";
  trading: "enabled" | "read-only" | "unavailable";
  settlement: string;
  note: string;
}

export interface Environment {
  mode: Mode;
  label: string;
  description: string;
  network: string;
  executionLive: boolean;
  vaultProgram?: string;
  venues: VenueCapability[];
  /** how outcomes are signed here (development attestors on localnet) */
  attestation?: { threshold: number; of: number; challengeSeconds: number; development: boolean };
}

export interface WalletState {
  status: "disconnected" | "connecting" | "connected";
  address?: string;
  label: string;
  kind: "simulated" | "dev-keypair" | "wallet-standard";
  balances: Record<string, bigint>;
}

export interface Quote {
  yesBps: number;
  noBps: number;
  spreadBps: number;
  asOf: number;
  source: string;
  sample: boolean;
}

export interface MarketSummary {
  key: string;
  eventKey: string;
  venue: MarketFixture["venue"] | "polymarket" | "kalshi";
  venueMarketId: string;
  title: string;
  category: MarketFixture["category"];
  kind: MarketFixture["kind"];
  outcomes: string[];
  status: MarketFixture["status"];
  closesAt: number;
  resolvesBy: number;
  quote: Quote | null;
  depthUsd: number;
  adapter: MarketFixture["adapter"];
  trust: string;
  compatible: { ok: boolean; reason?: string };
  resolution: EventView;
}

export interface MarketDetail extends MarketSummary {
  description: string;
  rules: string;
  ruleHash: string;
  resolutionSource: string;
  history: Array<{ t: number; bps: number }>;
  exposure: Array<{ strategyId: string; title: string; status: StrategyLifecycleState; steps: string[] }>;
  balance?: { watched: string; threshold: bigint; mint: string };
}

export interface TxRecord {
  id: string;
  label: string;
  state: TxState;
  signature: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  simulated: boolean;
  /** what will change when this confirms */
  effect?: string;
}

export type ActivityKind =
  | "deposit"
  | "withdraw"
  | "authorize"
  | "activate"
  | "execute"
  | "release"
  | "refund"
  | "cancel"
  | "pause"
  | "event"
  | "agent"
  | "policy"
  | "room"
  | "failure"
  | "system";

export interface ActivityItem {
  id: string;
  at: number;
  kind: ActivityKind;
  title: string;
  detail?: string;
  amounts?: Array<{ mint: string; units: bigint; dir: "in" | "out" | "move" }>;
  strategyId?: string;
  marketKey?: string;
  tx?: TxRecord;
  actor: "you" | "keeper" | "agent" | "attestor" | "system";
  sample?: boolean;
}

export interface StrategyView {
  id: string;
  title: string;
  status: StrategyLifecycleState;
  doc: Strategy;
  createdAt: number;
  updatedAt: number;
  sample?: boolean;
  authorization?: { hash: string; size: number; signedAt?: number };
  pendingTx?: TxRecord[];
  runtime?: StrategyState;
  receipts: Receipt[];
  readiness: Readiness[];
  nextWake?: number;
  lastError?: string;
}

export interface Prepared {
  ok: boolean;
  issues: Issue[];
  compileIssues?: CompileIssue[];
  hash?: string;
  bytes?: Uint8Array;
  plan?: Plan;
  sourceMap?: SourceMap;
  report?: SimulationReport;
  authorization?: AuthorizationSummary;
}

export interface Portfolio {
  asOf: number;
  wallet: Record<string, bigint>;
  vault: VaultState;
  strategies: StrategyView[];
  /** reservations still in flight (submitted, not confirmed) */
  pendingReservations: Array<{ strategyId: string; mint: string; units: bigint; state: TxState }>;
  pendingTransfers: Array<{ kind: "deposit" | "withdraw"; mint: string; units: bigint; state: TxState }>;
  estimates: Record<string, { priceE6: bigint; source: string; asOf: number }>;
}

export interface AgentStep {
  id: string;
  at: number;
  kind: "message" | "tool" | "source" | "draft" | "validation" | "question" | "refusal" | "receipt";
  role: "user" | "agent";
  agent?: AgentRole;
  text: string;
  detail?: string;
  data?: unknown;
  /** external content is shown as quoted data, never as instructions */
  untrusted?: boolean;
}

export type AgentRole = "researcher" | "builder" | "monitor" | "executor";

export interface AgentSession {
  id: string;
  role: AgentRole;
  title: string;
  createdAt: number;
  steps: AgentStep[];
  draftId?: string;
  provider: string;
  costUsd: number;
}

export interface RoomVersion {
  version: number;
  publishedAt: number;
  doc: Strategy;
  hash: string;
  thesis: string;
  risk: string[];
}

export interface RoomRecord {
  id: string;
  slug: string;
  title: string;
  author: string;
  createdAt: number;
  sample: boolean;
  versions: RoomVersion[];
  record: {
    kind: "live" | "paper" | "backtest" | "none";
    note: string;
    outcomes: Array<{ label: string; result: "won" | "lost" | "refunded" | "open"; detail: string }>;
  };
  copies: number;
}

export interface OpsStatus {
  mode: Mode;
  keeper: { running: boolean; lastTickAt: number; ticks: number };
  jobs: Array<{ id: string; kind: string; state: string; attempts: number; runAt: number; lastError?: string }>;
  reconciliation: Array<{ at: number; scope: string; ok: boolean; detail: string }>;
  health: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface ChangeEvent {
  topics: Array<"wallet" | "portfolio" | "markets" | "quotes" | "strategies" | "activity" | "agents" | "rooms" | "ops" | "clock">;
}

export interface Backend {
  readonly kind: Mode;
  environment(): Promise<Environment>;
  subscribe(cb: (e: ChangeEvent) => void): () => void;
  now(): number;
  assets(): Promise<AssetInfo[]>;
  /** the environment's fixture set (assets, markets, pools with this environment's addresses) — used to build templates */
  fixtures(): Promise<FixtureSet>;

  wallet(): Promise<WalletState>;
  connectWallet(): Promise<WalletState>;
  disconnectWallet(): Promise<void>;

  portfolio(): Promise<Portfolio>;
  deposit(mint: string, units: bigint): Promise<TxRecord>;
  withdraw(mint: string, units: bigint): Promise<TxRecord>;

  markets(): Promise<MarketSummary[]>;
  market(key: string): Promise<MarketDetail | null>;

  strategies(): Promise<StrategyView[]>;
  strategy(id: string): Promise<StrategyView | null>;
  saveDraft(doc: Strategy): Promise<StrategyView>;
  deleteDraft(id: string): Promise<void>;
  prepare(doc: Strategy): Promise<Prepared>;
  /** sign + submit the prepared plan; resolves when submitted (progress arrives via subscribe) */
  authorize(id: string, expectedHash: string): Promise<TxRecord[]>;
  /** fund a draft with an agent session key under a capability policy (limits enforced by the program) */
  fundWithPolicy(id: string, policyAddress: string): Promise<TxRecord[]>;
  /** start a new version of an authorized future; the signed one never changes */
  newVersionOf(id: string): StrategyView | Promise<StrategyView>;
  pause(id: string, paused: boolean): Promise<TxRecord>;
  cancel(id: string): Promise<TxRecord>;

  activity(): Promise<ActivityItem[]>;

  agentSessions(): Promise<AgentSession[]>;
  sendAgentMessage(sessionId: string | null, role: AgentRole, text: string): Promise<AgentSession>;
  policies(): Promise<CapabilityPolicy[]>;
  createPolicy(p: Omit<CapabilityPolicy, "address" | "vault" | "owner" | "epoch" | "spent" | "revoked" | "sessionKey">): Promise<CapabilityPolicy>;
  revokePolicy(address: string): Promise<void>;
  killSwitch(): Promise<void>;

  rooms(): Promise<RoomRecord[]>;
  room(slug: string): Promise<RoomRecord | null>;
  publishRoom(strategyId: string, thesis: string, risk: string[]): Promise<RoomRecord>;
  cloneRoom(slug: string, version: number): Promise<StrategyView>;

  ops(): Promise<OpsStatus>;

  /** local-validator development controls (undefined elsewhere): signed by localnet-only keys */
  dev?: {
    label: string;
    resolveEvent(eventKey: string, outcome: "YES" | "NO" | "VOID"): Promise<void>;
    disputeEvent(eventKey: string): Promise<void>;
    /** top the watched escrow account up to `units` (test tokens), then ask the program to observe it */
    observeBalance(eventKey: string, units: bigint): Promise<void>;
    setExecutionPaused(on: boolean): Promise<void>;
  };

  /** simulation-only controls (undefined elsewhere) */
  sim?: {
    resolveEvent(eventKey: string, outcome: "YES" | "NO" | "VOID"): Promise<void>;
    disputeEvent(eventKey: string): Promise<void>;
    observeBalance(eventKey: string, units: bigint): Promise<void>;
    advance(seconds: number): Promise<void>;
    setFailNext(on: boolean): Promise<void>;
    setExecutionPaused(on: boolean): Promise<void>;
    reset(): Promise<void>;
    clockOffset(): number;
    failNext(): boolean;
    executionPaused(): boolean;
  };
}
