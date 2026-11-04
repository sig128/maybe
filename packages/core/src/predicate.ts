import { NONE } from "./limits.ts";
import { NodeOp, OUTCOME_NO, OUTCOME_YES, type Plan } from "./plan.ts";
import type { FinalOutcome } from "./schema.ts";

/**
 * Predicate semantics — "time-of-truth" evaluation.
 *
 * Every node evaluates to a pair of times (t, f): the earliest moment the node
 * became determinately TRUE, and the earliest moment it became determinately
 * FALSE, using only finalization timestamps recorded on-chain. ∞ means "not
 * (yet) determined". Because inputs are final, recorded facts, (t, f) can only
 * move from ∞ to a finite value, never change afterwards, and never depend on
 * when a keeper happens to look. That is what makes delays, vetoes and
 * milestones deterministic. The vault program implements the identical rules
 * (programs/maybe-vault/src/predicate.rs) and both are checked against shared
 * conformance fixtures.
 *
 *   OUTCOME(e,o): t = finalAt if e final with outcome o; f = finalAt if final with
 *                 any other outcome (including VOID: "void-is-false").
 *   NOT(x):       t = x.f, f = x.t          (NOT of an unresolved event is unresolved)
 *   AND(xs):      t = max x.t, f = min x.f
 *   OR(xs):       t = min x.t, f = max x.f
 *   ATLEAST(k):   t = k-th smallest x.t, f = (n-k+1)-th smallest x.f
 *   VETO(e,o,trigger,W): let T = trigger.t + W (evaluation time).
 *                 If e final with o at v: v <= T -> f = v (vetoed); v > T -> t = T (veto too late).
 *                 If e final with another outcome at u: t = min(T, u).
 *                 If e not final: t = T once now >= T (no veto by evaluation time), else unknown.
 *   RECEIPT(s,a): t = first successful execution of action a; f = when it became impossible.
 *   AFTER(at):    t = at once now >= at.
 *   ALWAYS:       t = strategy activation time.
 *
 * Value at `now`: TRUE if t <= now, FALSE if f <= now, otherwise PENDING.
 */

export const INF = Number.POSITIVE_INFINITY;

export type EventStatus = "OPEN" | "PENDING" | "DISPUTED" | "FINAL";
export type AdapterRuntime = "ATTESTATION" | "BALANCE";

export interface EventView {
  status: EventStatus;
  /** proposed (PENDING) or final (FINAL) outcome */
  outcome: FinalOutcome | null;
  /** PENDING: scheduled finality (proposedAt + challenge window). FINAL: when it became final. */
  finalAt: number | null;
  adapter: AdapterRuntime;
  /** BALANCE adapter: last second at which a qualifying observation counts */
  deadline?: number;
}

export interface EffectiveEvent {
  final: boolean;
  outcome?: FinalOutcome;
  finalAt?: number;
}

/**
 * Lazy finality: a PENDING attestation whose challenge window has elapsed is
 * final without needing a separate crank; a balance-threshold event still OPEN
 * after its deadline is final NO at deadline + 1. DISPUTED is never final.
 */
export function effectiveEvent(e: EventView | undefined, now: number): EffectiveEvent {
  if (!e) return { final: false };
  if (e.status === "FINAL" && e.outcome && e.finalAt !== null && e.finalAt <= now) return { final: true, outcome: e.outcome, finalAt: e.finalAt };
  if (e.status === "PENDING" && e.outcome && e.finalAt !== null && now >= e.finalAt) {
    return { final: true, outcome: e.outcome, finalAt: e.finalAt };
  }
  if (e.adapter === "BALANCE" && e.status === "OPEN" && e.deadline !== undefined && now > e.deadline) {
    return { final: true, outcome: "NO", finalAt: e.deadline + 1 };
  }
  return { final: false };
}

