import {
  actionReadiness,
  buildAuthorization,
  compileStrategy,
  effectiveEvent,
  formatAmount,
  guardTimes,
  nextWakeTime,
  planHash,
  sampleHistory,
  sampleQuote,
  simulatePlan,
  templateById,
  validateStrategy,
  ActionKind,
  type AssetInfo,
  type ChainContext,
  type DescribeLookup,
  type EventView,
  type FixtureSet,
  type Receipt,
  type Strategy,
  type StrategyLifecycleState,
  type StrategyState,
} from "@maybe/core";
import { capabilityContext } from "@maybe/agent";
import type { ActivityItem, Environment, MarketDetail, MarketSummary, Mode, OpsStatus, Prepared, RoomRecord, StrategyView, TxRecord, VenueCapability } from "./types.ts";

/**
 * Pure view builders. The browser simulation and the server assemble the same
 * shapes from the same functions, so what a screen shows can't drift between
 * environments; only where the state comes from differs.
 */

export const QUOTE_BUCKET_SECONDS = 5;
export const DAY = 86_400;
export type FixtureMarket = FixtureSet["markets"][number];

export function assetOf(fx: FixtureSet, mint: string): AssetInfo | undefined {
  return fx.assets.find((a) => a.mint === mint);
}

export function fmtUnits(fx: FixtureSet, mint: string, units: bigint): string {
  const a = assetOf(fx, mint);
  return a ? `${formatAmount(units, a.decimals, { minFraction: 0, maxFraction: Math.min(a.decimals, 4) })} ${a.symbol}` : `${units}`;
}

// ───────────────────────────────────────── environment

const POLYMARKET: VenueCapability = {
  id: "polymarket",
  label: "Polymarket",
  discovery: "unavailable",
  quotes: "unavailable",
  trading: "read-only",
  settlement: "Not enforceable on Solana without an attestation route",
  note: "Read-only discovery needs outbound network access to Polymarket's public API, which this environment doesn't have.",
};
const KALSHI: VenueCapability = {
  id: "kalshi",
  label: "Kalshi via DFlow",
  discovery: "unavailable",
  quotes: "unavailable",
  trading: "unavailable",
  settlement: "Not available",
  note: "Trading requires identity verification and is restricted by jurisdiction; vault-held positions are not supported.",
};

export function environmentInfo(mode: Mode, o: { vaultProgram?: string; network?: string; attestation?: Environment["attestation"] } = {}): Environment {
  if (mode === "simulation") {
    return {
      mode,
      label: "Simulation",
      description: "Everything runs in your browser on sample data and the real strategy engine. No chain, no real funds, no live venues.",
      network: "none — simulated ledger",
      executionLive: false,
      attestation: { threshold: 2, of: 3, challengeSeconds: 600, development: true },
      venues: [
        { id: "maybe-local", label: "MAYBE local settlement", discovery: "fixture", quotes: "sample", trading: "enabled", settlement: "Trusted attestation (development signers, simulated)", note: "Fictional markets resolved with the simulation controls." },
        { id: "solana", label: "Solana on-chain observation", discovery: "fixture", quotes: "unavailable", trading: "enabled", settlement: "Objective: token-account balance read by the vault program", note: "Balance-threshold events resolve from chain state." },
        POLYMARKET,
        KALSHI,
      ],
    };
  }
  return {
    mode,
    label: mode === "localnet" ? "Local validator" : "Devnet",
    description:
      mode === "localnet"
        ? "Real transactions against the MAYBE programs on a local Solana validator. Test tokens only; development attestors sign outcomes."
        : "Real transactions on Solana devnet. Devnet tokens have no value.",
    network: o.network ?? (mode === "localnet" ? "solana-test-validator (127.0.0.1)" : "Solana devnet"),
    executionLive: true,
    ...(o.vaultProgram ? { vaultProgram: o.vaultProgram } : {}),
    ...(o.attestation ? { attestation: o.attestation } : {}),
    venues: [
      { id: "maybe-local", label: "MAYBE local settlement", discovery: "fixture", quotes: "sample", trading: "enabled", settlement: "Trusted attestation: 2 of 3 development signers (localnet keys)", note: "Fictional markets. Swaps run through the local test venue program; outcomes are signed by development attestors." },
      { id: "solana", label: "Solana on-chain observation", discovery: "fixture", quotes: "unavailable", trading: "enabled", settlement: "Objective: token-account balance read by the vault program", note: "Balance-threshold events resolve from a watched token account on this validator." },
      POLYMARKET,
      KALSHI,
    ],
  };
}

