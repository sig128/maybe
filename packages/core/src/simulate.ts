import { NONE } from "./limits.ts";
import { ActionKind, NodeOp, actionDeadline, type Plan } from "./plan.ts";
import { evaluateNodes, truthAt, INF, type EventView } from "./predicate.ts";
import {
  activateStrategy,
  actionReadiness,
  allActionsTerminal,
  closeStrategy,
  executeAction,
  guardTimes,
  nextWakeTime,
  type ChainContext,
  type StrategyState,
  type Venue,
} from "./engine.ts";
import { deposit, emptyVault } from "./ledger.ts";
import { encodePlan } from "./plan.ts";

/**
 * Outcome-path simulator. Enumerates every combination of event results
 * (YES / NO / VOID / unresolved at expiry, plus "late" variants for events used
 * as vetoes) and runs the real execution engine over a canonical timeline.
 * This is what the review screen shows before anyone signs.
 */

export type ScenarioValue = "YES" | "NO" | "VOID" | "UNRESOLVED" | "YES_LATE" | "NO_LATE";

export const SCENARIO_LABEL: Record<ScenarioValue, string> = {
  YES: "YES",
  NO: "NO",
  VOID: "voided",
  UNRESOLVED: "unresolved at expiry",
  YES_LATE: "YES after the veto window",
  NO_LATE: "NO after the veto window",
};

export interface SimulationOptions {
  /** activation time */
  start: number;
  /** fill model: 'worst' fills every swap at exactly its minimum received (the guaranteed bound) */
  fill?: "worst" | ((req: Parameters<Venue["swap"]>[0]) => bigint);
  /** maximum combinations to enumerate fully (default 4096) */
  maxCombos?: number;
  /** event adapters by plan index (balance events cannot stay unresolved past their deadline) */
  eventDeadlines?: Array<number | undefined>;
}

export interface ExecutedAction {
  action: number;
  runs: number;
  spent: bigint;
  fees: bigint;
  received: bigint;
}

export interface PathResult {
  values: ScenarioValue[];
  eventTimes: Array<number | null>;
  executed: ExecutedAction[];
  end: "COMPLETED" | "EXPIRED";
  closedAt: number;
  refunded: Record<string, bigint>;
  /** value leaving the vault: swap inputs, transfers and fees (releases are not spend) */
  spentByMint: Record<string, bigint>;
  feesByMint: Record<string, bigint>;
  receivedByMint: Record<string, bigint>;
  /** max(0, spent - received) per asset: what this path can cost you in that asset */
  netSpendByMint: Record<string, bigint>;
  transfers: Record<string, Record<string, bigint>>;
  signature: string;
}

export interface PathGroup {
  /** human description, e.g. "A: YES · B: NO or voided" */
  description: string;
  boxes: Array<Array<ScenarioValue[] | null>>;
  count: number;
  representative: PathResult;
}

export interface SimulationReport {
  combos: number;
  enumeration: "full" | "partial";
  paths: PathGroup[];
  worstCase: {
    /** gross outflow, including re-spent proceeds */
    spendByMint: Record<string, bigint>;
    /** the most any single path can cost you per asset */
    netSpendByMint: Record<string, bigint>;
    feesByMint: Record<string, bigint>;
    transfersByRecipient: Record<string, Record<string, bigint>>;
  };
  reservationByMint: Record<string, bigint>;
  eventDomains: ScenarioValue[][];
}

function vetoEvents(plan: Plan): Set<number> {
  const s = new Set<number>();
  plan.nodes.forEach((n) => {
    if (n.op === NodeOp.VETO) s.add(n.a);
  });
  return s;
}

export function eventDomains(plan: Plan, opts: Pick<SimulationOptions, "eventDeadlines" | "start"> = { start: 0 }): ScenarioValue[][] {
  const vetoes = vetoEvents(plan);
  return plan.events.map((_, i) => {
    const d: ScenarioValue[] = ["YES", "NO", "VOID"];
    const dl = opts.eventDeadlines?.[i];
    if (dl === undefined || dl >= plan.expiresAt) d.push("UNRESOLVED");
    if (vetoes.has(i)) d.push("YES_LATE", "NO_LATE");
    return d;
  });
}

