import { LIMITS } from "./limits.ts";
import { formatAmount } from "./money.ts";
import { assetSupport, type AssetInfo } from "./assets.ts";
import { compileStrategy, CompileError, type Compiled } from "./compile.ts";
import { ActionKind, AmountKind, actionDeadline } from "./plan.ts";
import { parseStrategy, type Strategy, type PredicateNode, type VenueId } from "./schema.ts";
import { eventDomains, scenarioTruth, type ScenarioValue } from "./simulate.ts";

/**
 * Deterministic validation. Every issue points at the exact place in the
 * document where it occurs so the builder can highlight it in the sentence,
 * graph and list views.
 */

export type Severity = "error" | "warning" | "info";

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  target: { kind: "strategy" | "event" | "allocation" | "node" | "action"; id?: string; field?: string };
}

export interface MarketCapability {
  venue: VenueId;
  /** can this event's outcome be enforced on-chain as a funded trigger in this environment? */
  executable: boolean;
  reason?: string;
  status?: "open" | "closed" | "resolved" | "voided" | "disputed";
  binary: boolean;
  resolvesBy?: number;
}

export interface PoolCapability {
  routeKinds: Array<"cp-swap" | "outcome-buy" | "outcome-redeem">;
  mints: [string, string];
  executable: boolean;
  reason?: string;
}

export interface ValidationContext {
  now: number;
  assets?: Record<string, AssetInfo>;
  markets?: Record<string, MarketCapability>;
  pools?: Record<string, PoolCapability>;
  /** vault available balances, to warn when the reservation does not fit */
  availableByMint?: Record<string, bigint>;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  compiled?: Compiled;
  strategy?: Strategy;
}

function childIds(n: PredicateNode): string[] {
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
}

