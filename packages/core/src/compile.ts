import { NONE } from "./limits.ts";
import {
  ACTION_FLAG_MIN_OUT_IS_RATE,
  ACTION_FLAG_MISSED_CATCH_UP,
  ActionKind,
  AmountKind,
  NodeOp,
  OUTCOME_NO,
  OUTCOME_YES,
  PLAN_FLAG_CANCEL_LOCKED,
  PLAN_VERSION,
  RouteKind,
  checkPlanStructure,
  encodePlan,
  planHash,
  type Plan,
  type PlanAction,
  type PlanNode,
} from "./plan.ts";
import type { Action, PredicateNode, Strategy } from "./schema.ts";

export interface SourceMap {
  events: string[];
  allocations: string[];
  nodes: string[];
  actions: string[];
  mints: string[];
  refs: string[];
  groups: string[];
  /** branch ids per group index */
  branches: string[][];
}

export interface Compiled {
  plan: Plan;
  bytes: Uint8Array;
  hash: string;
  sourceMap: SourceMap;
}

export interface CompileIssue {
  code: string;
  message: string;
  target: { kind: "strategy" | "event" | "allocation" | "node" | "action"; id?: string; field?: string };
}

export class CompileError extends Error {
  constructor(public readonly issues: CompileIssue[]) {
    super(issues.map((i) => i.message).join("; "));
    this.name = "CompileError";
  }
}

const ROUTE_KIND: Record<string, RouteKind> = {
  "cp-swap": RouteKind.CP_SWAP,
  "outcome-buy": RouteKind.OUTCOME_BUY,
  "outcome-redeem": RouteKind.OUTCOME_REDEEM,
};

function actionMints(a: Action): string[] {
  return a.kind === "swap" ? [a.inputMint, a.outputMint] : [a.mint];
}

/**
 * Compile a (schema-valid, validated) strategy document to its canonical plan.
 * Deterministic: the same document always yields byte-identical output.
 * Throws CompileError with located issues instead of guessing.
 */
