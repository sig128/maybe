/**
 * Generates shared conformance fixtures from the TypeScript engine. The vault
 * program's pure-logic modules are tested against these files
 * (programs/programs/maybe-vault/tests/conformance.rs), so the simulator and the
 * on-chain semantics cannot drift apart silently.
 *
 *   pnpm --filter @maybe/core fixtures:conformance
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMPLATES,
  compileStrategy,
  decodePlan,
  encodePlan,
  evaluateNodes,
  actionReadiness,
  executeAction,
  activateStrategy,
  deposit,
  emptyVault,
  buildFixtures,
  bytesToHex,
  prng,
  INF,
  PlanError,
  type ChainContext,
  type EventView,
  type StrategyState,
  type Plan,
  type Venue,
  type SwapFill,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "conformance");
mkdirSync(out, { recursive: true });

const NOW = 1_793_000_000;
const DAY = 86_400;
const fx = buildFixtures(NOW);
let idn = 0;
const env = { now: NOW, fixtures: fx, id: () => `conf_${idn++}`, nonce: () => String(7_000 + idn++), recipient: fx.markets[1]!.eventKey };

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v === INF ? null : v);
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, big, 1) + "\n");

// ------------------------------------------------------------------ plans
const plans = TEMPLATES.map((t) => {
  const doc = t.build(env);
  const c = compileStrategy(doc);
  return { id: t.id, hex: bytesToHex(c.bytes), hash: c.hash, events: c.plan.events.length, nodes: c.plan.nodes.length, actions: c.plan.actions.length };
});
write("plans.json", plans);

// ------------------------------------------------------------------ invalid plans
const flagship = compileStrategy(TEMPLATES.find((t) => t.id === "flagship")!.build(env));
const fp = flagship.plan;
const invalid: Array<{ name: string; hex: string; error: string }> = [];
const mutate = (name: string, f: (b: Uint8Array) => Uint8Array) => {
  const b = f(flagship.bytes.slice());
  try {
    decodePlan(b);
    throw new Error(`mutation ${name} unexpectedly decoded`);
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    invalid.push({ name, hex: bytesToHex(b), error: e.issue.code });
  }
};
const encodeUnchecked = (p: Plan) => {
  // encode then patch, bypassing the encoder's own structural check
  const ok = encodePlan({ ...fp });
  void ok;
  return p;
};
void encodeUnchecked;
const nodeStart = 32 + 32 * (fp.events.length + fp.mints.length + fp.refs.length) + 16 * fp.allocations.length;
const actionStart = nodeStart + 24 * fp.nodes.length;
mutate("bad magic", (b) => ((b[0] = 0x58), b));
mutate("bad version", (b) => ((b[4] = 2), b));
mutate("unknown plan flag", (b) => ((b[5] = 0x80), b));
mutate("header reserved", (b) => ((b[15] = 1), b));
mutate("truncated", (b) => b.slice(0, b.length - 3));
mutate("trailing", (b) => {
  const x = new Uint8Array(b.length + 1);
  x.set(b);
  return x;
});
mutate("allocation reserved", (b) => ((b[32 + 32 * (fp.events.length + fp.mints.length + fp.refs.length) + 3] = 7), b));
mutate("node reserved", (b) => ((b[nodeStart + 6] = 1), b));
mutate("unused child slot", (b) => ((b[nodeStart + 8 + 7] = 0), b));
mutate("forward reference", (b) => {
  const andIdx = fp.nodes.findIndex((n) => n.op === 3);
  b[nodeStart + andIdx * 24 + 8] = andIdx; // child refers to itself
  return b;
});
mutate("unknown op", (b) => ((b[nodeStart] = 42), b));
mutate("outcome event out of range", (b) => ((b[nodeStart + 1] = 9), b));
mutate("action reserved", (b) => ((b[actionStart + 60] = 1), b));
mutate("fee above plan max", (b) => ((b[actionStart + 14] = 200), (b[actionStart + 15] = 0), b));
mutate("swap without min out", (b) => {
  for (let i = 0; i < 8; i++) b[actionStart + 40 + i] = 0;
  return b;
});
mutate("guard out of range", (b) => ((b[actionStart + 1] = 99), b));
mutate("unknown action kind", (b) => ((b[actionStart] = 9), b));
mutate("max fee above protocol cap", (b) => ((b[12] = 0xff), (b[13] = 0), b));
mutate("zero allocation", (b) => {
  const off = 32 + 32 * (fp.events.length + fp.mints.length + fp.refs.length);
  for (let i = 0; i < 8; i++) b[off + 8 + i] = 0;
  return b;
});
mutate("duplicate mint", (b) => {
  const m0 = 32 + 32 * fp.events.length;
  b.copyWithin(m0 + 32, m0, m0 + 32);
  return b;
});
write("invalid_plans.json", invalid);

// ------------------------------------------------------------------ predicate cases
const rnd = prng(20261104);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
function randomEvent(now: number): EventView {
  const r = rnd();
  const t = NOW + Math.floor(rnd() * 20 * DAY);
  if (r < 0.25) return { status: "OPEN", outcome: null, finalAt: null, adapter: "ATTESTATION" };
  if (r < 0.35) return { status: "OPEN", outcome: null, finalAt: null, adapter: "BALANCE", deadline: NOW + Math.floor(rnd() * 20 * DAY) };
  if (r < 0.5) return { status: "PENDING", outcome: pick(["YES", "NO", "VOID"] as const), finalAt: t, adapter: "ATTESTATION" };
  if (r < 0.58) return { status: "DISPUTED", outcome: pick(["YES", "NO"] as const), finalAt: t, adapter: "ATTESTATION" };
  return { status: "FINAL", outcome: pick(["YES", "NO", "VOID"] as const), finalAt: Math.min(t, now), adapter: "ATTESTATION" };
}
const predicateCases: unknown[] = [];
for (const t of TEMPLATES) {
  const c = compileStrategy(t.build(env));
  for (let k = 0; k < 25; k++) {
    const now = NOW + Math.floor(rnd() * 25 * DAY);
    const events = c.plan.events.map(() => randomEvent(now));
    const receipts = c.plan.actions.map(() => (rnd() < 0.3 ? { executedAt: NOW + Math.floor(rnd() * 10 * DAY), impossibleAt: null } : rnd() < 0.2 ? { executedAt: null, impossibleAt: NOW + 5 * DAY } : { executedAt: null, impossibleAt: null }));
    const times = evaluateNodes(c.plan, {
      now,
      activatedAt: NOW,
      event: (i) => events[i],
      receipt: (ref, a) => (ref === 0xff ? receipts[a] : { executedAt: null, impossibleAt: null }),
    });
    predicateCases.push({ template: t.id, hex: bytesToHex(c.bytes), now, activatedAt: NOW, events, selfReceipts: receipts, expected: times });
  }
}
write("predicates.json", predicateCases);

// ------------------------------------------------------------------ engine (readiness + execution) cases
class FixedVenue implements Venue {
  constructor(public fill: (amountIn: bigint, minOut: bigint) => SwapFill) {}
  swap(req: { amountIn: bigint; minOut: bigint }): SwapFill {
    return this.fill(req.amountIn, req.minOut);
  }
}
const fills: Array<{ name: string; f: (a: bigint, m: bigint) => SwapFill }> = [
  { name: "exact-min", f: (a, m) => ({ spentIn: a, receivedOut: m }) },
  { name: "better", f: (a, m) => ({ spentIn: a, receivedOut: m + m / 10n + 1n }) },
  { name: "partial", f: (a, m) => ({ spentIn: a / 2n, receivedOut: m }) },
  { name: "overspend", f: (a, m) => ({ spentIn: a + 1n, receivedOut: m }) },
  { name: "underdeliver", f: (a, m) => ({ spentIn: a, receivedOut: m > 0n ? m - 1n : 0n }) },
  { name: "fail", f: () => ({ error: "route failed" }) },
];
function serializeState(s: StrategyState) {
  return {
    status: s.status,
    activatedAt: s.activatedAt,
    closedAt: s.closedAt,
    holdings: s.holdings,
    groupClaims: s.groupClaims,
    actions: s.actions,
    execNonce: s.execNonce,
  };
}
const engineCases: unknown[] = [];
const execTemplates = ["flagship", "yes-a-no-b", "milestones", "dca-after-trigger", "veto-window", "split-proceeds", "delay-after-settlement", "limit-or-expire", "conditional-payment", "three-of-five", "sell-on-no"];
for (const tid of execTemplates) {
  const t = TEMPLATES.find((x) => x.id === tid)!;
  for (let run = 0; run < 6; run++) {
    const c = compileStrategy(t.build(env));
    let v = emptyVault("vault", "owner");
    for (const al of c.plan.allocations) v = deposit(v, c.plan.mints[al.mint]!, al.amount);
    const act = activateStrategy(v, c.bytes, { now: NOW, address: "strategy", owner: "owner" });
    let s = act.strategy;
    let vault = act.vault;
    const settings = c.plan.events.map((_, i) => {
      const o = pick(["YES", "NO", "VOID", "OPEN", "YES"] as const);
      return o === "OPEN" ? null : { outcome: o, at: NOW + (i + 1) * DAY + Math.floor(rnd() * DAY) };
    });
    const times = [...Array(8)].map(() => NOW + Math.floor(rnd() * 40 * DAY)).sort((a, b) => a - b);
    for (const now of times) {
      const events: Record<string, EventView> = {};
      c.plan.events.forEach((key, i) => {
        const st = settings[i];
        events[key] = st && st.at <= now ? { status: "FINAL", outcome: st.outcome, finalAt: st.at, adapter: "ATTESTATION" } : { status: "OPEN", outcome: null, finalAt: null, adapter: "ATTESTATION" };
      });
      const paused = rnd() < 0.08;
      const ctx: ChainContext = { now, executionPaused: paused, events, strategies: {} };
      for (let i = 0; i < c.plan.actions.length; i++) {
        const before = serializeState(s);
        const readiness = actionReadiness(s, i, ctx);
        const fill = pick(fills);
        const venue = new FixedVenue(fill.f);
        const res = executeAction(vault, s, i, ctx, venue, { expectedPlanHash: s.planHash });
        engineCases.push({
          template: tid,
          hex: bytesToHex(c.bytes),
          now,
          paused,
          events: c.plan.events.map((k) => events[k]),
          action: i,
          state: before,
          fill: fill.name,
          readiness,
          result: res.ok ? { ok: true, receipt: { ...res.receipt, strategy: undefined, planHash: undefined }, after: serializeState(res.strategy) } : { ok: false, code: res.code },
        });
        if (res.ok) {
          s = res.strategy;
          vault = res.vault;
        }
      }
    }
  }
}
write("engine.json", engineCases);

console.log(`wrote ${plans.length} plans, ${invalid.length} invalid plans, ${predicateCases.length} predicate cases, ${engineCases.length} engine cases to ${out}`);