export function validateStrategy(input: unknown, ctx: ValidationContext): ValidationResult {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, target: Issue["target"]) => issues.push({ code, severity, message, target });
  const parsed = parseStrategy(input);
  if (!parsed.ok) {
    for (const m of parsed.issues) add("error", "SCHEMA", m, { kind: "strategy" });
    return { ok: false, issues };
  }
  const doc = parsed.value;

  for (const u of doc.unresolved ?? []) add("error", "UNRESOLVED", `Needs an answer: ${u.question}`, { kind: "strategy", field: u.field });

  // ids
  const seen = new Map<string, string>();
  const claim = (id: string, kind: string, target: Issue["target"]) => {
    if (seen.has(id)) add("error", "DUPLICATE_ID", `"${id}" is used by both a ${seen.get(id)} and a ${kind}`, target);
    else seen.set(id, kind);
  };
  doc.nodes.forEach((n) => claim(n.id, "condition", { kind: "node", id: n.id }));
  doc.actions.forEach((a) => claim(a.id, "action", { kind: "action", id: a.id }));
  doc.allocations.forEach((a) => claim(a.id, "allocation", { kind: "allocation", id: a.id }));
  const eventRefs = new Set<string>();
  doc.events.forEach((e) => {
    if (eventRefs.has(e.ref)) add("error", "DUPLICATE_EVENT", `Event label ${e.ref} is used twice`, { kind: "event", id: e.ref });
    eventRefs.add(e.ref);
  });
  const keys = new Set<string>();
  doc.events.forEach((e) => {
    if (keys.has(e.eventKey)) add("error", "DUPLICATE_EVENT", `The same market is referenced twice (${e.ref})`, { kind: "event", id: e.ref });
    keys.add(e.eventKey);
  });

  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const allocById = new Map(doc.allocations.map((a) => [a.id, a]));
  const actionById = new Map(doc.actions.map((a) => [a.id, a]));

  // references and node shape
  for (const n of doc.nodes) {
    const at = { kind: "node" as const, id: n.id };
    for (const c of childIds(n)) if (!nodeById.has(c)) add("error", "MISSING_NODE", `Refers to missing condition "${c}"`, at);
    if ((n.kind === "outcome" || n.kind === "veto") && !eventRefs.has(n.event)) add("error", "MISSING_EVENT", `Event ${n.event} is not in this strategy`, at);
    if (n.kind === "atLeast" && n.k > n.children.length) add("error", "BAD_THRESHOLD", `At least ${n.k} of ${n.children.length} can never be met`, at);
    if (n.kind === "atLeast" && n.k === n.children.length) add("info", "THRESHOLD_IS_AND", `At least ${n.k} of ${n.k} is the same as "all of"`, at);
    if (n.kind === "receipt" && n.strategy === "self" && !actionById.has(n.action)) add("error", "MISSING_ACTION", `Receipt refers to missing action "${n.action}"`, at);
    if (n.kind === "after" && n.at >= doc.expiresAt) add("warning", "AFTER_EXPIRY", "This time is after the strategy expires, so it never becomes true", at);
  }
  // cycles + depth
  const depthMemo = new Map<string, number>();
  const stack = new Set<string>();
  const depth = (id: string): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    if (stack.has(id)) {
      add("error", "CYCLE", `Condition "${id}" depends on itself`, { kind: "node", id });
      return 0;
    }
    const n = nodeById.get(id);
    if (!n) return 0;
    stack.add(id);
    const d = 1 + Math.max(0, ...childIds(n).map(depth));
    stack.delete(id);
    depthMemo.set(id, d);
    return d;
  };
  for (const n of doc.nodes) if (depth(n.id) > LIMITS.MAX_DEPTH) add("error", "TOO_DEEP", `Conditions nest deeper than ${LIMITS.MAX_DEPTH} levels`, { kind: "node", id: n.id });
  // unused conditions
  const reachable = new Set<string>();
  const mark = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const n = nodeById.get(id);
    if (n) childIds(n).forEach(mark);
  };
  doc.actions.forEach((a) => mark(a.guard));
  doc.nodes.forEach((n) => {
    if (!reachable.has(n.id)) add("info", "UNUSED_CONDITION", "This condition is not used by any action and will not be authorized", { kind: "node", id: n.id });
  });
  doc.events.forEach((e) => {
    const used = doc.nodes.some((n) => reachable.has(n.id) && (n.kind === "outcome" || n.kind === "veto") && n.event === e.ref);
    if (!used) add("warning", "UNUSED_EVENT", `Event ${e.ref} is not used by any action`, { kind: "event", id: e.ref });
  });

  // time
  const H = { kind: "strategy" as const };
  if (doc.expiresAt <= ctx.now) add("error", "EXPIRY_IN_PAST", "The expiry is in the past", { ...H, field: "expiresAt" });
  else if (doc.expiresAt - ctx.now > LIMITS.MAX_STRATEGY_DURATION_SECONDS)
    add("error", "DURATION_TOO_LONG", `Strategies can last at most ${Math.floor(LIMITS.MAX_STRATEGY_DURATION_SECONDS / 86400)} days`, { ...H, field: "expiresAt" });

  // events: capability + timing
  for (const e of doc.events) {
    const at = { kind: "event" as const, id: e.ref };
    const cap = ctx.markets?.[e.eventKey];
    if (ctx.markets && !cap) add("error", "UNKNOWN_EVENT", `${e.ref} is not a registered market in this environment`, at);
    if (cap) {
      if (!cap.executable) add("error", "VENUE_READ_ONLY", cap.reason ?? `${e.venue} markets can be read here but cannot trigger funded actions`, at);
      if (!cap.binary) add("error", "NOT_BINARY", "Only binary YES/NO markets are supported as triggers", at);
      if (cap.status === "resolved" || cap.status === "voided") add("error", "ALREADY_RESOLVED", "This market has already resolved", at);
      if (cap.status === "disputed") add("warning", "DISPUTED", "This market is currently disputed", at);
    }
    const resolvesBy = cap?.resolvesBy ?? e.resolvesBy;
    if (resolvesBy !== undefined && resolvesBy > doc.expiresAt)
      add("warning", "MAY_RESOLVE_AFTER_EXPIRY", `${e.ref} may resolve after this strategy expires; if so its branches never run and funds are refunded`, at);
  }

  // allocations
  const reservation: Record<string, bigint> = {};
  for (const al of doc.allocations) {
    const at = { kind: "allocation" as const, id: al.id };
    if (BigInt(al.amount) === 0n) add("error", "ZERO_ALLOCATION", "Allocation amount must be greater than zero", { ...at, field: "amount" });
    reservation[al.mint] = (reservation[al.mint] ?? 0n) + BigInt(al.amount);
    checkAsset(al.mint, at);
  }

  function checkAsset(mint: string, at: Issue["target"]) {
    if (!ctx.assets) return;
    const a = ctx.assets[mint];
    if (!a) {
      add("error", "UNKNOWN_ASSET", "This token is not supported in this environment", at);
      return;
    }
    const sup = assetSupport(a);
    for (const r of sup.reasons) add("error", "UNSUPPORTED_TOKEN", `${a.symbol}: ${r}`, at);
    for (const w of sup.warnings) add("info", "TOKEN_RISK", `${a.symbol}: ${w}`, at);
  }

  // actions
  const holdsMint = new Map<string, Set<string>>(); // allocation -> mints it can hold
  doc.allocations.forEach((a) => holdsMint.set(a.id, new Set([a.mint])));
  doc.actions.forEach((a) => {
    if (a.kind === "swap") holdsMint.get(a.allocation)?.add(a.outputMint);
  });
  for (const a of doc.actions) {
    const at = { kind: "action" as const, id: a.id };
    if (!allocById.has(a.allocation)) add("error", "MISSING_ALLOCATION", `Uses missing allocation "${a.allocation}"`, { ...at, field: "allocation" });
    if (!nodeById.has(a.guard)) add("error", "MISSING_NODE", `Uses missing condition "${a.guard}"`, { ...at, field: "guard" });
    const inMint = a.kind === "swap" ? a.inputMint : a.mint;
    checkAsset(inMint, { ...at, field: "mint" });
    if (a.kind === "swap") checkAsset(a.outputMint, { ...at, field: "outputMint" });
    if (allocById.has(a.allocation) && !holdsMint.get(a.allocation)?.has(inMint))
      add("error", "ALLOCATION_NEVER_HOLDS", "This allocation never holds the token this action spends", { ...at, field: "mint" });
    if ("feeBps" in a && (a.feeBps ?? 0) > doc.maxFeeBps) add("error", "FEE_ABOVE_MAX", `Fee ${a.feeBps} bps exceeds the strategy maximum of ${doc.maxFeeBps} bps`, { ...at, field: "feeBps" });
    if (a.deadline !== undefined) {
      if (a.deadline > doc.expiresAt) add("error", "DEADLINE_AFTER_EXPIRY", "Action deadline is after the strategy expiry", { ...at, field: "deadline" });
      if (a.deadline <= ctx.now) add("error", "DEADLINE_IN_PAST", "Action deadline is in the past", { ...at, field: "deadline" });
    }
    const dl = Math.min(a.deadline ?? doc.expiresAt, doc.expiresAt);
    if (ctx.now + (a.delaySeconds ?? 0) >= dl) add("error", "DELAY_PAST_DEADLINE", "The delay ends after the deadline, so this action can never run", { ...at, field: "delaySeconds" });
    if (a.schedule) {
      const last = ctx.now + (a.delaySeconds ?? 0) + (a.schedule.runs - 1) * a.schedule.intervalSeconds;
      if (last >= dl) add("warning", "SCHEDULE_TRUNCATED", "Not every scheduled run fits before the deadline; later runs will not happen", { ...at, field: "schedule" });
    }
    if (a.branch && !a.branch.group) add("error", "BAD_BRANCH", "Branch needs a group", at);
    if (a.kind === "swap") {
      if (a.inputMint === a.outputMint) add("error", "SAME_ASSET", "Swap input and output are the same token", { ...at, field: "outputMint" });
      const pool = ctx.pools?.[a.route.pool];
      if (ctx.pools && !pool) add("error", "UNKNOWN_ROUTE", "No supported route for this swap in this environment", { ...at, field: "route" });
      if (pool) {
        if (!pool.executable) add("error", "ROUTE_UNAVAILABLE", pool.reason ?? "This route is not executable here", { ...at, field: "route" });
        if (!pool.routeKinds.includes(a.route.kind)) add("error", "ROUTE_KIND_MISMATCH", "The route type does not match the pool", { ...at, field: "route" });
        if (!(pool.mints.includes(a.inputMint) && pool.mints.includes(a.outputMint))) add("error", "ROUTE_PAIR_MISMATCH", "This pool does not trade this pair", { ...at, field: "route" });
      }
      if (a.minOut.kind === "absolute" && BigInt(a.minOut.amount) === 0n) add("error", "NO_MIN_OUT", "Set a minimum received amount", { ...at, field: "minOut" });
      if (a.minOut.kind === "rate" && BigInt(a.minOut.outPerInE9) === 0n) add("error", "NO_MIN_OUT", "Set a limit price", { ...at, field: "minOut" });
      if (a.minOut.kind === "absolute" && a.amount.kind !== "fixed" && a.amount.kind !== "bpsOfAllocation")
        add("warning", "ABSOLUTE_MIN_VARIABLE_AMOUNT", "A fixed minimum with a variable amount may block execution; consider a limit price", { ...at, field: "minOut" });
    }
    if (a.amount.kind === "bpsOfReceived") {
      const src = actionById.get(a.amount.action);
      if (!src) add("error", "MISSING_ACTION", `Proceeds source "${a.amount.action}" does not exist`, { ...at, field: "amount" });
      else if (src.kind !== "swap") add("error", "BAD_PROCEEDS_SOURCE", "Proceeds can only come from a swap", { ...at, field: "amount" });
      else if (src.outputMint !== inMint) add("error", "BAD_PROCEEDS_SOURCE", "The proceeds source delivers a different token", { ...at, field: "amount" });
      else if (src.allocation !== a.allocation) add("error", "BAD_PROCEEDS_SOURCE", "Proceeds must come from the same allocation", { ...at, field: "amount" });
    }
  }

  // splits of the same proceeds must not exceed 100%
  const splitBps = new Map<string, number>();
  for (const a of doc.actions) if (a.amount.kind === "bpsOfReceived") splitBps.set(a.amount.action, (splitBps.get(a.amount.action) ?? 0) + a.amount.bps * (a.schedule?.runs ?? 1));
  for (const [src, bps] of splitBps) {
    if (bps > 10_000) add("error", "PROCEEDS_OVERALLOCATED", `Actions spend ${bps / 100}% of the proceeds from "${src}"`, { kind: "action", id: src });
  }

  if (issues.some((i) => i.severity === "error")) return { ok: false, issues, strategy: doc };

  let compiled: Compiled;
  try {
    compiled = compileStrategy(doc);
  } catch (e) {
    if (e instanceof CompileError) {
      for (const ci of e.issues) add("error", ci.code, ci.message, ci.target);
      return { ok: false, issues, strategy: doc };
    }
    throw e;
  }

  semanticChecks(doc, compiled, ctx, add);
  // funding is checked last: an unfunded plan still compiles so it can be reviewed
  if (ctx.availableByMint) {
    for (const [mint, need] of Object.entries(reservation)) {
      const have = ctx.availableByMint[mint] ?? 0n;
      if (need > have) {
        const a = ctx.assets?.[mint];
        const fmt = (u: bigint) => (a ? `${formatAmount(u, a.decimals, { minFraction: 0 })} ${a.symbol}` : `${u} base units`);
        add("error", "INSUFFICIENT_AVAILABLE", `Needs ${fmt(need)} but only ${fmt(have)} is available in your vault. Deposit ${fmt(need - have)} more to fund it.`, { kind: "strategy", field: "allocations" });
      }
    }
  }
  return { ok: !issues.some((i) => i.severity === "error"), issues: dedupe(issues), compiled, strategy: doc };
}

