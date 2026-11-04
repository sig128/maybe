import type { Action, AmountSpec, EventRef, PredicateNode, Strategy } from "./schema.ts";
import { eventRefFor, type FixtureSet } from "./fixtures/index.ts";
import { cpQuote } from "./venue.ts";

/**
 * Strategy templates. Each one produces an ordinary strategy document; all of
 * them compile to the same plan language and run through the same engine and
 * vault program. Defaults come from the active environment's fixtures.
 */

export interface TemplateEnv {
  now: number;
  fixtures: FixtureSet;
  /** strategy id + nonce generators (deterministic in tests) */
  id?: () => string;
  nonce?: () => string;
  /** slippage tolerance used for default minimum-received (bps) */
  slippageBps?: number;
  /** address of the user's vault owner, used by the payment templates as a default recipient example */
  recipient?: string;
  /** predecessor strategy for the dependent template */
  predecessor?: { strategy: string; actionIndex: number; title: string };
}

export interface TemplateInfo {
  id: string;
  title: string;
  summary: string;
  category: "Basics" | "Branching" | "Thresholds" | "Timing" | "Proceeds" | "Payments";
  /** how many events the template needs */
  events: number;
  build(env: TemplateEnv): Strategy;
}

const DAY = 86_400;
let counter = 0;
const defaultId = () => `fut_${Date.now().toString(36)}${(counter++).toString(36)}`;
const defaultNonce = () => String(Math.floor(Math.random() * 2 ** 48));

function usd(env: TemplateEnv, whole: number): string {
  const d = env.fixtures.assetByKey.USDC!.decimals;
  return (BigInt(Math.round(whole * 100)) * 10n ** BigInt(d - 2)).toString();
}

function market(env: TemplateEnv, key: string, ref: string): EventRef {
  const m = env.fixtures.markets.find((x) => x.key === key);
  if (!m) throw new Error(`fixture market ${key} missing`);
  return eventRefFor(m, ref);
}

function pool(env: TemplateEnv, key: string) {
  const p = env.fixtures.poolByKey[key];
  if (!p) throw new Error(`fixture pool ${key} missing`);
  return p;
}

/** Default minimum received: quote minus slippage tolerance, for a fixed input amount. */
function minOutFor(env: TemplateEnv, poolKey: string, inKey: string, amountIn: string, feeBps: number): string {
  const p = pool(env, poolKey);
  const inMint = env.fixtures.assetByKey[inKey]!.mint;
  const afterFee = (BigInt(amountIn) * BigInt(10_000 - feeBps)) / 10_000n;
  const q = cpQuote(p, inMint, afterFee);
  const slip = BigInt(env.slippageBps ?? 100);
  const v = (q * (10_000n - slip)) / 10_000n;
  return (v > 0n ? v : 1n).toString();
}

/** Limit price expressed as output base units per input base unit x1e9, minus slippage. */
function rateFor(env: TemplateEnv, poolKey: string, inKey: string, slippageBps?: number): string {
  const p = pool(env, poolKey);
  const inMint = env.fixtures.assetByKey[inKey]!.mint;
  const probe = 10n ** BigInt(env.fixtures.assetByKey[inKey]!.decimals); // 1 whole token
  const q = cpQuote(p, inMint, probe);
  const slip = BigInt(slippageBps ?? env.slippageBps ?? 100);
  const rate = (q * 1_000_000_000n * (10_000n - slip)) / (probe * 10_000n);
  return (rate > 0n ? rate : 1n).toString();
}