// ───────────────────────────────────────── markets

export function trustText(m: FixtureMarket, mode: Mode): string {
  if (m.adapter !== "attestation") return "Objective · read on-chain by the vault program";
  return mode === "simulation" ? "Trusted attestation · 2 of 3 development signers" : "Trusted attestation · 2 of 3 development signers (localnet keys)";
}

export function defaultEventView(m: FixtureMarket, at: number): EventView {
  if (m.status === "voided") return { status: "FINAL", outcome: "VOID", finalAt: at - 2 * DAY, adapter: "ATTESTATION" };
  if (m.adapter === "balance-threshold") return { status: "OPEN", outcome: null, finalAt: null, adapter: "BALANCE", deadline: m.resolvesBy };
  return { status: "OPEN", outcome: null, finalAt: null, adapter: "ATTESTATION" };
}

export function marketSummary(m: FixtureMarket, ev: EventView | undefined, now: number, mode: Mode): MarketSummary {
  const bucket = Math.floor(now / QUOTE_BUCKET_SECONDS);
  const view = ev ?? { status: "OPEN", outcome: null, finalAt: null, adapter: m.adapter === "balance-threshold" ? "BALANCE" : "ATTESTATION" };
  const eff = effectiveEvent(view, now);
  const quoted = m.kind === "binary" && m.status === "open" && !eff.final && m.adapter === "attestation";
  const yes = quoted ? sampleQuote(m.seed, m.yesBps, bucket) : m.yesBps;
  const status: MarketSummary["status"] = eff.final ? (eff.outcome === "VOID" ? "voided" : "resolved") : view.status === "DISPUTED" ? "disputed" : now >= m.closesAt ? "closed" : m.status;
  const compatible =
    m.kind !== "binary"
      ? { ok: false, reason: `${m.kind === "multi" ? "Multi-outcome" : "Scalar"} markets can't trigger funded actions yet` }
      : status === "resolved" || status === "voided"
        ? { ok: false, reason: `Already ${status}` }
        : { ok: true };
  return {
    key: m.key,
    eventKey: m.eventKey,
    venue: m.venue,
    venueMarketId: m.venueMarketId,
    title: m.title,
    category: m.category,
    kind: m.kind,
    outcomes: m.outcomes,
    status,
    closesAt: m.closesAt,
    resolvesBy: m.resolvesBy,
    quote: quoted
      ? {
          yesBps: yes,
          noBps: 10_000 - yes,
          spreadBps: m.spreadBps,
          asOf: bucket * QUOTE_BUCKET_SECONDS,
          source: mode === "simulation" ? "Sample quote (deterministic, simulation)" : "Sample quote (deterministic fixture; no live venue here)",
          sample: true,
        }
      : null,
    depthUsd: m.depthUsd,
    adapter: m.adapter,
    trust: trustText(m, mode),
    compatible,
    resolution: view,
  };
}

/** Which steps of which futures depend on this market. */
export function marketExposure(m: FixtureMarket, strategies: Array<{ id: string; doc: Strategy; status: StrategyLifecycleState }>): MarketDetail["exposure"] {
  return strategies
    .filter((st) => st.doc.events.some((e) => e.eventKey === m.eventKey))
    .map((st) => ({
      strategyId: st.id,
      title: st.doc.title,
      status: st.status,
      steps: st.doc.actions
        .filter((a) => {
          const ref = st.doc.events.find((e) => e.eventKey === m.eventKey)?.ref;
          const guard = st.doc.nodes.find((n) => n.id === a.guard);
          return ref && JSON.stringify(guard ?? {}).includes(`"${ref}"`);
        })
        .map((a) => a.label ?? a.id),
    }));
}

