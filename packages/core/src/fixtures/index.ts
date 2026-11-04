import { sha256Hex, simAddress } from "../hash.ts";
import type { AssetInfo } from "../assets.ts";
import type { EventRef } from "../schema.ts";
import type { CpPool, OutcomeMarketPool } from "../venue.ts";

/**
 * Deterministic sample data for the SIMULATION environment and the localnet
 * seed. Every market here is fictional and every quote is a deterministic
 * sample — the UI labels them as such. Nothing here claims to be live venue data.
 */

export const FIXTURE_LABEL = "Sample data — simulation";
const DAY = 86_400;

export interface AssetFixture extends Omit<AssetInfo, "mint" | "environment"> {
  key: string;
}

export const ASSET_FIXTURES: AssetFixture[] = [
  { key: "USDC", symbol: "USDC", name: "USD Coin (test mint)", decimals: 6, tokenProgram: "spl-token", extensions: [], freezeAuthority: true, kind: "stablecoin", priceE6: 1_000_000n, hue: 210, note: "Test mint standing in for USDC. Real USDC's issuer holds a freeze authority; this is disclosed." },
  { key: "MAYBE", symbol: "MAYBE", name: "MAYBE (configurable Pump token)", decimals: 6, tokenProgram: "token-2022", extensions: ["MetadataPointer", "TokenMetadata"], freezeAuthority: false, kind: "project-token", priceE6: 42_000n, hue: 84, note: "Stand-in for the project token launched through Pump.fun (create_v2 coins are Token-2022, 6 decimals, metadata pointer to the mint). MAYBE does not control its supply, curve or fees; the real mint's extensions are read at configuration time." },
  { key: "LUMEN", symbol: "LUMEN", name: "Lumen (sample asset)", decimals: 6, tokenProgram: "spl-token", extensions: [], freezeAuthority: false, kind: "asset", priceE6: 1_850_000n, hue: 265 },
  { key: "FERN", symbol: "FERN", name: "Fern (sample asset)", decimals: 6, tokenProgram: "spl-token", extensions: [], freezeAuthority: false, kind: "asset", priceE6: 370_000n, hue: 150 },
  { key: "KITE", symbol: "KITE", name: "Kite (sample asset, 9 decimals)", decimals: 9, tokenProgram: "spl-token", extensions: [], freezeAuthority: false, kind: "asset", priceE6: 12_400_000n, hue: 190 },
  { key: "MOSS", symbol: "MOSS", name: "Moss (sample asset, 5 decimals)", decimals: 5, tokenProgram: "spl-token", extensions: [], freezeAuthority: false, kind: "asset", priceE6: 6_100n, hue: 40 },
  { key: "YES-ORBIT", symbol: "YES·ORB", name: "Orbit launch — YES outcome token (local venue)", decimals: 6, tokenProgram: "spl-token", extensions: [], freezeAuthority: false, kind: "outcome-token", priceE6: 610_000n, hue: 300 },
  { key: "TAXED", symbol: "TAXD", name: "Taxed (Token-2022 with transfer fee)", decimals: 6, tokenProgram: "token-2022", extensions: ["TransferFeeConfig", "MetadataPointer", "TokenMetadata"], freezeAuthority: false, kind: "asset", priceE6: 500_000n, hue: 0, note: "Included to demonstrate that tokens with transfer fees are rejected." },
];

export type MarketKind = "binary" | "multi" | "scalar";
export type MarketStatus = "open" | "closed" | "resolved" | "voided" | "disputed";

export interface MarketFixture {
  key: string;
  venue: "maybe-local" | "solana";
  venueMarketId: string;
  title: string;
  category: "Governance" | "Crypto" | "Sports" | "Civic" | "Tech" | "Culture";
  kind: MarketKind;
  outcomes: string[];
  description: string;
  rules: string;
  resolutionSource: string;
  adapter: "attestation" | "balance-threshold";
  closesInDays: number;
  resolvesInDays: number;
  yesBps: number;
  spreadBps: number;
  depthUsd: number;
  status: MarketStatus;
  seed: number;
  balance?: { watched: string; thresholdUnits: bigint; mintKey: string };
}

