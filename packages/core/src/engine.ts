import { LIMITS, NONE } from "./limits.ts";
import { BPS_DENOMINATOR, RATE_SCALE, mulDivFloor, subU64, addU64 } from "./money.ts";
import {
  ACTION_FLAG_MIN_OUT_IS_RATE,
  ACTION_FLAG_MISSED_CATCH_UP,
  ActionKind,
  AmountKind,
  PLAN_FLAG_CANCEL_LOCKED,
  RouteKind,
  actionDeadline,
  decodePlan,
  planHash,
  type Plan,
} from "./plan.ts";
import { evaluateNodes, truthAt, INF, type EvalContext, type EventView, type ReceiptView, type Times } from "./predicate.ts";
import { cloneVault, release, reserve, spendReserved, receiveReserved, type VaultState } from "./ledger.ts";

/**
 * The shared execution engine. The vault program implements the same state
 * transitions on-chain; the simulation backend, the outcome-path simulator, the
 * keeper's readiness checks and the review screen all call these functions.
 */

export type StrategyStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "EXPIRED" | "CANCELLED";

export interface ActionState {
  /** runs executed + runs skipped under the "skip" missed-run policy */
  runsDone: number;
  executedRuns: number;
  firstExecutedAt: number | null;
  lastExecutedAt: number | null;
  /** cumulative output: swap proceeds, amount delivered to recipient, or amount released */
  received: bigint;
  /** cumulative amount taken from the allocation, including fees */
  spent: bigint;
  fees: bigint;
}

export type CreatedBy = { kind: "owner" } | { kind: "policy"; policy: string };

export interface StrategyState {
  address: string;
  vault: string;
  owner: string;
  planHash: string;
  plan: Plan;
  status: StrategyStatus;
  createdBy: CreatedBy;
  activatedAt: number;
  closedAt: number | null;
  /** holdings[allocation][mintIndex] */
  holdings: bigint[][];
  /** per branch group: 0 = unclaimed, otherwise branch + 1 */
  groupClaims: number[];
  actions: ActionState[];
  execNonce: number;
}

export interface ChainContext {
  now: number;
  /** emergency pause: blocks new actions only; never blocks release, refund, cancel or withdraw */
  executionPaused: boolean;
  events: Record<string, EventView>;
  /** other strategies by address (for RECEIPT predicates) */
  strategies: Record<string, StrategyState>;
}

export type EngineErrorCode =
  | "NOT_ACTIVE"
  | "STRATEGY_PAUSED"
  | "STRATEGY_CLOSED"
  | "EXECUTION_PAUSED"
  | "PLAN_HASH_MISMATCH"
  | "ACTION_COMPLETE"
  | "DEADLINE_PASSED"
  | "BRANCH_LOST"
  | "GUARD_PENDING"
  | "GUARD_FALSE"
  | "DELAY_PENDING"
  | "RUN_NOT_DUE"
  | "RUN_OUT_OF_ORDER"
  | "AMOUNT_ZERO"
  | "INSUFFICIENT_ALLOCATION"
  | "ROUTE_FAILED"
  | "ROUTE_DELTA_VIOLATION"
  | "MIN_OUT_NOT_MET"
  | "NOT_OWNER"
  | "CANCEL_LOCKED"
  | "NOT_EXPIRED"
  | "NOT_COMPLETE"
  | "EXPIRY_IN_PAST"
  | "DURATION_TOO_LONG"
  | "FEE_ABOVE_CAP"
  | "MINT_NOT_ALLOWED"
  | "INSUFFICIENT_AVAILABLE"
  | "BAD_PLAN";

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "EngineError";
  }
}

export type Readiness =
  | {
      state: "executable";
      run: number;
      skippedRuns: number;
      amount: bigint;
      fee: bigint;
      amountIn: bigint;
      minOut: bigint;
      runAt: number;
    }
  | { state: "waiting"; reason: "GUARD_PENDING" }
  | { state: "scheduled"; reason: "DELAY_PENDING" | "RUN_NOT_DUE"; at: number }
  | { state: "blocked"; reason: "STRATEGY_PAUSED" | "EXECUTION_PAUSED" | "AMOUNT_ZERO" | "INSUFFICIENT_ALLOCATION" }
  | { state: "done"; reason: "ACTION_COMPLETE" | "GUARD_FALSE" | "DEADLINE_PASSED" | "BRANCH_LOST" | "STRATEGY_CLOSED" };