export function marketDetail(m: FixtureMarket, s: MarketSummary, o: { historyFrom: number; exposure: MarketDetail["exposure"]; watched?: string; fx: FixtureSet }): MarketDetail {
  return {
    ...s,
    description: m.description,
    rules: m.rules,
    ruleHash: m.ruleHash,
    resolutionSource: m.resolutionSource,
    history: m.kind === "binary" ? [...sampleHistory(m.seed, m.yesBps, o.historyFrom), ...(s.quote ? [{ t: s.quote.asOf, bps: s.quote.yesBps }] : [])] : [],
    exposure: o.exposure,
    ...(m.balance && o.watched ? { balance: { watched: o.watched, threshold: m.balance.thresholdUnits, mint: o.fx.assetByKey[m.balance.mintKey]!.mint } } : {}),
  };
}

// ───────────────────────────────────────── strategies

export interface StrategyRecord {
  id: string;
  doc: Strategy;
  status: StrategyLifecycleState;
  createdAt: number;
  updatedAt: number;
  sample?: boolean;
  bytes?: Uint8Array;
  hash?: string;
  signedAt?: number;
  runtime?: StrategyState;
  receipts: Receipt[];
  pendingTx?: TxRecord[];
  lastError?: string;
}

export function strategyView(s: StrategyRecord, ctx: ChainContext): StrategyView {
  const rt = s.runtime;
  const times = rt ? guardTimes(rt, ctx) : [];
  return {
    id: s.id,
    title: s.doc.title,
    status: s.status,
    doc: s.doc,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(s.sample ? { sample: true } : {}),
    ...(s.hash && s.bytes ? { authorization: { hash: s.hash, size: s.bytes.length, ...(s.signedAt ? { signedAt: s.signedAt } : {}) } } : {}),
    ...(s.pendingTx ? { pendingTx: s.pendingTx.map((t) => ({ ...t })) } : {}),
    ...(rt ? { runtime: rt } : {}),
    receipts: s.receipts,
    readiness: rt ? rt.plan.actions.map((_, i) => actionReadiness(rt, i, ctx, times)) : [],
    ...(rt && (s.status === "ACTIVE" || s.status === "PAUSED") ? { nextWake: nextWakeTime(rt, ctx) } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
  };
}

export function describeLookup(fx: FixtureSet, o: { mode: Mode; wallet?: string; strategies: Array<{ address?: string; title: string }> }): DescribeLookup {
  return {
    event: (k) => {
      const m = fx.markets.find((x) => x.eventKey === k);
      if (!m) return undefined;
      const trust = m.adapter !== "attestation" ? "objective, read on-chain" : o.mode === "simulation" ? "trusted attestation, 2 of 3 development signers" : "trusted attestation, 2 of 3 development signers (localnet keys)";
      return { title: m.title, venue: m.venue === "maybe-local" ? "MAYBE local settlement" : "Solana on-chain", trust, ruleHash: m.ruleHash };
    },
    asset: (m) => assetOf(fx, m),
    ref: (r) => {
      const p = fx.pools.find((x) => x.address === r);
      if (p) return { label: `${assetOf(fx, p.mintA)?.symbol}/${assetOf(fx, p.mintB)?.symbol} local pool`, kind: "pool" };
      const om = fx.outcomeMarkets.find((x) => x.address === r);
      if (om) return { label: "Orbit outcome market (local venue)", kind: "market" };
      if (o.wallet && r === o.wallet) return { label: "your wallet", kind: "recipient" };
      const st = o.strategies.find((x) => x.address === r);
      if (st) return { label: `“${st.title}”`, kind: "strategy" };
      return undefined;
    },
  };
}

/** Validate → compile → simulate → describe: everything the review screen needs, for the exact bytes to be signed. */
export function prepareStrategy(doc: Strategy, o: { fx: FixtureSet; now: number; available?: Record<string, bigint>; lookup: DescribeLookup; environment: string }): Prepared {
  const v = validateStrategy(doc, capabilityContext(o.fx, o.now, o.available));
  if (!v.compiled) return { ok: false, issues: v.issues };
  const refs = v.compiled.sourceMap.events;
  const report = simulatePlan(v.compiled.plan, { start: o.now }, refs);
  const authorization = buildAuthorization(
    v.compiled.bytes,
    o.lookup,
    report,
    { events: refs, actions: doc.actions.map((a) => a.label), allocations: doc.allocations.map((a) => a.label) },
    { now: o.now, environment: o.environment },
  );
  return { ok: v.ok, issues: v.issues, hash: v.compiled.hash, bytes: v.compiled.bytes, plan: v.compiled.plan, sourceMap: v.compiled.sourceMap, report, authorization };
}

/** Status a saved draft gets from validation alone (no balances: funding is checked at review). */
export function draftStatus(doc: Strategy, fx: FixtureSet, now: number): StrategyLifecycleState {
  return validateStrategy(doc, capabilityContext(fx, now)).ok ? "READY" : "INVALID";
}

export function opsJobsFromReadiness(strategies: StrategyRecord[], ctx: ChainContext): OpsStatus["jobs"] {
  return strategies.flatMap((s) =>
    s.runtime && (s.status === "ACTIVE" || s.status === "PAUSED")
      ? s.runtime.plan.actions.map((_, i) => {
          const r = actionReadiness(s.runtime!, i, ctx);
          return {
            id: `${s.id}:${i}`,
            kind: `execute “${s.doc.actions[i]?.label ?? `step ${i + 1}`}”`,
            state: r.state === "executable" ? "queued" : r.state === "scheduled" ? "scheduled" : r.state === "blocked" ? "blocked" : r.state === "waiting" ? "waiting" : "done",
            attempts: 0,
            runAt: r.state === "scheduled" ? r.at : ctx.now,
            ...(r.state === "blocked" ? { lastError: r.reason } : {}),
          };
        })
      : [],
  ).filter((j) => j.state !== "done");
}

/** Activity entry for an execution receipt. */
export function receiptActivity(fx: FixtureSet, rc: Receipt, o: { label: string; title: string; strategyId: string }): Omit<ActivityItem, "id" | "at" | "tx"> {
  const f = (m: string, u: bigint) => fmtUnits(fx, m, u);
  return {
    kind: rc.kind === ActionKind.RELEASE ? "release" : "execute",
    title:
      rc.kind === ActionKind.SWAP
        ? `${o.label}: ${f(rc.inMint, rc.amountIn)} → ${f(rc.outMint!, rc.amountOut)}`
        : rc.kind === ActionKind.TRANSFER
          ? `${o.label}: sent ${f(rc.inMint, rc.amountOut)}`
          : `${o.label}: ${f(rc.inMint, rc.amountOut)} back to available`,
    detail: `${o.title} · run ${rc.run + 1}${rc.fee > 0n ? ` · fee ${f(rc.inMint, rc.fee)}` : ""}${rc.skippedRuns ? ` · ${rc.skippedRuns} missed run(s) skipped` : ""}`,
    actor: "keeper",
    strategyId: o.strategyId,
    amounts:
      rc.kind === ActionKind.SWAP
        ? [
            { mint: rc.inMint, units: rc.amount, dir: "out" },
            { mint: rc.outMint!, units: rc.amountOut, dir: "in" },
          ]
        : [{ mint: rc.inMint, units: rc.amount, dir: rc.kind === ActionKind.RELEASE ? "move" : "out" }],
  };
}

// ───────────────────────────────────────── rooms

export function roomSlug(title: string, n: number | string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40)}-${n}`;
}

/** Clearly labelled sample rooms (paper records, no live results). */
export function sampleRooms(fx: FixtureSet, at: number): RoomRecord[] {
  let n = 0;
  const env = { now: at - 4 * DAY, fixtures: fx, id: () => `room_${n++}`, nonce: () => String(42_000 + n++) };
  const build = (id: string) => {
    const doc = templateById(id)!.build(env);
    return { doc, hash: planHash(compileStrategy(doc).bytes) };
  };
  const milestones = build("milestones");
  const veto = build("veto-window");
  const both = build("both-yes");
  const veto24 = { ...veto.doc, nodes: veto.doc.nodes.map((nd) => (nd.kind === "veto" ? { ...nd, windowSeconds: DAY } : nd)) };
  return [
    {
      id: "room_sample_1",
      slug: "fern-milestones",
      title: "Scale into Fern on milestones",
      author: "sample author",
      createdAt: at - 4 * DAY,
      sample: true,
      versions: [{ version: 1, publishedAt: at - 4 * DAY, doc: milestones.doc, hash: milestones.hash, thesis: "Fern is only worth owning once each milestone is real. Tranches unlock in order and never early.", risk: ["Concentrated in one sample asset", "Milestone markets resolve by trusted attestation", "Unreached tranches refund at expiry; executed tranches carry price risk"] }],
      record: { kind: "paper", note: "Sample paper simulation — illustrative only, not real results.", outcomes: [{ label: "Tranche 1 (proposal passes)", result: "open", detail: "Waiting on the treasury vote" }] },
      copies: 0,
    },
    {
      id: "room_sample_2",
      slug: "orbit-unless-vetoed",
      title: "Orbit ships — unless the gallery extends",
      author: "sample author",
      createdAt: at - 9 * DAY,
      sample: true,
      versions: [
        { version: 1, publishedAt: at - 9 * DAY, doc: veto24, hash: planHash(compileStrategy(veto24).bytes), thesis: "Act on Orbit, but give a competing announcement a day to land first.", risk: ["Veto window is 24h", "Trusted attestation"] },
        { version: 2, publishedAt: at - 3 * DAY, doc: veto.doc, hash: veto.hash, thesis: "Widened the veto window to 48h after feedback.", risk: ["Veto window is 48h", "Trusted attestation"] },
      ],
      record: {
        kind: "paper",
        note: "Sample paper simulation — illustrative only, not real results.",
        outcomes: [
          { label: "Earlier sample run", result: "lost", detail: "Bought MAYBE; price fell 18% after the trigger (paper)" },
          { label: "Earlier sample run", result: "refunded", detail: "Vetoed inside the window; nothing bought" },
        ],
      },
      copies: 0,
    },
    {
      id: "room_sample_3",
      slug: "beta-and-bridge",
      title: "Beta and bridge, or nothing",
      author: "sample author",
      createdAt: at - 2 * DAY,
      sample: true,
      versions: [{ version: 1, publishedAt: at - 2 * DAY, doc: both.doc, hash: both.hash, thesis: "Two independent things must both happen.", risk: ["Both events must resolve YES", "Refunds immediately when either resolves otherwise"] }],
      record: { kind: "none", note: "No track record.", outcomes: [] },
      copies: 0,
    },
  ];
}

/** A copy of a published version: a fresh, independent draft that needs its owner's own signature. */
export function cloneRoomDoc(r: RoomRecord, version: number, o: { id: string; nonce: string; now: number }): Strategy {
  const v = r.versions.find((x) => x.version === version);
  if (!v) throw new Error("Unknown room version.");
  return { ...structuredClone(v.doc), id: o.id, version: 1, nonce: o.nonce, expiresAt: Math.max(v.doc.expiresAt, o.now + 7 * DAY), meta: { source: "room-clone", roomId: r.id, roomVersion: v.version } };
}