/** Same message about the same thing once: asset risk notes would otherwise repeat per allocation and step. */
function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = i.severity === "error" ? `${i.code}|${i.message}|${i.target.kind}|${i.target.id ?? ""}` : `${i.code}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function staticAmount(plan: Compiled["plan"], i: number): bigint | null {
  const a = plan.actions[i]!;
  const runs = BigInt(a.runs);
  if (a.amountKind === AmountKind.FIXED) return a.amount * runs;
  if (a.amountKind === AmountKind.BPS_OF_ALLOCATION) return ((plan.allocations[a.alloc]!.amount * BigInt(a.bps)) / 10_000n) * runs;
  return null;
}

/**
 * Enumerate every outcome combination (with veto timing variants) and check:
 *  - impossible guards (never TRUE),
 *  - overallocation (spend from an allocation's base asset exceeds it in some path),
 *  - conflicting branches (two branches of one exclusive group eligible together).
 */
function semanticChecks(doc: Strategy, compiled: Compiled, ctx: ValidationContext, add: (s: Severity, c: string, m: string, t: Issue["target"]) => void) {
  const { plan, sourceMap } = compiled;
  const domains = eventDomains(plan, { start: ctx.now });
  const total = domains.reduce((m, d) => m * d.length, 1);
  const doms = total > 20_000 ? domains.map((d) => d.filter((v) => v !== "YES_LATE" && v !== "NO_LATE")) : domains;
  const everTrue = new Array(plan.nodes.length).fill(false);
  const reportedOver = new Set<string>();
  const reportedConflict = new Set<string>();
  const n = plan.events.length;
  const idx = new Array(n).fill(0);
  const describe = (vals: ScenarioValue[]) => vals.map((v, i) => `${sourceMap.events[i]} ${v.replace("_LATE", " (late)")}`).join(", ");
  const hasReceiptGuard = plan.nodes.map((nd) => nd.op === 7);
  let iterations = 0;
  while (iterations++ < 200_000) {
    const vals = idx.map((v, i) => doms[i]![v]!) as ScenarioValue[];
    const truth = scenarioTruth(plan, vals, ctx.now);
    truth.forEach((t, i) => {
      if (t === "TRUE") everTrue[i] = true;
    });
    // overallocation per allocation (base mint only, static amounts), exclusive groups take the max branch
    plan.allocations.forEach((al, ai) => {
      let free = 0n;
      const groupMax = new Map<number, Map<number, bigint>>();
      plan.actions.forEach((a, i) => {
        if (a.alloc !== ai || a.inMint !== al.mint) return;
        if (truth[a.guard] !== "TRUE") return;
        const amt = staticAmount(plan, i);
        if (amt === null) return;
        if (a.group === 0xff) free += amt;
        else {
          const g = groupMax.get(a.group) ?? new Map<number, bigint>();
          g.set(a.branch, (g.get(a.branch) ?? 0n) + amt);
          groupMax.set(a.group, g);
        }
      });
      let need = free;
      for (const g of groupMax.values()) need += [...g.values()].reduce((m, v) => (v > m ? v : m), 0n);
      if (need > al.amount) {
        const id = sourceMap.allocations[ai]!;
        if (!reportedOver.has(id)) {
          reportedOver.add(id);
          add("error", "OVERALLOCATED", `If ${describe(vals)}, actions need ${need} base units but this allocation holds ${al.amount}`, { kind: "allocation", id });
        }
      }
    });
    // conflicting branches
    const byGroup = new Map<number, Set<number>>();
    plan.actions.forEach((a) => {
      if (a.group === 0xff || truth[a.guard] !== "TRUE") return;
      const s = byGroup.get(a.group) ?? new Set<number>();
      s.add(a.branch);
      byGroup.set(a.group, s);
    });
    for (const [g, br] of byGroup) {
      if (br.size > 1) {
        const gid = sourceMap.groups[g]!;
        if (!reportedConflict.has(gid)) {
          reportedConflict.add(gid);
          const ids = plan.actions.map((a, i) => (a.group === g ? sourceMap.actions[i] : null)).filter(Boolean);
          add("warning", "BRANCH_CONFLICT", `If ${describe(vals)}, more than one branch of "${gid}" is eligible; only the first to execute runs`, { kind: "action", id: ids[0]! });
        }
      }
    }
    let k = n - 1;
    while (k >= 0) {
      idx[k]++;
      if (idx[k] < doms[k]!.length) break;
      idx[k] = 0;
      k--;
    }
    if (k < 0 || n === 0) break;
  }
  plan.actions.forEach((a, i) => {
    if (!everTrue[a.guard] && !dependsOnReceipt(plan, a.guard, hasReceiptGuard)) {
      add("error", "IMPOSSIBLE_CONDITION", "This condition can never be true for any outcome", { kind: "node", id: sourceMap.nodes[a.guard] });
      add("error", "UNREACHABLE_ACTION", "This action can never run", { kind: "action", id: sourceMap.actions[i] });
    }
    if (a.kind === ActionKind.SWAP && actionDeadline(plan, a) <= ctx.now + a.delay) {
      add("error", "DELAY_PAST_DEADLINE", "The delay ends after the deadline", { kind: "action", id: sourceMap.actions[i] });
    }
  });
  void doc;
}

function dependsOnReceipt(plan: Compiled["plan"], node: number, isReceipt: boolean[]): boolean {
  const n = plan.nodes[node];
  if (!n) return false;
  if (isReceipt[node]) return true;
  return n.children.some((c) => dependsOnReceipt(plan, c, isReceipt));
}