function* product(domains: ScenarioValue[][]): Generator<ScenarioValue[]> {
  const n = domains.length;
  if (n === 0) {
    yield [];
    return;
  }
  const idx = new Array(n).fill(0);
  while (true) {
    yield idx.map((v, i) => domains[i]![v]!);
    let k = n - 1;
    while (k >= 0) {
      idx[k]++;
      if (idx[k] < domains[k]!.length) break;
      idx[k] = 0;
      k--;
    }
    if (k < 0) return;
  }
}

function timeline(plan: Plan, start: number) {
  const n = plan.events.length;
  const span = Math.max(plan.expiresAt - start, 1);
  const step = Math.max(1, Math.floor(Math.min(86_400, span / (n + 3))));
  const maxWindow = plan.nodes.reduce((m, nd) => (nd.op === NodeOp.VETO ? Math.max(m, nd.param) : m), 0);
  const early = (i: number) => start + (i + 1) * step;
  const late = start + (n + 1) * step + maxWindow + 1;
  return { early, late, step };
}

function eventViewsAt(values: ScenarioValue[], times: Array<number | null>, now: number): EventView[] {
  return values.map((v, i) => {
    const t = times[i];
    if (v === "UNRESOLVED" || t === null || t === undefined || t > now) return { status: "OPEN", outcome: null, finalAt: null, adapter: "ATTESTATION" };
    const outcome = v === "YES" || v === "YES_LATE" ? "YES" : v === "NO" || v === "NO_LATE" ? "NO" : "VOID";
    return { status: "FINAL", outcome, finalAt: t, adapter: "ATTESTATION" };
  });
}

/** Static truth of every node at the end of the canonical timeline for one scenario. */
export function scenarioTruth(plan: Plan, values: ScenarioValue[], start: number) {
  const tl = timeline(plan, start);
  const times = values.map((v, i) => (v === "UNRESOLVED" ? null : v.endsWith("_LATE") ? tl.late : tl.early(i)));
  const now = plan.expiresAt - 1;
  const views = eventViewsAt(values, times, now);
  const nodeTimes = evaluateNodes(plan, {
    now,
    activatedAt: start,
    event: (i) => views[i],
    // receipts are dynamic; static analysis treats them as pending
    receipt: () => undefined,
  });
  return nodeTimes.map((t) => truthAt(t, now));
}