export interface ReceiptView {
  /** first successful execution time of the referenced action */
  executedAt: number | null;
  /** when execution became impossible (strategy closed / action terminal without executing) */
  impossibleAt: number | null;
}

export interface EvalContext {
  now: number;
  activatedAt: number;
  event(index: number): EventView | undefined;
  /** refIndex === NONE means "this strategy" */
  receipt(refIndex: number, actionIndex: number): ReceiptView | undefined;
}

export interface Times {
  t: number;
  f: number;
}

export type Truth = "TRUE" | "FALSE" | "PENDING";

function kthSmallest(values: number[], k: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[k - 1] ?? INF;
}

/** Evaluate every node in index order (children always precede parents). */
export function evaluateNodes(plan: Plan, ctx: EvalContext): Times[] {
  const out: Times[] = [];
  const now = ctx.now;
  for (const n of plan.nodes) {
    const kids = n.children.map((c) => out[c] ?? { t: INF, f: INF });
    let r: Times;
    switch (n.op) {
      case NodeOp.ALWAYS:
        r = { t: ctx.activatedAt <= now ? ctx.activatedAt : INF, f: INF };
        break;
      case NodeOp.OUTCOME: {
        const eff = effectiveEvent(ctx.event(n.a), now);
        const want: FinalOutcome = n.b === OUTCOME_YES ? "YES" : "NO";
        if (!eff.final || eff.finalAt === undefined) r = { t: INF, f: INF };
        else if (eff.outcome === want) r = { t: eff.finalAt, f: INF };
        else r = { t: INF, f: eff.finalAt };
        break;
      }
      case NodeOp.NOT: {
        const c = kids[0]!;
        r = { t: c.f, f: c.t };
        break;
      }
      case NodeOp.AND:
        r = { t: Math.max(...kids.map((k) => k.t)), f: Math.min(...kids.map((k) => k.f)) };
        break;
      case NodeOp.OR:
        r = { t: Math.min(...kids.map((k) => k.t)), f: Math.max(...kids.map((k) => k.f)) };
        break;
      case NodeOp.ATLEAST:
        r = {
          t: kthSmallest(kids.map((k) => k.t), n.k),
          f: kthSmallest(kids.map((k) => k.f), kids.length - n.k + 1),
        };
        break;
      case NodeOp.VETO: {
        const trigger = kids[0]!;
        const T = trigger.t === INF ? INF : trigger.t + n.param;
        const eff = effectiveEvent(ctx.event(n.a), now);
        const vetoOutcome: FinalOutcome = n.b === OUTCOME_YES ? "YES" : "NO";
        if (eff.final && eff.finalAt !== undefined) {
          if (eff.outcome === vetoOutcome) {
            r = eff.finalAt <= T ? { t: INF, f: eff.finalAt } : { t: T, f: INF };
          } else {
            r = { t: Math.min(T, eff.finalAt), f: INF };
          }
        } else {
          r = { t: T <= now ? T : INF, f: INF };
        }
        break;
      }
      case NodeOp.RECEIPT: {
        const rv = ctx.receipt(n.a, n.b);
        r = {
          t: rv?.executedAt ?? INF,
          f: rv?.executedAt === null || rv?.executedAt === undefined ? (rv?.impossibleAt ?? INF) : INF,
        };
        break;
      }
      case NodeOp.AFTER:
        r = { t: n.param <= now ? n.param : INF, f: INF };
        break;
      default:
        r = { t: INF, f: INF };
    }
    // Invariant: a node can't be both TRUE and FALSE. Treat a contradiction as pending (fail closed).
    if (r.t !== INF && r.f !== INF) r = { t: INF, f: INF };
    out.push(r);
  }
  return out;
}

export function truthAt(times: Times | undefined, now: number): Truth {
  if (!times) return "PENDING";
  if (times.t <= now) return "TRUE";
  if (times.f <= now) return "FALSE";
  return "PENDING";
}

export const SELF = NONE;
export { OUTCOME_NO, OUTCOME_YES };