function swap(
  env: TemplateEnv,
  o: {
    id: string;
    label: string;
    allocation: string;
    guard: string;
    from: string;
    to: string;
    poolKey: string;
    amount: AmountSpec;
    minOut?: Action extends infer _ ? { kind: "absolute"; amount: string } | { kind: "rate"; outPerInE9: string } : never;
    feeBps?: number;
    branch?: { group: string; branch: string };
    delaySeconds?: number;
    deadline?: number;
    schedule?: { runs: number; intervalSeconds: number; missed: "skip" | "catchUp" };
  },
): Action {
  const feeBps = o.feeBps ?? 30;
  const fromMint = env.fixtures.assetByKey[o.from]!.mint;
  const toMint = env.fixtures.assetByKey[o.to]!.mint;
  const minOut =
    o.minOut ??
    (o.amount.kind === "fixed"
      ? { kind: "absolute" as const, amount: minOutFor(env, o.poolKey, o.from, o.amount.amount, feeBps) }
      : { kind: "rate" as const, outPerInE9: rateFor(env, o.poolKey, o.from) });
  return {
    kind: "swap",
    id: o.id,
    label: o.label,
    allocation: o.allocation,
    guard: o.guard,
    inputMint: fromMint,
    outputMint: toMint,
    amount: o.amount,
    minOut,
    route: { kind: "cp-swap", pool: pool(env, o.poolKey).address },
    feeBps,
    delaySeconds: o.delaySeconds ?? 0,
    ...(o.branch ? { branch: o.branch } : {}),
    ...(o.deadline ? { deadline: o.deadline } : {}),
    ...(o.schedule ? { schedule: o.schedule } : {}),
  };
}

function releaseAll(env: TemplateEnv, id: string, allocation: string, guard: string, key = "USDC", label = "Return the allocation"): Action {
  return {
    kind: "release",
    id,
    label,
    allocation,
    guard,
    mint: env.fixtures.assetByKey[key]!.mint,
    amount: { kind: "bpsOfAllocation", bps: 10_000 },
    delaySeconds: 0,
  };
}

function base(env: TemplateEnv, o: { title: string; thesis: string; template: string; days: number; events: EventRef[]; allocations: Strategy["allocations"]; nodes: PredicateNode[]; actions: Action[]; cancelPolicy?: Strategy["cancelPolicy"] }): Strategy {
  return {
    schema: "maybe.strategy/1",
    id: (env.id ?? defaultId)(),
    version: 1,
    title: o.title,
    thesis: o.thesis,
    nonce: (env.nonce ?? defaultNonce)(),
    expiresAt: Math.floor(env.now / 3600) * 3600 + o.days * DAY,
    maxFeeBps: 30,
    voidPolicy: "void-is-false",
    cancelPolicy: o.cancelPolicy ?? "anytime",
    events: o.events,
    allocations: o.allocations,
    nodes: o.nodes,
    actions: o.actions,
    meta: { source: "template", template: o.template },
  };
}

