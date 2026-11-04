import { NONE } from "./limits.ts";
import { formatAmount } from "./money.ts";
import type { AssetInfo } from "./assets.ts";
import {
  ACTION_FLAG_MIN_OUT_IS_RATE,
  ACTION_FLAG_MISSED_CATCH_UP,
  ActionKind,
  AmountKind,
  NodeOp,
  RouteKind,
  actionDeadline,
  type Plan,
} from "./plan.ts";

/**
 * Plain-language rendering of a compiled plan. The review screen renders the
 * DECODED bytes that will be signed through these functions — never the draft —
 * so what a person reads is what the program enforces.
 */

export interface DescribeLookup {
  event(key: string): { title: string; venue: string; trust: string; ruleHash?: string } | undefined;
  asset(mint: string): Pick<AssetInfo, "symbol" | "decimals" | "name"> | undefined;
  ref(address: string): { label: string; kind: "pool" | "recipient" | "strategy" | "market" | "unknown" } | undefined;
}

export interface Labels {
  events: string[];
  actions?: Array<string | undefined>;
  allocations?: Array<string | undefined>;
}

const fmtDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTime(unix: number): string {
  return `${fmtDate.format(new Date(unix * 1000))} UTC`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "no delay";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m && !d) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ") || `${seconds} seconds`;
}

export function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export function fmtUnits(units: bigint, asset: Pick<AssetInfo, "symbol" | "decimals"> | undefined): string {
  if (!asset) return `${units} base units`;
  return `${formatAmount(units, asset.decimals, { maxFraction: Math.min(asset.decimals, 6), minFraction: 0 })} ${asset.symbol}`;
}

function eventLabel(plan: Plan, i: number, labels: Labels): string {
  return labels.events[i] ?? `E${i + 1}`;
}

export function describeNode(plan: Plan, idx: number, labels: Labels, lookup?: DescribeLookup, depth = 0): string {
  const n = plan.nodes[idx];
  if (!n) return "(missing condition)";
  const sub = (c: number) => describeNode(plan, c, labels, lookup, depth + 1);
  const wrap = (s: string) => (depth > 0 ? `(${s})` : s);
  switch (n.op) {
    case NodeOp.ALWAYS:
      return "as soon as the future is active";
    case NodeOp.OUTCOME:
      return `${eventLabel(plan, n.a, labels)} resolves ${n.b === 1 ? "YES" : "NO"}`;
    case NodeOp.NOT: {
      const c = plan.nodes[n.children[0]!];
      if (c?.op === NodeOp.OUTCOME) return `${eventLabel(plan, c.a, labels)} resolves anything other than ${c.b === 1 ? "YES" : "NO"} (including voided)`;
      if (c?.op === NodeOp.ATLEAST) return wrap(`it is settled that fewer than ${c.k} of ${c.children.map(sub).join(", ")} will happen`);
      return wrap(`it is settled that this will not happen: ${sub(n.children[0]!)}`);
    }
    case NodeOp.AND:
      return wrap(n.children.length === 2 ? `${sub(n.children[0]!)} and ${sub(n.children[1]!)}` : `all of: ${n.children.map(sub).join(", ")}`);
    case NodeOp.OR:
      return wrap(n.children.map(sub).join(" or "));
    case NodeOp.ATLEAST:
      return wrap(`at least ${n.k} of: ${n.children.map(sub).join(", ")}`);
    case NodeOp.VETO:
      return `${eventLabel(plan, n.a, labels)} has not become final ${n.b === 1 ? "YES" : "NO"} within ${formatDuration(n.param)} after ${sub(n.children[0]!)}`;
    case NodeOp.RECEIPT: {
      if (n.a === NONE) {
        const name = labels.actions?.[n.b];
        return `step ${n.b + 1}${name ? ` (“${name}”)` : ""} has executed`;
      }
      const ref = plan.refs[n.a]!;
      const info = lookup?.ref(ref);
      return `step ${n.b + 1} of ${info?.label ?? `future ${short(ref)}`} has executed`;
    }
    case NodeOp.AFTER:
      return `after ${formatTime(n.param)}`;
    default:
      return "(unknown condition)";
  }
}

export interface ActionDescription {
  title: string;
  amount: string;
  limits: string[];
}