export interface SwapRequest {
  routeKind: RouteKind;
  pool: string;
  inMint: string;
  outMint: string;
  amountIn: bigint;
  minOut: bigint;
  now: number;
}

/**
 * What a route actually did to the vault's two token accounts. A conforming
 * route spends at most amountIn and delivers at least minOut. The engine (and
 * the program, by measuring balances before/after the CPI) rejects anything else.
 */
export type SwapFill = { spentIn: bigint; receivedOut: bigint } | { error: string };

export interface Venue {
  swap(req: SwapRequest): SwapFill;
}

export interface Receipt {
  strategy: string;
  planHash: string;
  action: number;
  run: number;
  skippedRuns: number;
  execNonce: number;
  at: number;
  kind: ActionKind;
  inMint: string;
  outMint: string | null;
  /** taken from the allocation (input actually spent + fee) */
  amount: bigint;
  fee: bigint;
  /** sent to the route or recipient */
  amountIn: bigint;
  /** received by the vault (swap) or recipient (transfer) or released (release) */
  amountOut: bigint;
  recipient: string | null;
}

export function cloneStrategy(s: StrategyState): StrategyState {
  return {
    ...s,
    holdings: s.holdings.map((row) => [...row]),
    groupClaims: [...s.groupClaims],
    actions: s.actions.map((a) => ({ ...a })),
  };
}

function receiptViewFor(s: StrategyState, actionIndex: number, now: number): ReceiptView | undefined {
  const st = s.actions[actionIndex];
  const a = s.plan.actions[actionIndex];
  if (!st || !a) return undefined;
  if (st.firstExecutedAt !== null) return { executedAt: st.firstExecutedAt, impossibleAt: null };
  let impossibleAt: number | null = s.closedAt;
  const dl = actionDeadline(s.plan, a);
  if (now >= dl) impossibleAt = impossibleAt === null ? dl : Math.min(impossibleAt, dl);
  return { executedAt: null, impossibleAt };
}

export function evalContextFor(s: StrategyState, ctx: ChainContext): EvalContext {
  return {
    now: ctx.now,
    activatedAt: s.activatedAt,
    event: (i) => {
      const key = s.plan.events[i];
      return key ? ctx.events[key] : undefined;
    },
    receipt: (ref, actionIndex) => {
      const target = ref === NONE ? s : ctx.strategies[s.plan.refs[ref] ?? ""];
      return target ? receiptViewFor(target, actionIndex, ctx.now) : undefined;
    },
  };
}

export function guardTimes(s: StrategyState, ctx: ChainContext): Times[] {
  return evaluateNodes(s.plan, evalContextFor(s, ctx));
}

function computeAmount(s: StrategyState, i: number): bigint {
  const a = s.plan.actions[i]!;
  switch (a.amountKind) {
    case AmountKind.FIXED:
      return a.amount;
    case AmountKind.BPS_OF_ALLOCATION:
      return mulDivFloor(s.plan.allocations[a.alloc]!.amount, BigInt(a.bps), BPS_DENOMINATOR);
    case AmountKind.BPS_OF_RECEIVED: {
      const v = mulDivFloor(s.actions[a.amountRef]!.received, BigInt(a.bps), BPS_DENOMINATOR);
      return a.amount > 0n && v > a.amount ? a.amount : v;
    }
    case AmountKind.ALL_OF_HOLDING: {
      const v = s.holdings[a.alloc]![a.inMint]!;
      return a.amount > 0n && v > a.amount ? a.amount : v;
    }
  }
}

export function requiredMinOut(flags: number, minOut: bigint, amountIn: bigint): bigint {
  if ((flags & ACTION_FLAG_MIN_OUT_IS_RATE) === 0) return minOut;
  const v = (amountIn * minOut) / RATE_SCALE;
  return v === 0n ? 1n : v;
}

