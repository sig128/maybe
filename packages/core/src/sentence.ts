import type { Action, PredicateNode, Strategy } from "./schema.ts";
import type { AssetInfo } from "./assets.ts";
import { formatAmount } from "./money.ts";
import { formatTime } from "./describe.ts";

/**
 * The sentence view: a projection of the strategy document into editable
 * tokens. Editing a token produces a document operation (ops.ts); the graph and
 * list views are projections of the same document, so all views stay in sync.
 */

export type SentenceToken =
  | { t: "kw"; text: string }
  | { t: "text"; text: string }
  | { t: "event"; nodeId: string; ref: string; title: string }
  | { t: "outcome"; nodeId: string; outcome: "YES" | "NO" }
  | { t: "amount"; allocationId: string; actionId?: string; text: string }
  | { t: "action"; actionId: string; text: string }
  | { t: "condition"; nodeId: string; text: string }
  | { t: "fallback"; actionId?: string; text: string }
  | { t: "deadline"; expiresAt: number; text: string };

export interface Clause {
  allocationId: string;
  guardId: string;
  tokens: SentenceToken[];
  actionIds: string[];
}

export interface SentenceModel {
  /** true when the strategy fits the one-line IF/THEN/OTHERWISE/BEFORE form */
  simple: boolean;
  clauses: Clause[];
  footer: SentenceToken[];
}

type AssetLookup = (mint: string) => Pick<AssetInfo, "symbol" | "decimals"> | undefined;

function amt(units: string | bigint, mint: string, asset: AssetLookup): string {
  const a = asset(mint);
  if (!a) return `${units}`;
  return `${formatAmount(BigInt(units), a.decimals, { maxFraction: Math.min(4, a.decimals), minFraction: 0 })} ${a.symbol}`;
}

export function actionVerb(a: Action, asset: AssetLookup): string {
  if (a.kind === "swap") return `buy ${asset(a.outputMint)?.symbol ?? "tokens"}`.replace(/^buy USDC$/, "sell for USDC");
  if (a.kind === "transfer") return `pay ${a.recipient.slice(0, 4)}…${a.recipient.slice(-4)}`;
  return "return it";
}

function amountText(doc: Strategy, a: Action, asset: AssetLookup): string {
  const al = doc.allocations.find((x) => x.id === a.allocation);
  const mint = a.kind === "swap" ? a.inputMint : a.mint;
  switch (a.amount.kind) {
    case "fixed":
      return amt(a.amount.amount, mint, asset);
    case "bpsOfAllocation":
      return al ? `${a.amount.bps / 100}% (${amt((BigInt(al.amount) * BigInt(a.amount.bps)) / 10_000n, al.mint, asset)})` : `${a.amount.bps / 100}%`;
    case "bpsOfReceived":
      return `${a.amount.bps / 100}% of proceeds`;
    case "allOfHolding":
      return `all ${asset(mint)?.symbol ?? "tokens"}`;
  }
}

export function conditionTokens(doc: Strategy, nodeId: string, depth = 0): SentenceToken[] {
  const n = doc.nodes.find((x) => x.id === nodeId);
  if (!n) return [{ t: "text", text: "(missing condition)" }];
  const ev = (ref: string) => doc.events.find((e) => e.ref === ref);
  const join = (ids: string[], word: string): SentenceToken[] =>
    ids.flatMap((c, i) => [...(i > 0 ? [{ t: "kw" as const, text: word }] : []), ...conditionTokens(doc, c, depth + 1)]);
  switch (n.kind) {
    case "outcome":
      return [{ t: "event", nodeId: n.id, ref: n.event, title: ev(n.event)?.title ?? n.event }, { t: "text", text: "resolves" }, { t: "outcome", nodeId: n.id, outcome: n.outcome }];
    case "and":
      return join(n.children, "and");
    case "or":
      return join(n.children, "or");
    case "atLeast":
      return [{ t: "condition", nodeId: n.id, text: `at least ${n.k} of ${n.children.length}` }, { t: "text", text: ":" }, ...join(n.children, ",")];
    case "not": {
      const c = doc.nodes.find((x) => x.id === n.child);
      if (c?.kind === "outcome") return [{ t: "event", nodeId: c.id, ref: c.event, title: ev(c.event)?.title ?? c.event }, { t: "text", text: "doesn't resolve" }, { t: "outcome", nodeId: c.id, outcome: c.outcome }];
      return [{ t: "kw", text: "not" }, { t: "text", text: "(" }, ...conditionTokens(doc, n.child, depth + 1), { t: "text", text: ")" }];
    }
    case "veto":
      return [
        { t: "text", text: "no veto by" },
        { t: "event", nodeId: n.id, ref: n.event, title: ev(n.event)?.title ?? n.event },
        { t: "condition", nodeId: n.id, text: `within ${Math.round(n.windowSeconds / 3600)}h` },
      ];
    case "receipt":
      return [{ t: "condition", nodeId: n.id, text: n.strategy === "self" ? `“${doc.actions.find((a) => a.id === n.action)?.label ?? n.action}” has executed` : "the predecessor future has executed" }];
    case "after":
      return [{ t: "condition", nodeId: n.id, text: `after ${formatTime(n.at)}` }];
    case "always":
      return [{ t: "condition", nodeId: n.id, text: "right away" }];
  }
}