export function compileStrategy(doc: Strategy): Compiled {
  const issues: CompileIssue[] = [];
  const err = (code: string, message: string, target: CompileIssue["target"]) => issues.push({ code, message, target });

  if (doc.unresolved && doc.unresolved.length > 0) {
    for (const u of doc.unresolved) err("UNRESOLVED", `Open question: ${u.question}`, { kind: "strategy", field: u.field });
    throw new CompileError(issues);
  }

  const eventIndex = new Map(doc.events.map((e, i) => [e.ref, i]));
  const allocIndex = new Map(doc.allocations.map((a, i) => [a.id, i]));
  const actionIndex = new Map(doc.actions.map((a, i) => [a.id, i]));
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));

  // mints: allocation mints first (stable order), then action mints
  const mints: string[] = [];
  const addMint = (m: string) => {
    if (!mints.includes(m)) mints.push(m);
    return mints.indexOf(m);
  };
  doc.allocations.forEach((a) => addMint(a.mint));
  doc.actions.forEach((a) => actionMints(a).forEach(addMint));

  // refs: route pools, recipients, external receipt strategies
  const refs: string[] = [];
  const addRef = (r: string) => {
    if (!refs.includes(r)) refs.push(r);
    return refs.indexOf(r);
  };
  doc.actions.forEach((a) => {
    if (a.kind === "swap") addRef(a.route.pool);
    if (a.kind === "transfer") addRef(a.recipient);
  });
  doc.nodes.forEach((n) => {
    if (n.kind === "receipt" && n.strategy !== "self") addRef(n.strategy);
  });

  // nodes: post-order from action guards, in action order (children before parents)
  const order: string[] = [];
  const visiting = new Set<string>();
  const childIds = (n: PredicateNode): string[] => {
    switch (n.kind) {
      case "not":
        return [n.child];
      case "and":
      case "or":
      case "atLeast":
        return n.children;
      case "veto":
        return [n.trigger];
      default:
        return [];
    }
  };
  const visit = (id: string, from: CompileIssue["target"]) => {
    if (order.includes(id)) return;
    const n = nodeById.get(id);
    if (!n) {
      err("MISSING_NODE", `Condition "${id}" does not exist`, from);
      return;
    }
    if (visiting.has(id)) {
      err("CYCLE", `Condition "${id}" refers to itself`, { kind: "node", id });
      return;
    }
    visiting.add(id);
    for (const c of childIds(n)) visit(c, { kind: "node", id });
    visiting.delete(id);
    if (!order.includes(id)) order.push(id);
  };
  doc.actions.forEach((a) => visit(a.guard, { kind: "action", id: a.id, field: "guard" }));
  const nodeIndex = new Map(order.map((id, i) => [id, i]));

  const nodes: PlanNode[] = order.map((id) => {
    const n = nodeById.get(id)!;
    const base: PlanNode = { op: NodeOp.ALWAYS, a: 0, b: 0, k: 0, children: [], param: 0 };
    const ev = (ref: string) => {
      const i = eventIndex.get(ref);
      if (i === undefined) err("MISSING_EVENT", `Event "${ref}" is not part of this strategy`, { kind: "node", id });
      return i ?? 0;
    };
    const kid = (c: string) => nodeIndex.get(c) ?? 0;
    switch (n.kind) {
      case "always":
        return base;
      case "outcome":
        return { ...base, op: NodeOp.OUTCOME, a: ev(n.event), b: n.outcome === "YES" ? OUTCOME_YES : OUTCOME_NO };
      case "not":
        return { ...base, op: NodeOp.NOT, children: [kid(n.child)] };
      case "and":
        return { ...base, op: NodeOp.AND, children: n.children.map(kid) };
      case "or":
        return { ...base, op: NodeOp.OR, children: n.children.map(kid) };
      case "atLeast":
        if (n.k > n.children.length) err("BAD_THRESHOLD", `At least ${n.k} of ${n.children.length} can never be met`, { kind: "node", id });
        return { ...base, op: NodeOp.ATLEAST, k: n.k, children: n.children.map(kid) };
      case "veto":
        return {
          ...base,
          op: NodeOp.VETO,
          a: ev(n.event),
          b: n.outcome === "YES" ? OUTCOME_YES : OUTCOME_NO,
          children: [kid(n.trigger)],
          param: n.windowSeconds,
        };
      case "receipt": {
        if (n.strategy === "self") {
          const ai = actionIndex.get(n.action);
          if (ai === undefined) err("MISSING_ACTION", `Receipt refers to unknown action "${n.action}"`, { kind: "node", id });
          return { ...base, op: NodeOp.RECEIPT, a: NONE, b: ai ?? 0 };
        }
        const ai = Number.parseInt(n.action, 10);
        if (!Number.isInteger(ai) || ai < 0 || ai > 255) err("BAD_RECEIPT", "External receipt needs an action index", { kind: "node", id });
        return { ...base, op: NodeOp.RECEIPT, a: refs.indexOf(n.strategy), b: ai };
      }
      case "after":
        return { ...base, op: NodeOp.AFTER, param: n.at };
    }
  });

  // branch groups
  const groups: string[] = [];
  const branches: string[][] = [];
  doc.actions.forEach((a) => {
    if (!a.branch) return;
    let g = groups.indexOf(a.branch.group);
    if (g < 0) {
      groups.push(a.branch.group);
      branches.push([]);
      g = groups.length - 1;
    }
    if (!branches[g]!.includes(a.branch.branch)) branches[g]!.push(a.branch.branch);
  });

  const actions: PlanAction[] = doc.actions.map((a) => {
    const at = { kind: "action" as const, id: a.id };
    const alloc = allocIndex.get(a.allocation);
    if (alloc === undefined) err("MISSING_ALLOCATION", `Allocation "${a.allocation}" does not exist`, { ...at, field: "allocation" });
    const guard = nodeIndex.get(a.guard) ?? 0;
    let group = NONE;
    let branch = 0;
    if (a.branch) {
      group = groups.indexOf(a.branch.group);
      branch = branches[group]!.indexOf(a.branch.branch);
    }
    let amountKind = AmountKind.FIXED;
    let amount = 0n;
    let bps = 0;
    let amountRef = NONE;
    switch (a.amount.kind) {
      case "fixed":
        amount = BigInt(a.amount.amount);
        break;
      case "bpsOfAllocation":
        amountKind = AmountKind.BPS_OF_ALLOCATION;
        bps = a.amount.bps;
        break;
      case "bpsOfReceived": {
        amountKind = AmountKind.BPS_OF_RECEIVED;
        bps = a.amount.bps;
        amount = a.amount.cap ? BigInt(a.amount.cap) : 0n;
        const src = actionIndex.get(a.amount.action);
        if (src === undefined) err("MISSING_ACTION", `Proceeds source "${a.amount.action}" does not exist`, { ...at, field: "amount" });
        amountRef = src ?? 0;
        break;
      }
      case "allOfHolding":
        amountKind = AmountKind.ALL_OF_HOLDING;
        amount = a.amount.cap ? BigInt(a.amount.cap) : 0n;
        break;
    }
    let flags = 0;
    const runs = a.schedule?.runs ?? 1;
    const interval = a.schedule?.intervalSeconds ?? 0;
    if (a.schedule?.missed === "catchUp") flags |= ACTION_FLAG_MISSED_CATCH_UP;
    const common = {
      guard,
      alloc: alloc ?? 0,
      group,
      branch,
      amountKind,
      amountRef,
      bps,
      runs,
      delay: a.delaySeconds ?? 0,
      interval,
      amount,
      deadline: a.deadline ?? 0,
    };
    switch (a.kind) {
      case "swap": {
        let minOut: bigint;
        if (a.minOut.kind === "rate") {
          flags |= ACTION_FLAG_MIN_OUT_IS_RATE;
          minOut = BigInt(a.minOut.outPerInE9);
        } else minOut = BigInt(a.minOut.amount);
        return {
          ...common,
          kind: ActionKind.SWAP,
          inMint: mints.indexOf(a.inputMint),
          outMint: mints.indexOf(a.outputMint),
          routeKind: ROUTE_KIND[a.route.kind]!,
          ref: refs.indexOf(a.route.pool),
          flags,
          feeBps: a.feeBps ?? 0,
          minOut,
        };
      }
      case "transfer":
        return {
          ...common,
          kind: ActionKind.TRANSFER,
          inMint: mints.indexOf(a.mint),
          outMint: NONE,
          routeKind: RouteKind.NONE,
          ref: refs.indexOf(a.recipient),
          flags,
          feeBps: a.feeBps ?? 0,
          minOut: 0n,
        };
      case "release":
        return {
          ...common,
          kind: ActionKind.RELEASE,
          inMint: mints.indexOf(a.mint),
          outMint: NONE,
          routeKind: RouteKind.NONE,
          ref: NONE,
          flags,
          feeBps: 0,
          minOut: 0n,
        };
    }
  });

  if (issues.length > 0) throw new CompileError(issues);

  const plan: Plan = {
    version: PLAN_VERSION,
    flags: doc.cancelPolicy === "locked-until-expiry" ? PLAN_FLAG_CANCEL_LOCKED : 0,
    maxFeeBps: doc.maxFeeBps,
    voidPolicy: 0,
    expiresAt: doc.expiresAt,
    nonce: BigInt(doc.nonce),
    events: doc.events.map((e) => e.eventKey),
    mints,
    refs,
    allocations: doc.allocations.map((a) => ({ mint: mints.indexOf(a.mint), amount: BigInt(a.amount) })),
    nodes,
    actions,
  };

  const sourceMap: SourceMap = {
    events: doc.events.map((e) => e.ref),
    allocations: doc.allocations.map((a) => a.id),
    nodes: order,
    actions: doc.actions.map((a) => a.id),
    mints,
    refs,
    groups,
    branches,
  };

  const structural = checkPlanStructure(plan);
  if (structural.length > 0) {
    throw new CompileError(
      structural.map((s) => ({
        code: s.code,
        message: s.message,
        target:
          s.at?.kind === "node" && s.at.index !== undefined
            ? { kind: "node", id: sourceMap.nodes[s.at.index] }
            : s.at?.kind === "action" && s.at.index !== undefined
              ? { kind: "action", id: sourceMap.actions[s.at.index] }
              : s.at?.kind === "allocation" && s.at.index !== undefined
                ? { kind: "allocation", id: sourceMap.allocations[s.at.index] }
                : { kind: "strategy" },
      })),
    );
  }

  const bytes = encodePlan(plan);
  return { plan, bytes, hash: planHash(bytes), sourceMap };
}