/** Readiness of one action at ctx.now — the same decision the program makes in execute_action. */
export function actionReadiness(s: StrategyState, i: number, ctx: ChainContext, times?: Times[]): Readiness {
  if (s.status === "PAUSED") return { state: "blocked", reason: "STRATEGY_PAUSED" };
  if (s.status !== "ACTIVE") return { state: "done", reason: "STRATEGY_CLOSED" };
  const a = s.plan.actions[i]!;
  const st = s.actions[i]!;
  const now = ctx.now;
  if (st.runsDone >= a.runs) return { state: "done", reason: "ACTION_COMPLETE" };
  const deadline = actionDeadline(s.plan, a);
  if (now >= deadline) return { state: "done", reason: "DEADLINE_PASSED" };
  if (a.group !== NONE) {
    const claim = s.groupClaims[a.group] ?? 0;
    if (claim !== 0 && claim !== a.branch + 1) return { state: "done", reason: "BRANCH_LOST" };
  }
  const t = (times ?? guardTimes(s, ctx))[a.guard];
  const truth = truthAt(t, now);
  if (truth === "FALSE") return { state: "done", reason: "GUARD_FALSE" };
  if (truth === "PENDING" || !t) return { state: "waiting", reason: "GUARD_PENDING" };
  const base = t.t + a.delay;
  let run = st.runsDone;
  const catchUp = (a.flags & ACTION_FLAG_MISSED_CATCH_UP) !== 0;
  if (a.runs > 1 && !catchUp) {
    while (run < a.runs - 1 && now >= base + (run + 1) * a.interval) run++;
  }
  const runAt = base + run * a.interval;
  if (runAt >= deadline) return { state: "done", reason: "DEADLINE_PASSED" };
  if (now < runAt) return { state: "scheduled", reason: run === 0 ? "DELAY_PENDING" : "RUN_NOT_DUE", at: runAt };
  if (ctx.executionPaused) return { state: "blocked", reason: "EXECUTION_PAUSED" };
  const amount = computeAmount(s, i);
  if (amount === 0n) return { state: "blocked", reason: "AMOUNT_ZERO" };
  if (s.holdings[a.alloc]![a.inMint]! < amount) return { state: "blocked", reason: "INSUFFICIENT_ALLOCATION" };
  const fee = a.kind === ActionKind.RELEASE ? 0n : mulDivFloor(amount, BigInt(a.feeBps), BPS_DENOMINATOR);
  const amountIn = amount - fee;
  const minOut = a.kind === ActionKind.SWAP ? requiredMinOut(a.flags, a.minOut, amountIn) : 0n;
  return { state: "executable", run, skippedRuns: run - st.runsDone, amount, fee, amountIn, minOut, runAt };
}

export interface ExecuteOptions {
  expectedPlanHash: string;
  /** per-action nonce: the run the caller intends to execute. Prevents duplicate execution. */
  expectedRun?: number;
}

export type ExecuteResult =
  | { ok: true; vault: VaultState; strategy: StrategyState; receipt: Receipt }
  | { ok: false; code: EngineErrorCode; detail?: string };

const readinessError: Record<string, EngineErrorCode> = {
  GUARD_PENDING: "GUARD_PENDING",
  GUARD_FALSE: "GUARD_FALSE",
  DELAY_PENDING: "DELAY_PENDING",
  RUN_NOT_DUE: "RUN_NOT_DUE",
  STRATEGY_PAUSED: "STRATEGY_PAUSED",
  EXECUTION_PAUSED: "EXECUTION_PAUSED",
  AMOUNT_ZERO: "AMOUNT_ZERO",
  INSUFFICIENT_ALLOCATION: "INSUFFICIENT_ALLOCATION",
  ACTION_COMPLETE: "ACTION_COMPLETE",
  DEADLINE_PASSED: "DEADLINE_PASSED",
  BRANCH_LOST: "BRANCH_LOST",
  STRATEGY_CLOSED: "STRATEGY_CLOSED",
};