function routeName(kind: RouteKind): string {
  switch (kind) {
    case RouteKind.CP_SWAP:
      return "swap pool";
    case RouteKind.OUTCOME_BUY:
      return "outcome market (buy)";
    case RouteKind.OUTCOME_REDEEM:
      return "outcome market (redeem)";
    default:
      return "route";
  }
}

export function describeAmount(plan: Plan, i: number, lookup: DescribeLookup, labels: Labels): string {
  const a = plan.actions[i]!;
  const inAsset = lookup.asset(plan.mints[a.inMint]!);
  const runs = a.runs > 1 ? " per run" : "";
  switch (a.amountKind) {
    case AmountKind.FIXED:
      return `${fmtUnits(a.amount, inAsset)}${runs}`;
    case AmountKind.BPS_OF_ALLOCATION: {
      const al = plan.allocations[a.alloc]!;
      const v = (al.amount * BigInt(a.bps)) / 10_000n;
      return `${a.bps / 100}% of the allocation (${fmtUnits(v, lookup.asset(plan.mints[al.mint]!))})${runs}`;
    }
    case AmountKind.BPS_OF_RECEIVED: {
      const src = labels.actions?.[a.amountRef];
      const cap = a.amount > 0n ? `, at most ${fmtUnits(a.amount, inAsset)}` : "";
      return `${a.bps / 100}% of what step ${a.amountRef + 1}${src ? ` (“${src}”)` : ""} actually received${cap}`;
    }
    case AmountKind.ALL_OF_HOLDING: {
      const cap = a.amount > 0n ? `, at most ${fmtUnits(a.amount, inAsset)}` : "";
      return `all ${inAsset?.symbol ?? "tokens"} this allocation holds at that time${cap}`;
    }
  }
}

export function describeAction(plan: Plan, i: number, lookup: DescribeLookup, labels: Labels): ActionDescription {
  const a = plan.actions[i]!;
  const inAsset = lookup.asset(plan.mints[a.inMint]!);
  const amount = describeAmount(plan, i, lookup, labels);
  const limits: string[] = [];
  let title: string;
  if (a.kind === ActionKind.SWAP) {
    const outAsset = lookup.asset(plan.mints[a.outMint]!);
    const pool = lookup.ref(plan.refs[a.ref]!);
    title = `Swap ${amount} for ${outAsset?.symbol ?? "tokens"}`;
    if ((a.flags & ACTION_FLAG_MIN_OUT_IS_RATE) !== 0 && inAsset && outAsset) {
      // rate: out base units per in base unit x1e9 -> whole-token price
      const perWhole = (a.minOut * 10n ** BigInt(inAsset.decimals)) / 1_000_000_000n;
      limits.push(`Limit price: 1 ${inAsset.symbol} must buy at least ${fmtUnits(perWhole, outAsset)}`);
    } else {
      limits.push(`Minimum received: ${fmtUnits(a.minOut, outAsset)}${a.runs > 1 ? " per run" : ""}`);
    }
    limits.push(`Only via ${pool?.label ?? short(plan.refs[a.ref]!)} (${routeName(a.routeKind)})`);
  } else if (a.kind === ActionKind.TRANSFER) {
    const r = plan.refs[a.ref]!;
    const info = lookup.ref(r);
    title = `Send ${amount} to ${info?.label ?? short(r)}`;
    limits.push(`Recipient fixed: ${r}`);
  } else {
    title = `Return ${amount} to your available balance`;
  }
  if (a.feeBps > 0) limits.push(`MAYBE fee up to ${(a.feeBps / 100).toFixed(2)}%, charged only on the amount actually executed`);
  if (a.delay > 0) limits.push(`Waits ${formatDuration(a.delay)} after the condition becomes final`);
  if (a.runs > 1) {
    const catchUp = (a.flags & ACTION_FLAG_MISSED_CATCH_UP) !== 0;
    limits.push(`${a.runs} runs, every ${formatDuration(a.interval)}; ${catchUp ? "late runs may still execute, one at a time" : "a run not executed before the next is due is skipped"}`);
  }
  if (a.deadline !== 0) limits.push(`Must execute before ${formatTime(actionDeadline(plan, a))}, otherwise it expires unfilled`);
  if (a.group !== NONE) limits.push("Mutually exclusive: once one branch of this group executes, the others never can");
  return { title, amount, limits };
}