export function simulatePath(plan: Plan, values: ScenarioValue[], opts: SimulationOptions): PathResult {
  const start = opts.start;
  const tl = timeline(plan, start);
  const eventTimes = values.map((v, i) => (v === "UNRESOLVED" ? null : v.endsWith("_LATE") ? tl.late : tl.early(i)));
  const owner = "sim-owner";
  let vault = emptyVault("sim-vault", owner);
  const reservation: Record<string, bigint> = {};
  plan.allocations.forEach((a) => {
    const m = plan.mints[a.mint]!;
    reservation[m] = (reservation[m] ?? 0n) + a.amount;
  });
  for (const [m, amt] of Object.entries(reservation)) vault = deposit(vault, m, amt);
  const bytes = encodePlan(plan);
  const act = activateStrategy(vault, bytes, { now: start, address: "sim-strategy", owner });
  vault = act.vault;
  let s: StrategyState = act.strategy;
  const fill = opts.fill ?? "worst";
  const venue: Venue = {
    swap: (req) => ({ spentIn: req.amountIn, receivedOut: fill === "worst" ? req.minOut : fill(req) }),
  };
  const ctxAt = (now: number): ChainContext => {
    const views = eventViewsAt(values, eventTimes, now);
    const events: Record<string, EventView> = {};
    plan.events.forEach((k, i) => (events[k] = views[i]!));
    return { now, executionPaused: false, events, strategies: {} };
  };
  const spentByMint: Record<string, bigint> = {};
  const feesByMint: Record<string, bigint> = {};
  const receivedByMint: Record<string, bigint> = {};
  const transfers: Record<string, Record<string, bigint>> = {};
  const add = (rec: Record<string, bigint>, k: string, v: bigint) => (rec[k] = (rec[k] ?? 0n) + v);
  let now = start;
  let end: PathResult["end"] = "EXPIRED";
  let guardSteps = 0;
  while (now < plan.expiresAt && guardSteps++ < 10_000) {
    let progressed = true;
    let inner = 0;
    while (progressed && inner++ < 1000) {
      progressed = false;
      const ctx = ctxAt(now);
      const times = guardTimes(s, ctx);
      for (let i = 0; i < plan.actions.length; i++) {
        const r = actionReadiness(s, i, ctx, times);
        if (r.state !== "executable") continue;
        const res = executeAction(vault, s, i, ctx, venue, { expectedPlanHash: s.planHash, expectedRun: r.run });
        if (!res.ok) continue;
        vault = res.vault;
        s = res.strategy;
        const a = plan.actions[i]!;
        const rc = res.receipt;
        if (a.kind === ActionKind.SWAP) {
          add(spentByMint, rc.inMint, rc.amount);
          add(receivedByMint, rc.outMint!, rc.amountOut);
        } else if (a.kind === ActionKind.TRANSFER) {
          add(spentByMint, rc.inMint, rc.amount);
          transfers[rc.recipient!] ??= {};
          add(transfers[rc.recipient!]!, rc.inMint, rc.amountOut);
        }
        if (rc.fee > 0n) add(feesByMint, rc.inMint, rc.fee);
        progressed = true;
        break; // re-evaluate after every state change
      }
    }
    const ctx = ctxAt(now);
    if (allActionsTerminal(s, ctx)) {
      end = "COMPLETED";
      break;
    }
    let next = nextWakeTime(s, ctx);
    for (const t of eventTimes) if (t !== null && t > now) next = Math.min(next, t);
    if (next === INF || next <= now) next = now + 1;
    now = Math.min(next, plan.expiresAt);
  }
  const closeNow = end === "COMPLETED" ? now : plan.expiresAt;
  const closed = closeStrategy(vault, s, end === "COMPLETED" ? "COMPLETE" : "EXPIRE", ctxAt(closeNow));
  const refunded = closed.ok ? closed.refunded : {};
  const executed: ExecutedAction[] = s.actions
    .map((st, i) => ({ action: i, runs: st.executedRuns, spent: st.spent, fees: st.fees, received: st.received }))
    .filter((e) => e.runs > 0);
  const signature = `${end}|${executed.map((e) => `${e.action}x${e.runs}`).join(",")}`;
  const netSpendByMint: Record<string, bigint> = {};
  for (const [m, v] of Object.entries(spentByMint)) {
    const net = v - (receivedByMint[m] ?? 0n);
    if (net > 0n) netSpendByMint[m] = net;
  }
  return { values, eventTimes, executed, end, closedAt: closeNow, refunded, spentByMint, feesByMint, receivedByMint, netSpendByMint, transfers, signature };
}

function describeBoxes(boxes: Array<Array<ScenarioValue[] | null>>, refs: string[]): string {
  return boxes
    .map((box) => {
      const parts = box
        .map((vals, i) => (vals ? `${refs[i] ?? `E${i}`}: ${vals.map((v) => SCENARIO_LABEL[v]).join(" or ")}` : null))
        .filter(Boolean);
      return parts.length ? parts.join(" · ") : "Every outcome";
    })
    .join("  |  ");
}

/** Cover a set of scenario vectors with product boxes ("A: YES · B: any"). */
export function coverWithBoxes(vectors: ScenarioValue[][], domains: ScenarioValue[][]): Array<Array<ScenarioValue[] | null>> {
  if (domains.length === 0) return [[]];
  const key = (v: ScenarioValue[]) => v.join("|");
  const inGroup = new Set(vectors.map(key));
  const remaining = new Set(inGroup);
  const boxes: Array<Array<ScenarioValue[] | null>> = [];
  const boxVectors = (box: ScenarioValue[][]) => [...product(box)];
  while (remaining.size > 0) {
    const first = [...remaining][0]!.split("|") as ScenarioValue[];
    const box: ScenarioValue[][] = first.map((v) => [v]);
    for (let d = 0; d < box.length; d++) {
      for (const val of domains[d]!) {
        if (box[d]!.includes(val)) continue;
        const trial = box.map((b, i) => (i === d ? [...b, val] : b));
        if (boxVectors(trial).every((v) => inGroup.has(key(v)))) box[d] = trial[d]!;
      }
    }
    for (const v of boxVectors(box)) remaining.delete(key(v));
    boxes.push(box.map((vals, d) => (vals.length === domains[d]!.length ? null : vals.sort((a, b) => domains[d]!.indexOf(a) - domains[d]!.indexOf(b)))));
    if (boxes.length > 64) break;
  }
  return boxes;
}