/**
 * Execute one run of one action. Atomic: on any failure the input states are
 * untouched (callers keep their previous objects), mirroring transaction
 * rollback on-chain — a failed swap never consumes an allocation.
 */
export function executeAction(
  vault0: VaultState,
  s0: StrategyState,
  i: number,
  ctx: ChainContext,
  venue: Venue,
  opts: ExecuteOptions,
): ExecuteResult {
  if (opts.expectedPlanHash !== s0.planHash) return { ok: false, code: "PLAN_HASH_MISMATCH" };
  if (!s0.plan.actions[i]) return { ok: false, code: "BAD_PLAN", detail: "no such action" };
  const r = actionReadiness(s0, i, ctx);
  if (r.state !== "executable") return { ok: false, code: readinessError[r.reason] ?? "NOT_ACTIVE" };
  if (opts.expectedRun !== undefined && opts.expectedRun !== r.run) return { ok: false, code: "RUN_OUT_OF_ORDER" };
  const a = s0.plan.actions[i]!;
  const vault = cloneVault(vault0);
  const s = cloneStrategy(s0);
  const st = s.actions[i]!;
  const inMint = s.plan.mints[a.inMint]!;
  st.runsDone = r.run;
  let taken: bigint;
  let fee: bigint;
  let amountIn: bigint;
  let amountOut: bigint;
  let outMint: string | null = null;
  let recipient: string | null = null;
  try {
    switch (a.kind) {
      case ActionKind.SWAP: {
        outMint = s.plan.mints[a.outMint]!;
        const fill = venue.swap({
          routeKind: a.routeKind,
          pool: s.plan.refs[a.ref]!,
          inMint,
          outMint,
          amountIn: r.amountIn,
          minOut: r.minOut,
          now: ctx.now,
        });
        if ("error" in fill) return { ok: false, code: "ROUTE_FAILED", detail: fill.error };
        if (fill.spentIn > r.amountIn || fill.spentIn < 0n || fill.receivedOut < 0n) return { ok: false, code: "ROUTE_DELTA_VIOLATION" };
        if (fill.spentIn === 0n) return { ok: false, code: "ROUTE_FAILED", detail: "route filled nothing" };
        // Fee is pro-rata to what actually filled: a full fill pays exactly the authorized fee,
        // a partial fill pays proportionally less, and the unfilled remainder stays in the allocation.
        fee = r.amountIn === 0n ? 0n : mulDivFloor(r.fee, fill.spentIn, r.amountIn);
        const need = requiredMinOut(a.flags, a.minOut, fill.spentIn);
        if (fill.receivedOut < need) return { ok: false, code: "MIN_OUT_NOT_MET" };
        amountIn = fill.spentIn;
        amountOut = fill.receivedOut;
        taken = addU64(amountIn, fee);
        s.holdings[a.alloc]![a.inMint] = subU64(s.holdings[a.alloc]![a.inMint]!, taken);
        s.holdings[a.alloc]![a.outMint] = addU64(s.holdings[a.alloc]![a.outMint]!, amountOut);
        spendReserved(vault, inMint, taken);
        receiveReserved(vault, outMint, amountOut);
        break;
      }
      case ActionKind.TRANSFER: {
        recipient = s.plan.refs[a.ref]!;
        fee = r.fee;
        amountIn = r.amountIn;
        amountOut = r.amountIn;
        taken = r.amount;
        s.holdings[a.alloc]![a.inMint] = subU64(s.holdings[a.alloc]![a.inMint]!, taken);
        spendReserved(vault, inMint, taken);
        break;
      }
      case ActionKind.RELEASE: {
        fee = 0n;
        amountIn = r.amount;
        amountOut = r.amount;
        taken = r.amount;
        s.holdings[a.alloc]![a.inMint] = subU64(s.holdings[a.alloc]![a.inMint]!, taken);
        const released = release(vault, { [inMint]: taken });
        Object.assign(vault, released);
        break;
      }
    }
  } catch (e) {
    return { ok: false, code: "INSUFFICIENT_ALLOCATION", detail: (e as Error).message };
  }
  if (a.group !== NONE && (s.groupClaims[a.group] ?? 0) === 0) s.groupClaims[a.group] = a.branch + 1;
  st.runsDone += 1;
  st.executedRuns += 1;
  st.firstExecutedAt ??= ctx.now;
  st.lastExecutedAt = ctx.now;
  st.received = addU64(st.received, amountOut);
  st.spent = addU64(st.spent, taken);
  st.fees = addU64(st.fees, fee);
  s.execNonce += 1;
  const receipt: Receipt = {
    strategy: s.address,
    planHash: s.planHash,
    action: i,
    run: r.run,
    skippedRuns: r.skippedRuns,
    execNonce: s.execNonce,
    at: ctx.now,
    kind: a.kind,
    inMint,
    outMint,
    amount: taken,
    fee,
    amountIn,
    amountOut,
    recipient,
  };
  return { ok: true, vault, strategy: s, receipt };
}

