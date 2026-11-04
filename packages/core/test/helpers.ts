import {
  activateStrategy,
  buildFixtures,
  compileStrategy,
  deposit,
  emptyVault,
  SimVenue,
  templateById,
  type ChainContext,
  type EventView,
  type Strategy,
  type StrategyState,
  type TemplateEnv,
  type VaultState,
  type FixtureSet,
  type MarketCapability,
  type PoolCapability,
  type ValidationContext,
} from "../src/index.ts";

export const NOW = 1_793_000_000; // fixed clock: 2026-10-26T..Z
export const OWNER = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

export function fixtures(now = NOW): FixtureSet {
  return buildFixtures(now);
}

let n = 0;
export function env(now = NOW, f = fixtures(now)): TemplateEnv {
  return { now, fixtures: f, id: () => `test_${n++}`, nonce: () => String(1000 + n++), recipient: OWNER };
}

export function build(templateId: string, e = env()): Strategy {
  const t = templateById(templateId);
  if (!t) throw new Error(`no template ${templateId}`);
  return t.build(e);
}

export function validationContext(f: FixtureSet, now = NOW): ValidationContext {
  const assets = Object.fromEntries(f.assets.map((a) => [a.mint, a]));
  const markets: Record<string, MarketCapability> = {};
  for (const m of f.markets) {
    markets[m.eventKey] = {
      venue: m.venue,
      executable: m.kind === "binary",
      binary: m.kind === "binary",
      status: m.status,
      resolvesBy: m.resolvesBy,
    };
  }
  const pools: Record<string, PoolCapability> = {};
  for (const p of f.pools) pools[p.address] = { routeKinds: ["cp-swap"], mints: [p.mintA, p.mintB], executable: true };
  for (const o of f.outcomeMarkets) {
    pools[o.address] = { routeKinds: ["outcome-buy", "outcome-redeem"], mints: [o.collateralMint, o.yesMint], executable: true };
  }
  return { now, assets, markets, pools };
}

export function validationContextFor(_doc: Strategy, f: FixtureSet, now = NOW): ValidationContext {
  return validationContext(f, now);
}

export function fundedVault(perMint: Record<string, bigint>): VaultState {
  let v = emptyVault("vault-test", OWNER);
  for (const [m, a] of Object.entries(perMint)) v = deposit(v, m, a);
  return v;
}

export function activate(doc: Strategy, now = NOW, extraAvailable = 0n) {
  const c = compileStrategy(doc);
  const need: Record<string, bigint> = {};
  c.plan.allocations.forEach((a) => {
    const m = c.plan.mints[a.mint]!;
    need[m] = (need[m] ?? 0n) + a.amount + extraAvailable;
  });
  const vault = fundedVault(need);
  const r = activateStrategy(vault, c.bytes, { now, address: `strat-${doc.id}`, owner: OWNER });
  return { ...r, compiled: c };
}

export type EventSetting = { outcome: "YES" | "NO" | "VOID"; at: number; status?: "FINAL" | "PENDING" | "DISPUTED" } | "OPEN";

export function ctx(s: StrategyState, now: number, settings: Record<string, EventSetting>, extra: Partial<ChainContext> = {}): ChainContext {
  const events: Record<string, EventView> = {};
  s.plan.events.forEach((key, i) => {
    const ref = String.fromCharCode(65 + i);
    const st = settings[key] ?? settings[ref] ?? "OPEN";
    if (st === "OPEN") events[key] = { status: "OPEN", outcome: null, finalAt: null, adapter: "ATTESTATION" };
    else events[key] = { status: st.status ?? "FINAL", outcome: st.outcome, finalAt: st.at, adapter: "ATTESTATION" };
  });
  return { now, executionPaused: false, events, strategies: {}, ...extra };
}

/** Settings keyed by the document's own event refs (A, B, M1, V...). */
export function ctxByRef(doc: Strategy, s: StrategyState, now: number, byRef: Record<string, EventSetting>, extra: Partial<ChainContext> = {}): ChainContext {
  const settings: Record<string, EventSetting> = {};
  doc.events.forEach((e) => {
    if (byRef[e.ref]) settings[e.eventKey] = byRef[e.ref]!;
  });
  return ctx(s, now, settings, extra);
}

export function venueFor(f: FixtureSet, outcomes: Record<string, "YES" | "NO" | "VOID" | null> = {}, behaviour: SimVenue["behaviour"] = "honest") {
  return new SimVenue(
    {
      cp: Object.fromEntries(f.pools.map((p) => [p.address, { ...p }])),
      outcome: Object.fromEntries(f.outcomeMarkets.map((o) => [o.address, o])),
      eventOutcome: (e) => outcomes[e] ?? null,
    },
    behaviour,
  );
}