export const MARKET_FIXTURES: MarketFixture[] = [
  {
    key: "orbit-launch",
    venue: "maybe-local",
    venueMarketId: "mbl-orbit-launch-q4",
    title: "Will the Orbit testnet relaunch ship before Dec 15?",
    category: "Tech",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "Resolves on the Orbit project's public release log.",
    rules:
      "Resolves YES if a public Orbit testnet release tagged 'relaunch' is published before 2026-12-15 00:00 UTC. Resolves NO otherwise. VOID if the project is discontinued before the deadline. Attested by the MAYBE local attestor set (development, trusted).",
    resolutionSource: "Orbit public release log (fictional)",
    adapter: "attestation",
    closesInDays: 38,
    resolvesInDays: 41,
    yesBps: 6100,
    spreadBps: 180,
    depthUsd: 48_000,
    status: "open",
    seed: 11,
  },
  {
    key: "treasury-prop",
    venue: "maybe-local",
    venueMarketId: "mbl-gov-prop-4",
    title: "Will community treasury proposal #4 pass?",
    category: "Governance",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "A fictional DAO vote on funding a public goods round.",
    rules: "Resolves YES if proposal #4 reaches quorum and a majority FOR when voting closes. NO otherwise. VOID if the vote is withdrawn.",
    resolutionSource: "Governance portal (fictional)",
    adapter: "attestation",
    closesInDays: 9,
    resolvesInDays: 10,
    yesBps: 7350,
    spreadBps: 120,
    depthUsd: 21_500,
    status: "open",
    seed: 23,
  },
  {
    key: "ravens-cup",
    venue: "maybe-local",
    venueMarketId: "mbl-winter-cup-final",
    title: "Will the Northside Ravens win the Winter Cup final?",
    category: "Sports",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "A fictional league final.",
    rules: "Resolves YES if the Ravens are declared winners of the final (including extra time and penalties). NO if they lose. VOID if the final is not played by Dec 20.",
    resolutionSource: "League results page (fictional)",
    adapter: "attestation",
    closesInDays: 16,
    resolvesInDays: 17,
    yesBps: 4450,
    spreadBps: 220,
    depthUsd: 63_000,
    status: "open",
    seed: 37,
  },
  {
    key: "night-transit",
    venue: "maybe-local",
    venueMarketId: "mbl-civic-night-transit",
    title: "Will the city approve the night-transit pilot this year?",
    category: "Civic",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "Council vote on a fictional city's overnight bus pilot.",
    rules: "Resolves YES if the council approves the pilot budget line before Dec 31. NO otherwise.",
    resolutionSource: "Council minutes (fictional)",
    adapter: "attestation",
    closesInDays: 50,
    resolvesInDays: 57,
    yesBps: 5200,
    spreadBps: 300,
    depthUsd: 9_800,
    status: "open",
    seed: 41,
  },
  {
    key: "fern-beta",
    venue: "maybe-local",
    venueMarketId: "mbl-fern-open-beta",
    title: "Will Studio Fern open its public beta in Q4?",
    category: "Tech",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "Fictional product milestone.",
    rules: "Resolves YES if a public beta sign-up opens to everyone before 2026-12-31 23:59 UTC. NO otherwise.",
    resolutionSource: "Studio Fern blog (fictional)",
    adapter: "attestation",
    closesInDays: 55,
    resolvesInDays: 58,
    yesBps: 6800,
    spreadBps: 160,
    depthUsd: 17_200,
    status: "open",
    seed: 53,
  },
  {
    key: "harbor-bridge",
    venue: "maybe-local",
    venueMarketId: "mbl-harbor-bridge",
    title: "Will Harbor Bridge reopen to traffic before New Year?",
    category: "Civic",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "Fictional infrastructure milestone.",
    rules: "Resolves YES if the bridge opens to general traffic before 2027-01-01 00:00 local time. NO otherwise.",
    resolutionSource: "Transport authority notices (fictional)",
    adapter: "attestation",
    closesInDays: 57,
    resolvesInDays: 58,
    yesBps: 3300,
    spreadBps: 260,
    depthUsd: 12_400,
    status: "open",
    seed: 67,
  },
  {
    key: "gallery-vote",
    venue: "maybe-local",
    venueMarketId: "mbl-culture-gallery",
    title: "Will the harbour gallery extend its winter exhibition?",
    category: "Culture",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "Fictional cultural decision, used as a veto event in templates.",
    rules: "Resolves YES if an extension is announced before Dec 10. NO otherwise.",
    resolutionSource: "Gallery announcements (fictional)",
    adapter: "attestation",
    closesInDays: 35,
    resolvesInDays: 36,
    yesBps: 2400,
    spreadBps: 200,
    depthUsd: 5_100,
    status: "open",
    seed: 71,
  },
  {
    key: "grants-escrow",
    venue: "solana",
    venueMarketId: "sol-balance-fern-grants",
    title: "Will the Fern grants escrow hold 50,000 USDC by Dec 1?",
    category: "Crypto",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "Objective on-chain event: read directly from a token account by the vault program.",
    rules:
      "Resolves YES the first time anyone submits an observation, at or before 2026-12-01 00:00 UTC, showing the watched USDC token account holds at least 50,000 USDC. Resolves NO automatically after the deadline. Balances can be inflated temporarily; see manipulation notes.",
    resolutionSource: "Solana token account (enforced on-chain)",
    adapter: "balance-threshold",
    closesInDays: 27,
    resolvesInDays: 27,
    yesBps: 5600,
    spreadBps: 0,
    depthUsd: 0,
    status: "open",
    seed: 83,
    balance: { watched: "fern-grants-escrow", thresholdUnits: 50_000_000_000n, mintKey: "USDC" },
  },
  {
    key: "winter-cup-winner",
    venue: "maybe-local",
    venueMarketId: "mbl-winter-cup-winner",
    title: "Who wins the Winter Cup? (4 teams)",
    category: "Sports",
    kind: "multi",
    outcomes: ["Ravens", "Harbor FC", "Lowlands", "Northgate"],
    description: "Multi-outcome market — shown for discovery, not usable as a trigger.",
    rules: "Resolves to the team declared winner of the final.",
    resolutionSource: "League results page (fictional)",
    adapter: "attestation",
    closesInDays: 16,
    resolvesInDays: 17,
    yesBps: 0,
    spreadBps: 0,
    depthUsd: 30_000,
    status: "open",
    seed: 89,
  },
  {
    key: "fern-launches",
    venue: "maybe-local",
    venueMarketId: "mbl-fern-launch-count",
    title: "How many launches will the Fern program fund? (scalar)",
    category: "Crypto",
    kind: "scalar",
    outcomes: ["0–100"],
    description: "Scalar market — shown for discovery, not usable as a trigger.",
    rules: "Resolves to the number of funded launches reported on Jan 15.",
    resolutionSource: "Program report (fictional)",
    adapter: "attestation",
    closesInDays: 70,
    resolvesInDays: 72,
    yesBps: 0,
    spreadBps: 0,
    depthUsd: 4_000,
    status: "open",
    seed: 97,
  },
  {
    key: "exhibition-match",
    venue: "maybe-local",
    venueMarketId: "mbl-exhibition-match",
    title: "Will the cancelled exhibition match finish? (voided)",
    category: "Sports",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "A market that was voided — shows how VOID is presented.",
    rules: "VOID if the match is not played. It was cancelled; the market is void.",
    resolutionSource: "League notices (fictional)",
    adapter: "attestation",
    closesInDays: -3,
    resolvesInDays: -2,
    yesBps: 5000,
    spreadBps: 0,
    depthUsd: 0,
    status: "voided",
    seed: 101,
  },
  {
    key: "data-center",
    venue: "maybe-local",
    venueMarketId: "mbl-tech-dc-permit",
    title: "Will the Lowlands data-center permit be granted?",
    category: "Tech",
    kind: "binary",
    outcomes: ["YES", "NO"],
    description: "Fictional permit decision.",
    rules: "Resolves YES if the permit is granted before Jan 20. NO if denied. VOID if the application is withdrawn.",
    resolutionSource: "Planning register (fictional)",
    adapter: "attestation",
    closesInDays: 74,
    resolvesInDays: 77,
    yesBps: 4100,
    spreadBps: 240,
    depthUsd: 8_600,
    status: "open",
    seed: 103,
  },
];

