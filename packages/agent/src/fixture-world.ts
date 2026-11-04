import {
  buildFixtures,
  eventRefFor,
  formatAmount,
  simulatePlan,
  validateStrategy,
  type CapabilityPolicy,
  type FixtureSet,
  type MarketCapability,
  type PoolCapability,
  type Strategy,
  type ValidationContext,
} from "@maybe/core";
import type { AgentMarket, AgentStrategySummary, AgentWorld } from "./world.ts";

export function capabilityContext(f: FixtureSet, now: number, available?: Record<string, bigint>): ValidationContext {
  const assets = Object.fromEntries(f.assets.map((a) => [a.mint, a]));
  const markets: Record<string, MarketCapability> = {};
  for (const m of f.markets) {
    markets[m.eventKey] = {
      venue: m.venue,
      executable: m.kind === "binary",
      ...(m.kind !== "binary" ? { reason: "only binary markets can trigger funded actions" } : {}),
      binary: m.kind === "binary",
      status: m.status,
      resolvesBy: m.resolvesBy,
    };
  }
  const pools: Record<string, PoolCapability> = {};
  for (const p of f.pools) pools[p.address] = { routeKinds: ["cp-swap"], mints: [p.mintA, p.mintB], executable: true };
  for (const o of f.outcomeMarkets) pools[o.address] = { routeKinds: ["outcome-buy", "outcome-redeem"], mints: [o.collateralMint, o.yesMint], executable: true };
  return { now, assets, markets, pools, ...(available ? { availableByMint: available } : {}) };
}

/** An AgentWorld over the fixture set — used by tests and by the in-browser simulation backend. */
export function fixtureWorld(
  now: () => number,
  opts: { fixtures?: FixtureSet; strategies?: () => AgentStrategySummary[]; policies?: () => CapabilityPolicy[]; epoch?: () => number; available?: () => Record<string, bigint> } = {},
): AgentWorld {
  const f = opts.fixtures ?? buildFixtures(now());
  return {
    now,
    fixtures: () => f,
    markets: (): AgentMarket[] =>
      f.markets.map((m) => ({
        key: m.key,
        eventKey: m.eventKey,
        title: m.title,
        venue: m.venue,
        category: m.category,
        kind: m.kind,
        status: m.status,
        closesAt: m.closesAt,
        resolvesBy: m.resolvesBy,
        executable: m.kind === "binary" && m.status === "open",
        ...(m.kind !== "binary" ? { reason: `${m.kind} markets are not supported as triggers` } : m.status !== "open" ? { reason: `market is ${m.status}` } : {}),
        rules: m.rules,
        description: m.description,
        ...(m.kind === "binary" ? { yesBps: m.yesBps } : {}),
      })),
    eventRef: (key, ref) => {
      const m = f.markets.find((x) => x.key === key);
      return m ? eventRefFor(m, ref) : null;
    },
    validate: (doc: Strategy) => validateStrategy(doc, capabilityContext(f, now(), opts.available?.())),
    simulate: (plan, refs) => simulatePlan(plan, { start: now() }, refs),
    strategies: () => opts.strategies?.() ?? [],
    policies: () => opts.policies?.() ?? [],
    vaultEpoch: () => opts.epoch?.() ?? 0,
    fmt: (mint, units) => {
      const a = f.assets.find((x) => x.mint === mint);
      return a ? `${formatAmount(units, a.decimals, { minFraction: 0 })} ${a.symbol}` : units.toString();
    },
  };
}