const usdcAlloc = (env: TemplateEnv, id: string, label: string, whole: number) => ({ id, label, mint: env.fixtures.assetByKey.USDC!.mint, amount: usd(env, whole) });

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "yes-buys-token",
    title: "YES buys the MAYBE token",
    summary: "If the event resolves YES, buy the project token. If NO, the allocation comes back immediately.",
    category: "Basics",
    events: 1,
    build: (env) =>
      base(env, {
        title: "Orbit ships → buy MAYBE",
        thesis: "If Orbit relaunches on time, I want exposure to MAYBE.",
        template: "yes-buys-token",
        days: 45,
        events: [market(env, "orbit-launch", "A")],
        allocations: [usdcAlloc(env, "main", "Orbit bet", 100)],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "aNo", kind: "outcome", event: "A", outcome: "NO" },
        ],
        actions: [
          swap(env, { id: "buy", label: "Buy MAYBE", allocation: "main", guard: "aYes", from: "USDC", to: "MAYBE", poolKey: "USDC-MAYBE", amount: { kind: "fixed", amount: usd(env, 100) } }),
          releaseAll(env, "refund", "main", "aNo", "USDC", "Return unspent funds"),
        ],
      }),
  },
  {
    id: "yes-a-no-b",
    title: "YES → portfolio A, NO → portfolio B",
    summary: "One reservation, two mutually exclusive portfolios. Only the branch that wins can spend it.",
    category: "Branching",
    events: 1,
    build: (env) =>
      base(env, {
        title: "Treasury vote: two portfolios",
        thesis: "A passing vote favours Lumen/Fern; a failed vote favours Kite.",
        template: "yes-a-no-b",
        days: 20,
        events: [market(env, "treasury-prop", "A")],
        allocations: [usdcAlloc(env, "pot", "Vote reservation", 300)],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "aNo", kind: "outcome", event: "A", outcome: "NO" },
        ],
        actions: [
          swap(env, { id: "yesLumen", label: "Portfolio A · Lumen 60%", allocation: "pot", guard: "aYes", from: "USDC", to: "LUMEN", poolKey: "USDC-LUMEN", amount: { kind: "bpsOfAllocation", bps: 6000 }, branch: { group: "vote", branch: "yes" } }),
          swap(env, { id: "yesFern", label: "Portfolio A · Fern 40%", allocation: "pot", guard: "aYes", from: "USDC", to: "FERN", poolKey: "USDC-FERN", amount: { kind: "bpsOfAllocation", bps: 4000 }, branch: { group: "vote", branch: "yes" } }),
          swap(env, { id: "noKite", label: "Portfolio B · Kite 100%", allocation: "pot", guard: "aNo", from: "USDC", to: "KITE", poolKey: "USDC-KITE", amount: { kind: "bpsOfAllocation", bps: 10_000 }, branch: { group: "vote", branch: "no" } }),
        ],
      }),
  },
  {
    id: "both-yes",
    title: "Both events must resolve YES",
    summary: "Deploy only when two independent events both resolve YES.",
    category: "Thresholds",
    events: 2,
    build: (env) =>
      base(env, {
        title: "Beta and bridge → buy Fern",
        thesis: "Fern benefits only if its beta ships and the bridge reopens.",
        template: "both-yes",
        days: 62,
        events: [market(env, "fern-beta", "A"), market(env, "harbor-bridge", "B")],
        allocations: [usdcAlloc(env, "main", "Joint condition", 150)],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "bYes", kind: "outcome", event: "B", outcome: "YES" },
          { id: "both", kind: "and", children: ["aYes", "bYes"] },
          { id: "notBoth", kind: "not", child: "both" },
        ],
        actions: [
          swap(env, { id: "buy", label: "Buy Fern", allocation: "main", guard: "both", from: "USDC", to: "FERN", poolKey: "USDC-FERN", amount: { kind: "fixed", amount: usd(env, 150) } }),
          releaseAll(env, "refund", "main", "notBoth", "USDC", "Return when either resolves otherwise"),
        ],
      }),
  },
  {
    id: "three-of-five",
    title: "At least 3 of 5 predictions",
    summary: "Deploy when at least three of five selected predictions resolve as chosen.",
    category: "Thresholds",
    events: 5,
    build: (env) =>
      base(env, {
        title: "3 of 5 civic & tech calls",
        thesis: "If most of my calls land, the thesis is working — buy Lumen.",
        template: "three-of-five",
        days: 80,
        events: [
          market(env, "orbit-launch", "A"),
          market(env, "treasury-prop", "B"),
          market(env, "night-transit", "C"),
          market(env, "fern-beta", "D"),
          market(env, "data-center", "E"),
        ],
        allocations: [usdcAlloc(env, "main", "Consensus", 250)],
        nodes: [
          { id: "a", kind: "outcome", event: "A", outcome: "YES" },
          { id: "b", kind: "outcome", event: "B", outcome: "YES" },
          { id: "c", kind: "outcome", event: "C", outcome: "NO" },
          { id: "d", kind: "outcome", event: "D", outcome: "YES" },
          { id: "e", kind: "outcome", event: "E", outcome: "YES" },
          { id: "three", kind: "atLeast", k: 3, children: ["a", "b", "c", "d", "e"] },
          { id: "failed", kind: "not", child: "three" },
        ],
        actions: [
          swap(env, { id: "buy", label: "Buy Lumen", allocation: "main", guard: "three", from: "USDC", to: "LUMEN", poolKey: "USDC-LUMEN", amount: { kind: "fixed", amount: usd(env, 250) } }),
          releaseAll(env, "refund", "main", "failed", "USDC", "Return once 3 of 5 is impossible"),
        ],
      }),
  },
  {
    id: "veto-window",
    title: "Trigger unless vetoed in time",
    summary: "Buy when the trigger resolves YES, unless the veto event has already finalized YES within the evaluation window.",
    category: "Timing",
    events: 2,
    build: (env) =>
      base(env, {
        title: "Orbit ships, unless the gallery extends",
        thesis: "A gallery extension would pull attention; give it 48h to finalize before acting.",
        template: "veto-window",
        days: 50,
        events: [market(env, "orbit-launch", "A"), market(env, "gallery-vote", "V")],
        allocations: [usdcAlloc(env, "main", "Vetoable", 120)],
        nodes: [
          { id: "trigger", kind: "outcome", event: "A", outcome: "YES" },
          { id: "noVeto", kind: "veto", event: "V", outcome: "YES", trigger: "trigger", windowSeconds: 2 * DAY },
          { id: "go", kind: "and", children: ["trigger", "noVeto"] },
          { id: "stop", kind: "not", child: "go" },
        ],
        actions: [
          swap(env, { id: "buy", label: "Buy MAYBE", allocation: "main", guard: "go", from: "USDC", to: "MAYBE", poolKey: "USDC-MAYBE", amount: { kind: "fixed", amount: usd(env, 120) } }),
          releaseAll(env, "refund", "main", "stop", "USDC", "Return if vetoed or not triggered"),
        ],
      }),
  },
  {
    id: "milestones",
    title: "Deploy 20% → 30% → 50% on milestones",
    summary: "Each milestone unlocks the next tranche; tranches never unlock out of order.",
    category: "Timing",
    events: 3,
    build: (env) =>
      base(env, {
        title: "Fern milestones",
        thesis: "Scale into Fern as each milestone lands.",
        template: "milestones",
        days: 62,
        events: [market(env, "treasury-prop", "M1"), market(env, "fern-beta", "M2"), market(env, "harbor-bridge", "M3")],
        allocations: [usdcAlloc(env, "main", "Milestone budget", 500)],
        nodes: [
          { id: "m1", kind: "outcome", event: "M1", outcome: "YES" },
          { id: "m2", kind: "outcome", event: "M2", outcome: "YES" },
          { id: "m3", kind: "outcome", event: "M3", outcome: "YES" },
          { id: "m12", kind: "and", children: ["m1", "m2"] },
          { id: "m123", kind: "and", children: ["m1", "m2", "m3"] },
        ],
        actions: [
          swap(env, { id: "t1", label: "Tranche 1 · 20%", allocation: "main", guard: "m1", from: "USDC", to: "FERN", poolKey: "USDC-FERN", amount: { kind: "bpsOfAllocation", bps: 2000 } }),
          swap(env, { id: "t2", label: "Tranche 2 · 30%", allocation: "main", guard: "m12", from: "USDC", to: "FERN", poolKey: "USDC-FERN", amount: { kind: "bpsOfAllocation", bps: 3000 } }),
          swap(env, { id: "t3", label: "Tranche 3 · 50%", allocation: "main", guard: "m123", from: "USDC", to: "FERN", poolKey: "USDC-FERN", amount: { kind: "bpsOfAllocation", bps: 5000 } }),
        ],
      }),
  },
  {
    id: "sell-on-no",
    title: "Sell deposited tokens on NO",
    summary: "Hold tokens in the vault; if the event resolves NO, sell them within a limit price.",
    category: "Basics",
    events: 1,
    build: (env) =>
      base(env, {
        title: "Exit MAYBE if Orbit slips",
        thesis: "My MAYBE position depends on Orbit; exit if it fails.",
        template: "sell-on-no",
        days: 45,
        events: [market(env, "orbit-launch", "A")],
        allocations: [{ id: "bag", label: "MAYBE position", mint: env.fixtures.assetByKey.MAYBE!.mint, amount: (20_000n * 10n ** 6n).toString() }],
        nodes: [
          { id: "aNo", kind: "outcome", event: "A", outcome: "NO" },
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
        ],
        actions: [
          swap(env, { id: "sell", label: "Sell MAYBE for USDC", allocation: "bag", guard: "aNo", from: "MAYBE", to: "USDC", poolKey: "USDC-MAYBE", amount: { kind: "allOfHolding" } }),
          releaseAll(env, "keep", "bag", "aYes", "MAYBE", "Keep the tokens"),
        ],
      }),
  },
  {
    id: "proceeds-percent",
    title: "Use 25% of redeemed proceeds",
    summary: "Buy an outcome position, redeem it if it wins, and use a bounded share of what actually came back.",
    category: "Proceeds",
    events: 1,
    build: (env) => {
      const om = env.fixtures.outcomeMarkets[0]!;
      const usdc = env.fixtures.assetByKey.USDC!.mint;
      const yes = env.fixtures.assetByKey["YES-ORBIT"]!.mint;
      const stake = usd(env, 61);
      return base(env, {
        title: "Recycle Orbit winnings",
        thesis: "If my Orbit YES position pays out, put a quarter of the winnings into MAYBE.",
        template: "proceeds-percent",
        days: 45,
        events: [market(env, "orbit-launch", "A")],
        allocations: [usdcAlloc(env, "pos", "Outcome position", 61)],
        nodes: [
          { id: "now", kind: "always" },
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "redeemed", kind: "receipt", strategy: "self", action: "redeem" },
        ],
        actions: [
          {
            kind: "swap",
            id: "buyYes",
            label: "Buy YES outcome tokens",
            allocation: "pos",
            guard: "now",
            inputMint: usdc,
            outputMint: yes,
            amount: { kind: "fixed", amount: stake },
            minOut: { kind: "absolute", amount: ((BigInt(stake) * 1_000_000n) / om.yesPriceE6).toString() },
            route: { kind: "outcome-buy", pool: om.address },
            feeBps: 0,
            delaySeconds: 0,
          },
          {
            kind: "swap",
            id: "redeem",
            label: "Redeem winning tokens",
            allocation: "pos",
            guard: "aYes",
            inputMint: yes,
            outputMint: usdc,
            amount: { kind: "allOfHolding" },
            minOut: { kind: "rate", outPerInE9: "1000000000" },
            route: { kind: "outcome-redeem", pool: om.address },
            feeBps: 0,
            delaySeconds: 0,
          },
          swap(env, { id: "recycle", label: "25% of proceeds → MAYBE", allocation: "pos", guard: "redeemed", from: "USDC", to: "MAYBE", poolKey: "USDC-MAYBE", amount: { kind: "bpsOfReceived", action: "redeem", bps: 2500, cap: usd(env, 50) } }),
        ],
      });
    },
  },
  {
    id: "dca-after-trigger",
    title: "Buy on a schedule after a trigger",
    summary: "After the trigger, buy a fixed amount every week. Missed runs are skipped, not bunched up.",
    category: "Timing",
    events: 1,
    build: (env) =>
      base(env, {
        title: "Weekly Kite after the vote",
        thesis: "Dollar-cost into Kite for four weeks if the proposal passes.",
        template: "dca-after-trigger",
        days: 45,
        events: [market(env, "treasury-prop", "A")],
        allocations: [usdcAlloc(env, "main", "Weekly buys", 200)],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "aNo", kind: "outcome", event: "A", outcome: "NO" },
        ],
        actions: [
          swap(env, { id: "dca", label: "Buy 50 USDC of Kite weekly", allocation: "main", guard: "aYes", from: "USDC", to: "KITE", poolKey: "USDC-KITE", amount: { kind: "fixed", amount: usd(env, 50) }, schedule: { runs: 4, intervalSeconds: 7 * DAY, missed: "skip" } }),
          releaseAll(env, "refund", "main", "aNo"),
        ],
      }),
  },
  {
    id: "delay-after-settlement",
    title: "Wait 24h after settlement",
    summary: "Act only after the outcome has been final for a fixed time.",
    category: "Timing",
    events: 1,
    build: (env) =>
      base(env, {
        title: "Ravens win → buy Moss after 24h",
        thesis: "Let the post-match noise settle before buying.",
        template: "delay-after-settlement",
        days: 25,
        events: [market(env, "ravens-cup", "A")],
        allocations: [usdcAlloc(env, "main", "Post-match", 80)],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "aNo", kind: "outcome", event: "A", outcome: "NO" },
        ],
        actions: [
          swap(env, { id: "buy", label: "Buy Moss", allocation: "main", guard: "aYes", from: "USDC", to: "MOSS", poolKey: "USDC-MOSS", amount: { kind: "fixed", amount: usd(env, 80) }, delaySeconds: DAY }),
          releaseAll(env, "refund", "main", "aNo"),
        ],
      }),
  },
  {
    id: "limit-or-expire",
    title: "Limit price or expire unfilled",
    summary: "Buy only at or better than a limit price; if it can't fill by the deadline, nothing is spent.",
    category: "Basics",
    events: 1,
    build: (env) => {
      const deadline = Math.floor(env.now / 3600) * 3600 + 30 * DAY;
      return base(env, {
        title: "Gallery decision → Lumen at a limit",
        thesis: "Only worth it at today's price or better.",
        template: "limit-or-expire",
        days: 40,
        events: [market(env, "gallery-vote", "A")],
        allocations: [usdcAlloc(env, "main", "Limit order", 100)],
        nodes: [{ id: "aYes", kind: "outcome", event: "A", outcome: "YES" }],
        actions: [
          swap(env, {
            id: "buy",
            label: "Buy Lumen at limit",
            allocation: "main",
            guard: "aYes",
            from: "USDC",
            to: "LUMEN",
            poolKey: "USDC-LUMEN",
            amount: { kind: "fixed", amount: usd(env, 100) },
            minOut: { kind: "rate", outPerInE9: rateFor(env, "USDC-LUMEN", "USDC", 50) },
            deadline,
          }),
        ],
      });
    },
  },
  {
    id: "dependent-strategy",
    title: "Run after another future succeeds",
    summary: "Activates only once a specific action of a predecessor future has a successful receipt.",
    category: "Advanced" as never,
    events: 0,
    build: (env) => {
      const pred = env.predecessor ?? { strategy: env.fixtures.markets[0]!.eventKey, actionIndex: 0, title: "a predecessor future" };
      return base(env, {
        title: `After “${pred.title}” buys`,
        thesis: "Only add Kite once the first leg has actually executed.",
        template: "dependent-strategy",
        days: 40,
        events: [],
        allocations: [usdcAlloc(env, "main", "Second leg", 100)],
        nodes: [{ id: "pred", kind: "receipt", strategy: pred.strategy, action: String(pred.actionIndex) }],
        actions: [swap(env, { id: "buy", label: "Buy Kite", allocation: "main", guard: "pred", from: "USDC", to: "KITE", poolKey: "USDC-KITE", amount: { kind: "fixed", amount: usd(env, 100) } })],
      });
    },
  },
  {
    id: "conditional-payment",
    title: "Pay a fixed recipient on YES",
    summary: "Release a payment to one fixed wallet only if the event resolves YES; otherwise it returns to you.",
    category: "Payments",
    events: 1,
    build: (env) =>
      base(env, {
        title: "Bounty if the bridge reopens",
        thesis: "Pay the community organizer if the bridge reopens on time.",
        template: "conditional-payment",
        days: 62,
        events: [market(env, "harbor-bridge", "A")],
        allocations: [usdcAlloc(env, "bounty", "Bounty", 250)],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "aNo", kind: "outcome", event: "A", outcome: "NO" },
        ],
        actions: [
          {
            kind: "transfer",
            id: "pay",
            label: "Pay the organizer",
            allocation: "bounty",
            guard: "aYes",
            mint: env.fixtures.assetByKey.USDC!.mint,
            amount: { kind: "fixed", amount: usd(env, 250) },
            recipient: env.recipient ?? env.fixtures.markets[1]!.eventKey,
            feeBps: 0,
            delaySeconds: 0,
          },
          releaseAll(env, "refund", "bounty", "aNo"),
        ],
      }),
  },
  {
    id: "fundraising",
    title: "Pledge if raise and milestone are met",
    summary: "Your pledge goes to the project only if its escrow reaches the threshold on-chain and the event resolves YES; otherwise it is refunded. Pledges are locked until expiry.",
    category: "Payments",
    events: 2,
    build: (env) =>
      base(env, {
        title: "Fern grants pledge",
        thesis: "Back the grants round only if it is fully funded and the beta ships.",
        template: "fundraising",
        days: 62,
        cancelPolicy: "locked-until-expiry",
        events: [market(env, "grants-escrow", "T"), market(env, "fern-beta", "A")],
        allocations: [usdcAlloc(env, "pledge", "Pledge", 100)],
        nodes: [
          { id: "raised", kind: "outcome", event: "T", outcome: "YES" },
          { id: "shipped", kind: "outcome", event: "A", outcome: "YES" },
          { id: "release", kind: "and", children: ["raised", "shipped"] },
          { id: "refundWhen", kind: "not", child: "release" },
        ],
        actions: [
          {
            kind: "transfer",
            id: "send",
            label: "Send pledge to the project",
            allocation: "pledge",
            guard: "release",
            mint: env.fixtures.assetByKey.USDC!.mint,
            amount: { kind: "fixed", amount: usd(env, 100) },
            recipient: env.recipient ?? env.fixtures.markets[2]!.eventKey,
            feeBps: 0,
            delaySeconds: 0,
          },
          releaseAll(env, "refund", "pledge", "refundWhen", "USDC", "Refund the pledge"),
        ],
      }),
  },
  {
    id: "split-proceeds",
    title: "Split actual proceeds into a portfolio",
    summary: "Sell on YES, then split exactly what was received 50/30/20 — never what was expected.",
    category: "Proceeds",
    events: 1,
    build: (env) => {
      const maybe = env.fixtures.assetByKey.MAYBE!.mint;
      return base(env, {
        title: "Rotate MAYBE into a basket",
        thesis: "If the proposal passes, rotate my MAYBE into a diversified basket.",
        template: "split-proceeds",
        days: 20,
        events: [market(env, "treasury-prop", "A")],
        allocations: [{ id: "bag", label: "MAYBE to rotate", mint: maybe, amount: (10_000n * 10n ** 6n).toString() }],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "sold", kind: "receipt", strategy: "self", action: "sell" },
        ],
        actions: [
          swap(env, { id: "sell", label: "Sell MAYBE", allocation: "bag", guard: "aYes", from: "MAYBE", to: "USDC", poolKey: "USDC-MAYBE", amount: { kind: "allOfHolding" } }),
          swap(env, { id: "s1", label: "50% → Lumen", allocation: "bag", guard: "sold", from: "USDC", to: "LUMEN", poolKey: "USDC-LUMEN", amount: { kind: "bpsOfReceived", action: "sell", bps: 5000 } }),
          swap(env, { id: "s2", label: "30% → Fern", allocation: "bag", guard: "sold", from: "USDC", to: "FERN", poolKey: "USDC-FERN", amount: { kind: "bpsOfReceived", action: "sell", bps: 3000 } }),
          swap(env, { id: "s3", label: "20% → Kite", allocation: "bag", guard: "sold", from: "USDC", to: "KITE", poolKey: "USDC-KITE", amount: { kind: "bpsOfReceived", action: "sell", bps: 2000 } }),
        ],
      });
    },
  },
  {
    id: "flagship",
    title: "Two reservations, three events",
    summary: "300 USDC on A (YES buys portfolio A, NO releases it) and 200 USDC on B AND C. Everything unspent returns at expiry.",
    category: "Branching",
    events: 3,
    build: (env) =>
      base(env, {
        title: "Orbit, vote & cup",
        thesis: "Orbit is my main call; the vote and the cup together are a smaller side bet.",
        template: "flagship",
        days: 30,
        events: [market(env, "orbit-launch", "A"), market(env, "treasury-prop", "B"), market(env, "ravens-cup", "C")],
        allocations: [usdcAlloc(env, "allocA", "Event A", 300), usdcAlloc(env, "allocBC", "B and C", 200)],
        nodes: [
          { id: "aYes", kind: "outcome", event: "A", outcome: "YES" },
          { id: "aNo", kind: "outcome", event: "A", outcome: "NO" },
          { id: "bYes", kind: "outcome", event: "B", outcome: "YES" },
          { id: "cYes", kind: "outcome", event: "C", outcome: "YES" },
          { id: "bc", kind: "and", children: ["bYes", "cYes"] },
        ],
        actions: [
          swap(env, { id: "aLumen", label: "Portfolio A · Lumen 60%", allocation: "allocA", guard: "aYes", from: "USDC", to: "LUMEN", poolKey: "USDC-LUMEN", amount: { kind: "fixed", amount: usd(env, 180) }, branch: { group: "eventA", branch: "yes" } }),
          swap(env, { id: "aFern", label: "Portfolio A · Fern 40%", allocation: "allocA", guard: "aYes", from: "USDC", to: "FERN", poolKey: "USDC-FERN", amount: { kind: "fixed", amount: usd(env, 120) }, branch: { group: "eventA", branch: "yes" } }),
          { ...releaseAll(env, "aRelease", "allocA", "aNo", "USDC", "Release the 300"), branch: { group: "eventA", branch: "no" } },
          swap(env, { id: "bcBuy", label: "Buy MAYBE", allocation: "allocBC", guard: "bc", from: "USDC", to: "MAYBE", poolKey: "USDC-MAYBE", amount: { kind: "fixed", amount: usd(env, 200) } }),
        ],
      }),
  },
];

export function templateById(id: string): TemplateInfo | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