export const POOL_FIXTURES: Array<{ key: string; a: string; b: string; reserveAWhole: number; feeBps: number }> = [
  { key: "USDC-MAYBE", a: "USDC", b: "MAYBE", reserveAWhole: 250_000, feeBps: 30 },
  { key: "USDC-LUMEN", a: "USDC", b: "LUMEN", reserveAWhole: 400_000, feeBps: 30 },
  { key: "USDC-FERN", a: "USDC", b: "FERN", reserveAWhole: 300_000, feeBps: 30 },
  { key: "USDC-KITE", a: "USDC", b: "KITE", reserveAWhole: 600_000, feeBps: 30 },
  { key: "USDC-MOSS", a: "USDC", b: "MOSS", reserveAWhole: 150_000, feeBps: 30 },
];

export interface FixtureSet {
  environment: "simulation" | "localnet";
  assets: AssetInfo[];
  assetByKey: Record<string, AssetInfo>;
  markets: Array<MarketFixture & { eventKey: string; ruleHash: string; closesAt: number; resolvesBy: number }>;
  pools: CpPool[];
  poolByKey: Record<string, CpPool>;
  outcomeMarkets: OutcomeMarketPool[];
}

export interface AddressBook {
  asset(key: string): string;
  event(key: string): string;
  pool(key: string): string;
  outcomeMarket(key: string): string;
  watched(key: string): string;
}

