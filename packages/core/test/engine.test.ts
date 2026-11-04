import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  actionReadiness,
  activateStrategy,
  checkVaultInvariants,
  closeStrategy,
  compileStrategy,
  executeAction,
  holdingsByMint,
  setPaused,
  withdraw,
  deposit,
  EngineError,
  LedgerError,
  type StrategyState,
  type VaultState,
  type ChainContext,
  type Venue,
} from "../src/index.ts";
import { activate, build, ctxByRef, env, fixtures, NOW, OWNER, venueFor } from "./helpers.ts";

const DAY = 86_400;
const f = fixtures();
const USDC = f.assetByKey.USDC!.mint;

/** Crank every executable action until nothing changes (what a keeper does). */
function crank(vault: VaultState, s: StrategyState, c: ChainContext, venue: Venue) {
  const receipts = [];
  for (let guard = 0; guard < 100; guard++) {
    let progressed = false;
    for (let i = 0; i < s.plan.actions.length; i++) {
      const r = actionReadiness(s, i, c);
      if (r.state !== "executable") continue;
      const res = executeAction(vault, s, i, c, venue, { expectedPlanHash: s.planHash, expectedRun: r.run });
      if (res.ok) {
        vault = res.vault;
        s = res.strategy;
        receipts.push(res.receipt);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return { vault, s, receipts };
}

function assertInvariants(vault: VaultState, strategies: StrategyState[]) {
  expect(checkVaultInvariants(vault, holdingsByMint(strategies))).toEqual([]);
}

describe("flagship: 500 USDC, A → portfolio / release, B AND C → MAYBE", () => {
  const doc = build("flagship");
  it("A YES, B YES, C YES: both reservations spend; branch claim locks out the release", () => {
    const { vault, strategy } = activate(doc);
    assertInvariants(vault, [strategy]);
    expect(vault.balances[USDC]).toEqual({ available: 0n, reserved: 500_000_000n });
    const c = ctxByRef(doc, strategy, NOW + 5 * DAY, { A: { outcome: "YES", at: NOW + DAY }, B: { outcome: "YES", at: NOW + 2 * DAY }, C: { outcome: "YES", at: NOW + 3 * DAY } });
    const out = crank(vault, strategy, c, venueFor(f));
    expect(out.receipts.map((r) => r.action).sort()).toEqual([0, 1, 3]);
    assertInvariants(out.vault, [out.s]);
    expect(out.s.groupClaims[0]).toBe(1); // eventA group claimed by branch "yes"
    const usdcLeft = out.s.holdings.reduce((m, row) => m + row[out.s.plan.mints.indexOf(USDC)]!, 0n);
    expect(usdcLeft).toBe(0n);
    // fees bounded by 0.30% of what executed
    for (const r of out.receipts) expect(r.fee * 10_000n <= r.amount * 30n).toBe(true);
  });

  it("A NO: the 300 is released immediately and the portfolio can never run", () => {
    const { vault, strategy } = activate(doc);
    const c = ctxByRef(doc, strategy, NOW + 2 * DAY, { A: { outcome: "NO", at: NOW + DAY } });
    const out = crank(vault, strategy, c, venueFor(f));
    expect(out.receipts.map((r) => r.action)).toEqual([2]);
    expect(out.vault.balances[USDC]).toEqual({ available: 300_000_000n, reserved: 200_000_000n });
    expect(actionReadiness(out.s, 0, c).state).toBe("done");
    assertInvariants(out.vault, [out.s]);
  });

  it("A voided: neither branch runs; funds stay reserved until expiry, then return", () => {
    const { vault, strategy } = activate(doc);
    const c = ctxByRef(doc, strategy, NOW + 2 * DAY, { A: { outcome: "VOID", at: NOW + DAY } });
    const out = crank(vault, strategy, c, venueFor(f));
    expect(out.receipts).toEqual([]);
    const early = closeStrategy(out.vault, out.s, "EXPIRE", c);
    expect(early.ok).toBe(false);
    const atExpiry = { ...c, now: strategy.plan.expiresAt };
    const closed = closeStrategy(out.vault, out.s, "EXPIRE", atExpiry);
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.vault.balances[USDC]).toEqual({ available: 500_000_000n, reserved: 0n });
      assertInvariants(closed.vault, [closed.strategy]);
    }
  });

  it("B YES but C unresolved at expiry: nothing executes for B∧C, all refunded (unresolved ≠ NO)", () => {
    const { vault, strategy } = activate(doc);
    const c = ctxByRef(doc, strategy, strategy.plan.expiresAt - 1, { B: { outcome: "YES", at: NOW + DAY } });
    const out = crank(vault, strategy, c, venueFor(f));
    expect(out.receipts).toEqual([]);
    expect(actionReadiness(out.s, 3, c)).toEqual({ state: "waiting", reason: "GUARD_PENDING" });
  });
});

describe("execution safety", () => {
  const doc = build("yes-buys-token");
  const yes = (s: StrategyState, now = NOW + 2 * DAY) => ctxByRef(doc, s, now, { A: { outcome: "YES", at: NOW + DAY } });

  it("is idempotent: the same (action, run) cannot execute twice", () => {
    const { vault, strategy } = activate(doc);
    const c = yes(strategy);
    const first = executeAction(vault, strategy, 0, c, venueFor(f), { expectedPlanHash: strategy.planHash, expectedRun: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = executeAction(first.vault, first.strategy, 0, c, venueFor(f), { expectedPlanHash: strategy.planHash, expectedRun: 0 });
    expect(again).toMatchObject({ ok: false, code: "ACTION_COMPLETE" });
  });

  it("a failed route never consumes the allocation (rollback)", () => {
    const { vault, strategy } = activate(doc);
    const res = executeAction(vault, strategy, 0, yes(strategy), venueFor(f, {}, "fail"), { expectedPlanHash: strategy.planHash });
    expect(res).toMatchObject({ ok: false, code: "ROUTE_FAILED" });
    expect(strategy.actions[0]!.runsDone).toBe(0);
    expect(strategy.holdings[0]![0]).toBe(100_000_000n);
  });

  it("rejects a malicious route that takes more than authorized", () => {
    const { vault, strategy } = activate(doc);
    const res = executeAction(vault, strategy, 0, yes(strategy), venueFor(f, {}, "overspend"), { expectedPlanHash: strategy.planHash });
    expect(res).toMatchObject({ ok: false, code: "ROUTE_DELTA_VIOLATION" });
  });

  it("rejects a route that under-delivers below the minimum received", () => {
    const { vault, strategy } = activate(doc);
    const res = executeAction(vault, strategy, 0, yes(strategy), venueFor(f, {}, "underdeliver"), { expectedPlanHash: strategy.planHash });
    expect(res).toMatchObject({ ok: false, code: "MIN_OUT_NOT_MET" });
  });

  it("partial fills charge fees only on what filled and keep the remainder in the allocation", () => {
    const d = build("sell-on-no");
    const { vault, strategy } = activate(d);
    const c = ctxByRef(d, strategy, NOW + 2 * DAY, { A: { outcome: "NO", at: NOW + DAY } });
    const res = executeAction(vault, strategy, 0, c, venueFor(f, {}, "partial"), { expectedPlanHash: strategy.planHash });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.receipt;
    const A = strategy.holdings[0]![0]!;
    const feeFull = (A * 30n) / 10_000n;
    expect(r.amountIn).toBe((A - feeFull) / 2n);
    expect(r.fee).toBe((feeFull * r.amountIn) / (A - feeFull));
    expect(res.strategy.holdings[0]![0]).toBe(strategy.holdings[0]![0]! - r.amountIn - r.fee);
    assertInvariants(res.vault, [res.strategy]);
  });

  it("refuses a stale plan hash (no executing an old authorization)", () => {
    const { vault, strategy } = activate(doc);
    expect(executeAction(vault, strategy, 0, yes(strategy), venueFor(f), { expectedPlanHash: "00".repeat(32) })).toMatchObject({ ok: false, code: "PLAN_HASH_MISMATCH" });
  });

  it("deadline boundary: executable one second before expiry, never at expiry", () => {
    const { vault, strategy } = activate(doc);
    const exp = strategy.plan.expiresAt;
    expect(actionReadiness(strategy, 0, yes(strategy, exp - 1)).state).toBe("executable");
    expect(actionReadiness(strategy, 0, yes(strategy, exp))).toEqual({ state: "done", reason: "DEADLINE_PASSED" });
    void vault;
  });

  it("emergency pause blocks new actions but never withdrawals, cancellation or refunds", () => {
    const { vault, strategy } = activate(doc, NOW, 50_000_000n);
    const c = { ...yes(strategy), executionPaused: true };
    expect(actionReadiness(strategy, 0, c)).toEqual({ state: "blocked", reason: "EXECUTION_PAUSED" });
    expect(() => withdraw(vault, USDC, 50_000_000n)).not.toThrow();
    const cancelled = closeStrategy(vault, strategy, "CANCEL", c, OWNER);
    expect(cancelled.ok).toBe(true);
  });

  it("reserved funds are never withdrawable", () => {
    const { vault } = activate(doc);
    expect(() => withdraw(vault, USDC, 1n)).toThrowError(LedgerError);
  });

  it("owner pause is per strategy and reversible; only the owner can cancel", () => {
    const { vault, strategy } = activate(doc);
    const paused = setPaused(strategy, true, OWNER);
    expect(actionReadiness(paused, 0, yes(paused))).toEqual({ state: "blocked", reason: "STRATEGY_PAUSED" });
    expect(() => setPaused(strategy, true, "someone-else")).toThrowError(EngineError);
    expect(closeStrategy(vault, strategy, "CANCEL", yes(strategy), "someone-else")).toMatchObject({ ok: false, code: "NOT_OWNER" });
  });

  it("cancelling after a trade returns unspent funds and the bought asset, never the fee", () => {
    const { vault, strategy } = activate(build("flagship"));
    const d = build("flagship");
    const c = ctxByRef(d, strategy, NOW + 2 * DAY, { A: { outcome: "YES", at: NOW + DAY } });
    const one = executeAction(vault, strategy, 0, c, venueFor(f), { expectedPlanHash: strategy.planHash });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const closed = closeStrategy(one.vault, one.strategy, "CANCEL", c, OWNER);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    const lumen = f.assetByKey.LUMEN!.mint;
    expect(closed.refunded[lumen]).toBe(one.receipt.amountOut);
    expect(closed.refunded[USDC]).toBe(500_000_000n - one.receipt.amount);
    expect(closed.vault.balances[USDC]!.available).toBe(500_000_000n - one.receipt.amount);
  });

  it("cancel-locked plans cannot be cancelled before expiry", () => {
    const d = build("fundraising");
    const { vault, strategy } = activate(d);
    expect(closeStrategy(vault, strategy, "CANCEL", ctxByRef(d, strategy, NOW + 10, {}), OWNER)).toMatchObject({ ok: false, code: "CANCEL_LOCKED" });
  });

  it("activation refuses more than is available", () => {
    const c = compileStrategy(doc);
    let v: VaultState = { address: "v", owner: OWNER, balances: {}, tokens: {}, policyEpoch: 0, strategyCount: 0 };
    v = deposit(v, USDC, 99_999_999n);
    expect(() => activateStrategy(v, c.bytes, { now: NOW, address: "s", owner: OWNER })).toThrowError(/INSUFFICIENT_AVAILABLE|need/);
  });
});

describe("timing semantics", () => {
  it("delay after settlement: executable exactly delay seconds after finality", () => {
    const d = build("delay-after-settlement");
    const { strategy } = activate(d);
    const fin = NOW + 3 * DAY;
    const at = (now: number) => actionReadiness(strategy, 0, ctxByRef(d, strategy, now, { A: { outcome: "YES", at: fin } }));
    expect(at(fin + DAY - 1)).toEqual({ state: "scheduled", reason: "DELAY_PENDING", at: fin + DAY });
    expect(at(fin + DAY).state).toBe("executable");
  });

  it("schedules: missed runs are skipped under 'skip', each run is a nonce", () => {
    const d = build("dca-after-trigger");
    const { vault, strategy } = activate(d);
    const fin = NOW + DAY;
    const c = (now: number) => ctxByRef(d, strategy, now, { A: { outcome: "YES", at: fin } });
    let v = vault;
    let s = strategy;
    // run 0
    let r = executeAction(v, s, 0, c(fin), venueFor(f), { expectedPlanHash: s.planHash, expectedRun: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    v = r.vault;
    s = r.strategy;
    // keeper was down for runs 1 and 2; at fin + 3 weeks, run 3 is the current one
    const late = actionReadiness(s, 0, c(fin + 21 * DAY));
    expect(late).toMatchObject({ state: "executable", run: 3, skippedRuns: 2 });
    r = executeAction(v, s, 0, c(fin + 21 * DAY), venueFor(f), { expectedPlanHash: s.planHash, expectedRun: 1 });
    expect(r).toMatchObject({ ok: false, code: "RUN_OUT_OF_ORDER" });
    r = executeAction(v, s, 0, c(fin + 21 * DAY), venueFor(f), { expectedPlanHash: s.planHash, expectedRun: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.actions[0]).toMatchObject({ runsDone: 4, executedRuns: 2 });
    expect(r.strategy.holdings[0]![0]).toBe(100_000_000n); // 200 - 2 × 50 spent, skipped runs spend nothing
  });

  it("milestones unlock in order and never out of order", () => {
    const d = build("milestones");
    const { vault, strategy } = activate(d);
    // M2 resolves YES before M1: tranche 2 needs M1 AND M2, so nothing runs yet
    const c1 = ctxByRef(d, strategy, NOW + 2 * DAY, { M2: { outcome: "YES", at: NOW + DAY } });
    expect(crank(vault, strategy, c1, venueFor(f)).receipts).toEqual([]);
    const c2 = ctxByRef(d, strategy, NOW + 3 * DAY, { M1: { outcome: "YES", at: NOW + 2 * DAY }, M2: { outcome: "YES", at: NOW + DAY } });
    const out = crank(vault, strategy, c2, venueFor(f));
    expect(out.receipts.map((r) => [r.action, r.amount])).toEqual([
      [0, 100_000_000n],
      [1, 150_000_000n],
    ]);
  });

  it("veto: triggers at T only if the veto has not finalized by then", () => {
    const d = build("veto-window");
    const { strategy } = activate(d);
    const trig = NOW + DAY;
    const w = 2 * DAY;
    const r1 = actionReadiness(strategy, 0, ctxByRef(d, strategy, trig + w - 1, { A: { outcome: "YES", at: trig } }));
    expect(r1.state).toBe("waiting");
    const r2 = actionReadiness(strategy, 0, ctxByRef(d, strategy, trig + w, { A: { outcome: "YES", at: trig } }));
    expect(r2.state).toBe("executable");
    const r3 = actionReadiness(strategy, 0, ctxByRef(d, strategy, trig + w + 10, { A: { outcome: "YES", at: trig }, V: { outcome: "YES", at: trig + w } }));
    expect(r3).toEqual({ state: "done", reason: "GUARD_FALSE" });
  });

  it("proceeds: uses a bounded share of what was actually redeemed", () => {
    const d = build("proceeds-percent");
    const { vault, strategy } = activate(d);
    const orbit = d.events[0]!.eventKey;
    const venue = venueFor(f, { [orbit]: "YES" });
    const c = ctxByRef(d, strategy, NOW + 3 * DAY, { A: { outcome: "YES", at: NOW + 2 * DAY } });
    const out = crank(vault, strategy, c, venue);
    expect(out.receipts.map((r) => r.action)).toEqual([0, 1, 2]);
    const redeemed = out.receipts[1]!.amountOut;
    expect(out.receipts[2]!.amount).toBe((redeemed * 2500n) / 10_000n);
    assertInvariants(out.vault, [out.s]);
  });

  it("split proceeds: splits exactly what was received", () => {
    const d = build("split-proceeds");
    const { vault, strategy } = activate(d);
    const c = ctxByRef(d, strategy, NOW + 2 * DAY, { A: { outcome: "YES", at: NOW + DAY } });
    const out = crank(vault, strategy, c, venueFor(f));
    const got = out.receipts[0]!.amountOut;
    const spends = out.receipts.slice(1).map((r) => r.amount);
    expect(spends).toEqual([(got * 5000n) / 10_000n, (got * 3000n) / 10_000n, (got * 2000n) / 10_000n]);
    expect(spends.reduce((a, b) => a + b, 0n) <= got).toBe(true);
  });

  it("dependent strategy waits for a real predecessor receipt", () => {
    const pre = build("yes-buys-token");
    const a = activate(pre);
    const dep = build("dependent-strategy", { ...env(), predecessor: { strategy: f.markets[5]!.eventKey, actionIndex: 0, title: "pred" } });
    const b = activate(dep);
    const predState = { ...a.strategy, address: f.markets[5]!.eventKey };
    const base = ctxByRef(dep, b.strategy, NOW + 2 * DAY, {});
    expect(actionReadiness(b.strategy, 0, { ...base, strategies: { [predState.address]: predState } }).state).toBe("waiting");
    const c = ctxByRef(pre, predState, NOW + 2 * DAY, { A: { outcome: "YES", at: NOW + DAY } });
    const ran = executeAction(a.vault, predState, 0, c, venueFor(f), { expectedPlanHash: predState.planHash });
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(actionReadiness(b.strategy, 0, { ...base, strategies: { [predState.address]: ran.strategy } }).state).toBe("executable");
  });
});

describe("conservation under random operation sequences", () => {
  const templates = ["flagship", "yes-a-no-b", "milestones", "three-of-five", "dca-after-trigger", "split-proceeds", "conditional-payment"];
  const outcomeArb = fc.constantFrom("YES", "NO", "VOID", "OPEN") as fc.Arbitrary<"YES" | "NO" | "VOID" | "OPEN">;
  it("tokens == available + reserved, reserved == Σ holdings, nothing negative, branches exclusive", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...templates),
        fc.array(outcomeArb, { minLength: 5, maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: 40 * DAY }), { minLength: 1, maxLength: 6 }),
        fc.constantFrom("honest", "fail", "overspend", "underdeliver", "partial") as fc.Arbitrary<"honest" | "fail" | "overspend" | "underdeliver" | "partial">,
        fc.boolean(),
        (tid, outcomes, times, behaviour, cancelAtEnd) => {
          const d = build(tid);
          const { vault, strategy } = activate(d, NOW, 10_000_000n);
          let v = vault;
          let s = strategy;
          const settings: Record<string, { outcome: "YES" | "NO" | "VOID"; at: number }> = {};
          d.events.forEach((e, i) => {
            const o = outcomes[i] ?? "OPEN";
            if (o !== "OPEN") settings[e.ref] = { outcome: o, at: NOW + (i + 1) * DAY };
          });
          const sorted = [...times].sort((a, b) => a - b);
          for (const t of sorted) {
            const c = ctxByRef(d, s, NOW + t, settings);
            const out = crank(v, s, c, venueFor(f, {}, behaviour));
            v = out.vault;
            s = out.s;
            assertInvariants(v, [s]);
            // exclusivity: at most one branch per group executed
            const byGroup = new Map<number, Set<number>>();
            s.plan.actions.forEach((a, i) => {
              if (a.group === 0xff || s.actions[i]!.executedRuns === 0) return;
              const set = byGroup.get(a.group) ?? new Set();
              set.add(a.branch);
              byGroup.set(a.group, set);
            });
            for (const set of byGroup.values()) expect(set.size).toBe(1);
            // spending never exceeds the reservation in its base asset
            s.plan.allocations.forEach((al, ai) => expect(s.holdings[ai]![al.mint]! >= 0n).toBe(true));
          }
          const end = ctxByRef(d, s, cancelAtEnd ? NOW + 1 : s.plan.expiresAt, settings);
          const closed = closeStrategy(v, s, cancelAtEnd ? "CANCEL" : "EXPIRE", end, OWNER);
          if (closed.ok) {
            assertInvariants(closed.vault, [closed.strategy]);
            for (const b of Object.values(closed.vault.balances)) expect(b.reserved).toBe(0n);
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});