function isComplementOf(doc: Strategy, a: PredicateNode | undefined, b: PredicateNode | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind === "outcome" && b.kind === "outcome") return a.event === b.event && a.outcome !== b.outcome;
  if (b.kind === "not") return b.child === a.id;
  if (a.kind === "not") return a.child === b.id;
  return false;
}

export function toSentence(doc: Strategy, asset: AssetLookup): SentenceModel {
  const clauses: Clause[] = [];
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const al of doc.allocations) {
    const acts = doc.actions.filter((a) => a.allocation === al.id);
    const byGuard = new Map<string, Action[]>();
    acts.forEach((a) => byGuard.set(a.guard, [...(byGuard.get(a.guard) ?? []), a]));
    for (const [guardId, list] of byGuard) {
      const tokens: SentenceToken[] = [{ t: "kw", text: "IF" }, ...conditionTokens(doc, guardId), { t: "kw", text: "THEN" }];
      list.forEach((a, i) => {
        if (i > 0) tokens.push({ t: "kw", text: "and" });
        if (a.kind === "release") tokens.push({ t: "fallback", actionId: a.id, text: `return ${amountText(doc, a, asset)}` });
        else {
          tokens.push({ t: "text", text: "use" }, { t: "amount", allocationId: al.id, actionId: a.id, text: amountText(doc, a, asset) }, { t: "text", text: "to" }, { t: "action", actionId: a.id, text: actionVerb(a, asset) });
          if (a.schedule) tokens.push({ t: "text", text: `${a.schedule.runs}× every ${Math.round(a.schedule.intervalSeconds / 86_400)}d` });
          if (a.delaySeconds) tokens.push({ t: "text", text: `after ${Math.round(a.delaySeconds / 3600)}h` });
        }
      });
      clauses.push({ allocationId: al.id, guardId, tokens, actionIds: list.map((a) => a.id) });
    }
  }
  // Simple form: one allocation, one spending clause (+ optional complementary release)
  let simple = false;
  if (doc.allocations.length === 1 && clauses.length <= 2) {
    const spend = clauses.filter((c) => c.actionIds.some((id) => doc.actions.find((a) => a.id === id)?.kind !== "release"));
    const rel = clauses.filter((c) => c.actionIds.every((id) => doc.actions.find((a) => a.id === id)?.kind === "release"));
    if (spend.length === 1 && (rel.length === 0 || (rel.length === 1 && isComplementOf(doc, nodeById.get(spend[0]!.guardId), nodeById.get(rel[0]!.guardId))))) {
      simple = true;
      const main = spend[0]!;
      const relAction = rel[0] ? doc.actions.find((a) => a.id === rel[0]!.actionIds[0]) : undefined;
      main.tokens.push(
        { t: "kw", text: "OTHERWISE" },
        { t: "fallback", ...(relAction ? { actionId: relAction.id } : {}), text: relAction ? "return unspent funds" : "return unspent funds at expiry" },
        { t: "kw", text: "BEFORE" },
        { t: "deadline", expiresAt: doc.expiresAt, text: formatTime(doc.expiresAt).replace(/, \d\d:\d\d UTC$/, "") },
      );
      clauses.splice(0, clauses.length, main);
    }
  }
  const footer: SentenceToken[] = simple
    ? []
    : [{ t: "text", text: "Anything unspent returns to your available balance" }, { t: "kw", text: "BEFORE" }, { t: "deadline", expiresAt: doc.expiresAt, text: formatTime(doc.expiresAt) }];
  return { simple, clauses, footer };
}