export function allActionsTerminal(s: StrategyState, ctx: ChainContext): boolean {
  const times = guardTimes(s, ctx);
  return s.plan.actions.every((_, i) => actionReadiness(s, i, ctx, times).state === "done");
}

export type CloseMode = "CANCEL" | "EXPIRE" | "COMPLETE";
export type CloseResult = { ok: true; vault: VaultState; strategy: StrategyState; refunded: Record<string, bigint> } | { ok: false; code: EngineErrorCode };

/**
 * Close a strategy and return every unspent allocation holding (including assets
 * acquired by executed actions) to the vault's available balance. Cancellation
 * never reverses completed trades and never recovers fees.
 */
export function closeStrategy(vault0: VaultState, s0: StrategyState, mode: CloseMode, ctx: ChainContext, signer?: string): CloseResult {
  if (s0.status !== "ACTIVE" && s0.status !== "PAUSED") return { ok: false, code: "STRATEGY_CLOSED" };
  const now = ctx.now;
  if (mode === "CANCEL") {
    if (signer !== s0.owner) return { ok: false, code: "NOT_OWNER" };
    if ((s0.plan.flags & PLAN_FLAG_CANCEL_LOCKED) !== 0 && now < s0.plan.expiresAt) return { ok: false, code: "CANCEL_LOCKED" };
  } else if (mode === "EXPIRE") {
    if (now < s0.plan.expiresAt) return { ok: false, code: "NOT_EXPIRED" };
  } else if (s0.status === "PAUSED" || !allActionsTerminal(s0, ctx)) {
    return { ok: false, code: "NOT_COMPLETE" };
  }
  const s = cloneStrategy(s0);
  const refunded: Record<string, bigint> = {};
  s.holdings.forEach((row, ai) => {
    row.forEach((amt, mi) => {
      if (amt > 0n) {
        const mint = s.plan.mints[mi]!;
        refunded[mint] = (refunded[mint] ?? 0n) + amt;
        s.holdings[ai]![mi] = 0n;
      }
    });
  });
  const vault = release(vault0, refunded);
  s.status = mode === "CANCEL" ? "CANCELLED" : mode === "EXPIRE" ? "EXPIRED" : "COMPLETED";
  s.closedAt = now;
  return { ok: true, vault, strategy: s, refunded };
}

export function setPaused(s0: StrategyState, paused: boolean, signer: string): StrategyState {
  if (signer !== s0.owner) throw new EngineError("NOT_OWNER");
  if (s0.status !== "ACTIVE" && s0.status !== "PAUSED") throw new EngineError("STRATEGY_CLOSED");
  return { ...cloneStrategy(s0), status: paused ? "PAUSED" : "ACTIVE" };
}

export interface ActivationContext {
  now: number;
  address: string;
  owner: string;
  createdBy?: CreatedBy;
  maxFeeBpsCap?: number;
  isMintAllowed?: (mint: string) => boolean;
}

export function reservationByMint(plan: Plan): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const a of plan.allocations) {
    const mint = plan.mints[a.mint]!;
    out[mint] = addU64(out[mint] ?? 0n, a.amount);
  }
  return out;
}

/**
 * Activate (fund) a plan: strict decode, time/fee/asset checks, then move the
 * reservation from available to reserved. Mirrors activate_strategy on-chain.
 */