export const simAddressBook: AddressBook = {
  asset: (k) => simAddress(`asset:${k}`),
  event: (k) => simAddress(`event:${k}`),
  pool: (k) => simAddress(`pool:${k}`),
  outcomeMarket: (k) => simAddress(`outcome:${k}`),
  watched: (k) => simAddress(`watched:${k}`),
};

export function ruleHashFor(m: Pick<MarketFixture, "venue" | "venueMarketId" | "rules">): string {
  return sha256Hex(`maybe.rules/1\n${m.venue}\n${m.venueMarketId}\n${m.rules}`);
}

/** Fixtures relative to `now` so the sample always looks current. */
export function buildFixtures(now: number, book: AddressBook = simAddressBook, environment: FixtureSet["environment"] = "simulation"): FixtureSet {
  const assets: AssetInfo[] = ASSET_FIXTURES.map(({ key, ...a }) => ({ ...a, mint: book.asset(key), environment, priceSource: FIXTURE_LABEL, priceAt: now }));
  const assetByKey: Record<string, AssetInfo> = {};
  ASSET_FIXTURES.forEach((f, i) => (assetByKey[f.key] = assets[i]!));
  const markets = MARKET_FIXTURES.map((m) => {
    const dayStart = Math.floor(now / 3600) * 3600;
    return {
      ...m,
      eventKey: book.event(m.key),
      ruleHash: ruleHashFor(m),
      closesAt: dayStart + m.closesInDays * DAY,
      resolvesBy: dayStart + m.resolvesInDays * DAY,
    };
  });
  const pools: CpPool[] = POOL_FIXTURES.map((p) => {
    const a = assetByKey[p.a]!;
    const b = assetByKey[p.b]!;
    const reserveA = BigInt(p.reserveAWhole) * 10n ** BigInt(a.decimals);
    // reserveB so that spot price matches the asset's sample price
    const reserveB = (BigInt(p.reserveAWhole) * 1_000_000n * 10n ** BigInt(b.decimals)) / b.priceE6!;
    return { address: book.pool(p.key), mintA: a.mint, mintB: b.mint, reserveA, reserveB, feeBps: p.feeBps };
  });
  const poolByKey: Record<string, CpPool> = {};
  POOL_FIXTURES.forEach((p, i) => (poolByKey[p.key] = pools[i]!));
  const orbit = markets.find((m) => m.key === "orbit-launch")!;
  const outcomeMarkets: OutcomeMarketPool[] = [
    {
      address: book.outcomeMarket("orbit-launch"),
      event: orbit.eventKey,
      collateralMint: assetByKey.USDC!.mint,
      yesMint: assetByKey["YES-ORBIT"]!.mint,
      yesPriceE6: 610_000n,
    },
  ];
  return { environment, assets, assetByKey, markets, pools, poolByKey, outcomeMarkets };
}

export function eventRefFor(m: FixtureSet["markets"][number], ref: string): EventRef {
  return {
    ref,
    eventKey: m.eventKey,
    venue: m.venue,
    venueMarketId: m.venueMarketId,
    ruleHash: m.ruleHash,
    title: m.title,
    adapter: m.adapter,
    closesAt: m.closesAt,
    resolvesBy: m.resolvesBy,
  };
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic sample price history (probability in bps) ending at `endBps`.
 * A random walk in logit space so it stays within (0, 1). Sample only.
 */
export function sampleHistory(seed: number, endBps: number, now: number, points = 120, spanDays = 30): Array<{ t: number; bps: number }> {
  const rnd = prng(seed);
  const logit = (p: number) => Math.log(p / (1 - p));
  const inv = (x: number) => 1 / (1 + Math.exp(-x));
  const end = Math.min(Math.max(endBps / 10_000, 0.02), 0.98);
  const steps: number[] = [];
  for (let i = 0; i < points; i++) steps.push((rnd() - 0.5) * 0.22 + (rnd() < 0.04 ? (rnd() - 0.5) * 0.9 : 0));
  // walk backwards from the end value
  const xs: number[] = new Array(points);
  xs[points - 1] = logit(end);
  for (let i = points - 2; i >= 0; i--) xs[i] = xs[i + 1]! - steps[i + 1]!;
  const start = now - spanDays * DAY;
  const dt = (spanDays * DAY) / (points - 1);
  return xs.map((x, i) => ({ t: Math.round(start + i * dt), bps: Math.round(inv(x) * 10_000) }));
}

/** Deterministic quote jitter for the simulated feed: returns bps for a given time bucket. */
export function sampleQuote(seed: number, baseBps: number, bucket: number): number {
  const rnd = prng(seed * 7919 + bucket);
  const drift = Math.round((rnd() - 0.5) * 60);
  return Math.min(9_900, Math.max(100, baseBps + drift));
}