export function simulatePlan(plan: Plan, opts: SimulationOptions, eventRefs?: string[]): SimulationReport {
  let domains = eventDomains(plan, opts);
  const total = domains.reduce((m, d) => m * d.length, 1);
  const maxCombos = opts.maxCombos ?? 4096;
  let enumeration: SimulationReport["enumeration"] = "full";
  if (total > maxCombos) {
    enumeration = "partial";
    domains = domains.map((d) => d.filter((v) => v === "YES" || v === "NO"));
  }
  const groups = new Map<string, { vectors: ScenarioValue[][]; rep: PathResult }>();
  const worst = { spendByMint: {} as Record<string, bigint>, netSpendByMint: {} as Record<string, bigint>, feesByMint: {} as Record<string, bigint>, transfersByRecipient: {} as Record<string, Record<string, bigint>> };
  const maxInto = (rec: Record<string, bigint>, src: Record<string, bigint>) => {
    for (const [k, v] of Object.entries(src)) if (v > (rec[k] ?? 0n)) rec[k] = v;
  };
  let combos = 0;
  const visit = (values: ScenarioValue[]) => {
    combos++;
    const r = simulatePath(plan, values, opts);
    const g = groups.get(r.signature);
    if (g) g.vectors.push(values);
    else groups.set(r.signature, { vectors: [values], rep: r });
    maxInto(worst.spendByMint, r.spentByMint);
    maxInto(worst.netSpendByMint, r.netSpendByMint);
    maxInto(worst.feesByMint, r.feesByMint);
    for (const [rcp, by] of Object.entries(r.transfers)) {
      worst.transfersByRecipient[rcp] ??= {};
      maxInto(worst.transfersByRecipient[rcp]!, by);
    }
  };
  for (const values of product(domains)) visit(values);
  if (enumeration === "partial") {
    // add the all-unresolved path and single-void paths so refund behaviour is always shown
    const n = plan.events.length;
    visit(new Array(n).fill("UNRESOLVED"));
    for (let i = 0; i < n; i++) visit(Array.from({ length: n }, (_, j) => (j === i ? "VOID" : "YES")) as ScenarioValue[]);
  }
  const refs = eventRefs ?? plan.events.map((_, i) => String.fromCharCode(65 + i));
  const fullDomains = enumeration === "full" ? domains : eventDomains(plan, opts);
  const paths: PathGroup[] = [...groups.values()].map(({ vectors, rep }) => {
    const boxes = enumeration === "full" ? coverWithBoxes(vectors, domains) : vectors.map((v) => v.map((x) => [x]));
    return { description: describeBoxes(boxes, refs), boxes, count: vectors.length, representative: rep };
  });
  // most consequential first: more spend first, then more combinations
  paths.sort((a, b) => b.representative.executed.length - a.representative.executed.length || b.count - a.count);
  const reservationByMint: Record<string, bigint> = {};
  plan.allocations.forEach((a) => {
    const m = plan.mints[a.mint]!;
    reservationByMint[m] = (reservationByMint[m] ?? 0n) + a.amount;
  });
  return { combos, enumeration, paths, worstCase: worst, reservationByMint, eventDomains: fullDomains };
}

/** Earliest possible time each action could first run, assuming its guard became true at `start`. */
export function earliestRunTimes(plan: Plan, start: number): number[] {
  return plan.actions.map((a) => Math.min(start + a.delay, actionDeadline(plan, a)));
}

export { NONE };