export function activateStrategy(vault0: VaultState, bytes: Uint8Array, ctx: ActivationContext): { vault: VaultState; strategy: StrategyState } {
  let plan: Plan;
  try {
    plan = decodePlan(bytes);
  } catch (e) {
    throw new EngineError("BAD_PLAN", (e as Error).message);
  }
  if (plan.expiresAt <= ctx.now) throw new EngineError("EXPIRY_IN_PAST");
  if (plan.expiresAt - ctx.now > LIMITS.MAX_STRATEGY_DURATION_SECONDS) throw new EngineError("DURATION_TOO_LONG");
  for (const a of plan.actions) if (a.deadline !== 0 && a.deadline <= ctx.now) throw new EngineError("EXPIRY_IN_PAST", "action deadline in the past");
  if (plan.maxFeeBps > (ctx.maxFeeBpsCap ?? LIMITS.MAX_FEE_BPS)) throw new EngineError("FEE_ABOVE_CAP");
  if (ctx.isMintAllowed) for (const m of plan.mints) if (!ctx.isMintAllowed(m)) throw new EngineError("MINT_NOT_ALLOWED", m);
  const perMint = reservationByMint(plan);
  let vault: VaultState;
  try {
    vault = reserve(vault0, perMint);
  } catch (e) {
    throw new EngineError("INSUFFICIENT_AVAILABLE", (e as Error).message);
  }
  vault.strategyCount += 1;
  const holdings = plan.allocations.map((al) => plan.mints.map((_, mi) => (mi === al.mint ? al.amount : 0n)));
  const strategy: StrategyState = {
    address: ctx.address,
    vault: vault0.address,
    owner: ctx.owner,
    planHash: planHash(bytes),
    plan,
    status: "ACTIVE",
    createdBy: ctx.createdBy ?? { kind: "owner" },
    activatedAt: ctx.now,
    closedAt: null,
    holdings,
    groupClaims: new Array(LIMITS.MAX_GROUPS).fill(0),
    actions: plan.actions.map(() => ({
      runsDone: 0,
      executedRuns: 0,
      firstExecutedAt: null,
      lastExecutedAt: null,
      received: 0n,
      spent: 0n,
      fees: 0n,
    })),
    execNonce: 0,
  };
  return { vault, strategy };
}

/** Σ holdings by mint for a set of strategies (for ledger invariant checks). */
export function holdingsByMint(strategies: StrategyState[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const s of strategies) {
    if (s.status !== "ACTIVE" && s.status !== "PAUSED") continue;
    s.holdings.forEach((row) =>
      row.forEach((amt, mi) => {
        const mint = s.plan.mints[mi]!;
        out[mint] = (out[mint] ?? 0n) + amt;
      }),
    );
  }
  return out;
}

/** Next moment anything about this strategy can change on its own (keeper scheduling, simulator clock). */
export function nextWakeTime(s: StrategyState, ctx: ChainContext): number {
  if (s.status !== "ACTIVE") return INF;
  let next = s.plan.expiresAt;
  const times = guardTimes(s, ctx);
  s.plan.actions.forEach((a, i) => {
    const r = actionReadiness(s, i, ctx, times);
    if (r.state === "scheduled") next = Math.min(next, r.at);
    if (r.state !== "done") next = Math.min(next, actionDeadline(s.plan, a));
  });
  for (const key of s.plan.events) {
    const e = ctx.events[key];
    if (e?.status === "PENDING" && e.finalAt !== null && e.finalAt > ctx.now) next = Math.min(next, e.finalAt);
    if (e?.adapter === "BALANCE" && e.status === "OPEN" && e.deadline !== undefined && e.deadline + 1 > ctx.now) next = Math.min(next, e.deadline + 1);
  }
  // vetoes: evaluation times trigger.t + window
  s.plan.nodes.forEach((n) => {
    if (n.op === 6) {
      const trig = times[n.children[0]!];
      if (trig && trig.t !== INF && trig.t + n.param > ctx.now) next = Math.min(next, trig.t + n.param);
    }
  });
  return next;
}

