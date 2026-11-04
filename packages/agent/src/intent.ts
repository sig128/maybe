/**
 * Deterministic intent parser for the local assistant. It understands a small,
 * explicit grammar and reports anything it does not understand as an open
 * question instead of guessing — natural-language ambiguity never silently
 * becomes a funded strategy.
 */

export type Cond =
  | { op: "leaf"; ref: string; outcome: "YES" | "NO" }
  | { op: "and" | "or"; items: Cond[] }
  | { op: "atLeast"; k: number; items: Cond[] }
  | { op: "not"; item: Cond };

export interface Clause {
  amount: number;
  asset: string;
  cond: Cond;
  /** inline action, e.g. "use 300 to buy MAYBE if…" */
  buy?: string;
}

export interface Intent {
  reserve?: { amount: number; asset: string };
  clauses: Clause[];
  expiryDays?: number;
  releaseOnFail: boolean;
  confirmFirst: boolean;
  unparsed: string[];
}

const NUM = String.raw`\$?(\d[\d,]*(?:\.\d+)?)`;
const ASSET = String.raw`(usdc|usd|maybe|lumen|fern|kite|moss)?`;

function num(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function parseSubject(s: string): { items: string[]; joiner: "and" | "or" | null; k?: number } {
  const text = s.trim().replace(/^(?:if|when)\s+/i, "");
  const atLeast = /^at least\s+(\d+)\s+(?:of|out of)\s+(.+)$/i.exec(text);
  if (atLeast) return { items: splitList(atLeast[2]!), joiner: null, k: Number(atLeast[1]) };
  const both = /^(?:both\s+)?(.+?)\s+and\s+(.+)$/i.exec(text);
  if (both && !/\bor\b/i.test(text)) return { items: splitList(text.replace(/^both\s+/i, "")), joiner: "and" };
  if (/\bor\b/i.test(text)) return { items: text.split(/\s*,\s*|\s+or\s+/i).map((x) => x.trim()).filter(Boolean), joiner: "or" };
  return { items: [text], joiner: null };
}

function splitList(s: string): string[] {
  return s
    .split(/\s*,\s*|\s+and\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseCondition(raw: string): Cond | null {
  const m = /^(.+?)\s+(?:resolves?|resolve|settles?|ends?|is|are)\s+(yes|no)\b/i.exec(raw.trim());
  if (!m) return null;
  const outcome = m[2]!.toUpperCase() as "YES" | "NO";
  const subj = parseSubject(m[1]!);
  const leaves: Cond[] = subj.items.map((ref) => ({ op: "leaf", ref: normalizeRef(ref), outcome }));
  if (subj.k !== undefined) return { op: "atLeast", k: subj.k, items: leaves };
  if (leaves.length === 1) return leaves[0]!;
  return { op: subj.joiner ?? "and", items: leaves };
}

function normalizeRef(s: string): string {
  const t = s.trim().replace(/^(?:event|market)\s+/i, "").replace(/^the\s+/i, "");
  if (/^[A-Z][0-9]?$/.test(t)) return t;
  if (/^[a-z]$/.test(t)) return t.toUpperCase();
  return t.toLowerCase();
}

export function parseIntent(text: string): Intent {
  const intent: Intent = { clauses: [], releaseOnFail: false, confirmFirst: true, unparsed: [] };
  const sentences = text
    .replace(/\n+/g, ". ")
    .split(/(?<=[.;!?])\s+|(?<=[.;!?])$/)
    .map((s) => s.trim().replace(/[.;!?]+$/, ""))
    .filter(Boolean);
  for (const sentence of sentences) {
    let handled = false;
    const reserve = new RegExp(String.raw`\b(?:reserve|set aside|allocate|deposit)\s+${NUM}\s*${ASSET}`, "i").exec(sentence);
    if (reserve) {
      intent.reserve = { amount: num(reserve[1]!), asset: (reserve[2] ?? "usdc").toUpperCase().replace("USD", "USDC").replace("USDCC", "USDC") };
      handled = true;
    }
    const exp = /\bexpir(?:e|es|y)\s+(?:after|in)\s+(\d+)\s*(day|days|week|weeks|month|months)\b/i.exec(sentence) ?? /\bfor\s+(\d+)\s*(day|days|week|weeks)\b/i.exec(sentence);
    if (exp) {
      const n = Number(exp[1]);
      intent.expiryDays = /week/i.test(exp[2]!) ? n * 7 : /month/i.test(exp[2]!) ? n * 30 : n;
      handled = true;
    }
    if (/\b(show|preview)\b.*\b(plan|before)\b/i.test(sentence) || /\bbefore funding\b/i.test(sentence)) {
      intent.confirmFirst = true;
      handled = true;
    }
    if (/\b(otherwise|if not|else)\b.*\b(return|release|refund)\b/i.test(sentence) || /\brelease (it|them|the rest) (if|when)\b/i.test(sentence)) {
      intent.releaseOnFail = true;
      handled = true;
    }
    // clauses: "Use 300 if A resolves YES, and 200 if B and C resolve YES"
    const parts = sentence.split(/,?\s+and\s+(?=(?:use\s+)?\$?\d)/i);
    for (const part of parts) {
      const m = new RegExp(String.raw`^(?:.*?\b)?(?:use|spend|put|buy with)?\s*${NUM}\s*${ASSET}(?:\s+to\s+buy\s+([a-z]+))?\s+(?:if|when|once)\s+(.+)$`, "i").exec(part.trim());
      if (!m) continue;
      if (/\breserve\b/i.test(part) && !/\b(if|when)\b/i.test(part)) continue;
      const cond = parseCondition(m[4]!);
      if (!cond) {
        intent.unparsed.push(part.trim());
        handled = true;
        continue;
      }
      intent.clauses.push({ amount: num(m[1]!), asset: (m[2] ?? intent.reserve?.asset ?? "USDC").toUpperCase().replace(/^USD$/, "USDC"), cond, ...(m[3] ? { buy: m[3].toUpperCase() } : {}) });
      handled = true;
    }
    if (!handled) intent.unparsed.push(sentence);
  }
  return intent;
}

export function condRefs(c: Cond): string[] {
  switch (c.op) {
    case "leaf":
      return [c.ref];
    case "not":
      return condRefs(c.item);
    default:
      return [...new Set(c.items.flatMap(condRefs))];
  }
}

export function describeCond(c: Cond, title: (ref: string) => string = (r) => r): string {
  switch (c.op) {
    case "leaf":
      return `${title(c.ref)} resolves ${c.outcome}`;
    case "not":
      return `not (${describeCond(c.item, title)})`;
    case "and":
      return c.items.map((i) => describeCond(i, title)).join(" and ");
    case "or":
      return c.items.map((i) => describeCond(i, title)).join(" or ");
    case "atLeast":
      return `at least ${c.k} of: ${c.items.map((i) => describeCond(i, title)).join(", ")}`;
  }
}
