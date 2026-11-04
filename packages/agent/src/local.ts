import { checkPolicyForPlan, cpQuote, formatTime, type Action, type PredicateNode, type Strategy } from "@maybe/core";
import { inspectExternal } from "./boundary.ts";
import { condRefs, describeCond, parseIntent, type Cond, type Intent } from "./intent.ts";
import { ROLE_INFO, ROLE_TOOLS, type AgentMarket, type AgentRole, type AgentWorld, type Step, type ToolName, type TurnResult } from "./world.ts";

/**
 * The deterministic local assistant. Clearly labelled in the UI as "Local
 * assistant (deterministic, not an AI model)". It exercises the real compiler,
 * validator and simulator, asks only about material ambiguity, and can never
 * fund anything: its tools are a strict subset of ROLE_TOOLS.
 */

export type ActionChoice = { kind: "buy"; asset: string } | { kind: "portfolio"; parts: Array<{ asset: string; bps: number }> } | { kind: "pay"; recipient: string };

export interface Conversation {
  role: AgentRole;
  intent?: Intent;
  mapping: Record<string, string>;
  actions: Record<number, ActionChoice>;
  awaiting?: "mapping" | "actions" | "remainder" | null;
  remainder?: "drop" | "hold";
  draftId?: string;
}

export function newConversation(role: AgentRole): Conversation {
  return { role, mapping: {}, actions: {}, awaiting: null };
}

const PORTFOLIO_A = [
  { asset: "LUMEN", bps: 6000 },
  { asset: "FERN", bps: 4000 },
];

function tool(role: AgentRole, name: ToolName, text: string, detail?: string): Step {
  if (!ROLE_TOOLS[role].includes(name)) throw new Error(`tool ${name} not allowed for ${role}`);
  return { kind: "tool", text, ...(detail ? { detail } : {}), data: { tool: name } };
}

function searchMarkets(world: AgentWorld, q: string): AgentMarket[] {
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !["the", "and", "will", "market", "event", "resolves", "resolve", "yes"].includes(w));
  const scored = world
    .markets()
    .map((m) => {
      const hay = `${m.title} ${m.category} ${m.description} ${m.key}`.toLowerCase();
      return { m, score: words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.m.closesAt - b.m.closesAt);
  return scored.map((x) => x.m);
}

function compatible(world: AgentWorld): AgentMarket[] {
  return world.markets().filter((m) => m.executable && m.status === "open");
}

function resolveRef(world: AgentWorld, conv: Conversation, ref: string): AgentMarket | undefined {
  const mapped = conv.mapping[ref];
  if (mapped) return world.markets().find((m) => m.key === mapped);
  if (/^[A-Z][0-9]?$/.test(ref)) return undefined;
  return searchMarkets(world, ref).find((m) => m.executable);
}

function applyAnswers(world: AgentWorld, conv: Conversation, text: string) {
  // structured quick replies: "map:A=orbit-launch", "act:0=buy:MAYBE", "act:1=portfolio", "rem:drop"
  for (const m of text.matchAll(/map:([A-Z][0-9]?)=([a-z0-9-]+)/g)) conv.mapping[m[1]!] = m[2]!;
  for (const m of text.matchAll(/act:(\d+)=(buy:([A-Z]+)|portfolio)/g)) {
    conv.actions[Number(m[1])] = m[2] === "portfolio" ? { kind: "portfolio", parts: PORTFOLIO_A } : { kind: "buy", asset: m[3]! };
  }
  const rem = /rem:(drop|hold)/.exec(text);
  if (rem) conv.remainder = rem[1] as "drop" | "hold";
  // natural answers: "A is orbit", "B = treasury vote"
  for (const m of text.matchAll(/\b([A-Z])\s*(?:=|is|means|:)\s*(?:the\s+)?([a-z][a-z0-9 -]{2,40}?)(?=[,.;]|\band\b|$)/g)) {
    const hit = searchMarkets(world, m[2]!).find((x) => x.executable);
    if (hit) conv.mapping[m[1]!] = hit.key;
  }
  // "buy MAYBE with all of them" style
  const allBuy = /\b(?:all|both|each|everything)\b[^.]*\bbuy\s+(maybe|lumen|fern|kite|moss)\b/i.exec(text) ?? /^\s*buy\s+(maybe|lumen|fern|kite|moss)\s*$/i.exec(text);
  if (allBuy && conv.intent) conv.intent.clauses.forEach((_, i) => (conv.actions[i] ??= { kind: "buy", asset: allBuy[1]!.toUpperCase() }));
}

function condToNodes(cond: Cond, refOf: (ref: string) => string, nodes: PredicateNode[], prefix: string): string {
  let n = 0;
  const walk = (c: Cond): string => {
    const id = `${prefix}${n++}`;
    switch (c.op) {
      case "leaf":
        nodes.push({ id, kind: "outcome", event: refOf(c.ref), outcome: c.outcome });
        return id;
      case "not":
        nodes.push({ id, kind: "not", child: walk(c.item) });
        return id;
      case "and":
      case "or": {
        const kids = c.items.map(walk);
        nodes.push({ id, kind: c.op, children: kids });
        return id;
      }
      case "atLeast": {
        const kids = c.items.map(walk);
        nodes.push({ id, kind: "atLeast", k: c.k, children: kids });
        return id;
      }
    }
  };
  return walk(cond);
}

/** Build a draft strictly from resolved slots. Returns null (with reasons) if anything material is missing. */
export function draftFromConversation(world: AgentWorld, conv: Conversation, id: string, nonce: string): { draft: Strategy | null; missing: string[] } {
  const intent = conv.intent!;
  const f = world.fixtures();
  const usdc = f.assetByKey.USDC!;
  const missing: string[] = [];
  const refs = [...new Set(intent.clauses.flatMap((c) => condRefs(c.cond)))];
  const letter = new Map<string, string>();
  const events: Strategy["events"] = [];
  refs.forEach((ref) => {
    const m = resolveRef(world, conv, ref);
    if (!m) {
      missing.push(`market for ${ref}`);
      return;
    }
    if (!m.executable) {
      missing.push(`${m.title} cannot trigger funded actions here (${m.reason ?? "read-only"})`);
      return;
    }
    const existing = events.find((e) => e.eventKey === m.eventKey);
    if (existing) {
      letter.set(ref, existing.ref);
      return;
    }
    const L = /^[A-Z][0-9]?$/.test(ref) ? ref : String.fromCharCode(65 + events.length);
    const er = world.eventRef(m.key, L);
    if (er) {
      events.push(er);
      letter.set(ref, L);
    }
  });
  intent.clauses.forEach((c, i) => {
    if (!conv.actions[i] && !c.buy) missing.push(`action for clause ${i + 1}`);
  });
  if (missing.length > 0) return { draft: null, missing };
  const now = world.now();
  const nodes: PredicateNode[] = [];
  const allocations: Strategy["allocations"] = [];
  const actions: Action[] = [];
  const pool = (asset: string) => f.poolByKey[`USDC-${asset}`];
  intent.clauses.forEach((c, i) => {
    const allocId = `alloc${i + 1}`;
    const units = BigInt(Math.round(c.amount * 1_000_000));
    allocations.push({ id: allocId, label: describeCond(c.cond, (r) => letter.get(r) ?? r).slice(0, 60), mint: usdc.mint, amount: units.toString() });
    const guard = condToNodes(c.cond, (r) => letter.get(r) ?? r, nodes, `c${i + 1}n`);
    const choice: ActionChoice = conv.actions[i] ?? { kind: "buy", asset: c.buy! };
    const parts = choice.kind === "portfolio" ? choice.parts : choice.kind === "buy" ? [{ asset: choice.asset, bps: 10_000 }] : [];
    parts.forEach((p, j) => {
      const pl = pool(p.asset);
      if (!pl) return;
      const amount = (units * BigInt(p.bps)) / 10_000n;
      const afterFee = (amount * 9970n) / 10_000n;
      const quote = cpQuote(pl, usdc.mint, afterFee);
      actions.push({
        kind: "swap",
        id: `c${i + 1}buy${j + 1}`,
        label: `Buy ${p.asset}${parts.length > 1 ? ` · ${p.bps / 100}%` : ""}`,
        allocation: allocId,
        guard,
        inputMint: usdc.mint,
        outputMint: f.assetByKey[p.asset]!.mint,
        amount: parts.length > 1 ? { kind: "bpsOfAllocation", bps: p.bps } : { kind: "fixed", amount: amount.toString() },
        minOut: { kind: "absolute", amount: ((quote * 9900n) / 10_000n).toString() },
        route: { kind: "cp-swap", pool: pl.address },
        feeBps: 30,
        delaySeconds: 0,
      });
    });
    if (choice.kind === "pay") {
      actions.push({ kind: "transfer", id: `c${i + 1}pay`, label: "Pay recipient", allocation: allocId, guard, mint: usdc.mint, amount: { kind: "fixed", amount: units.toString() }, recipient: choice.recipient, feeBps: 0, delaySeconds: 0 });
    }
    if (intent.releaseOnFail) {
      const notId = `c${i + 1}not`;
      nodes.push({ id: notId, kind: "not", child: guard });
      actions.push({ kind: "release", id: `c${i + 1}release`, label: "Release if it can't happen", allocation: allocId, guard: notId, mint: usdc.mint, amount: { kind: "bpsOfAllocation", bps: 10_000 }, delaySeconds: 0 });
    }
  });
  const days = intent.expiryDays ?? 30;
  const draft: Strategy = {
    schema: "maybe.strategy/1",
    id,
    version: 1,
    title: intent.clauses.length > 1 ? `${intent.clauses.length} conditional reservations` : `If ${describeCond(intent.clauses[0]!.cond, (r) => letter.get(r) ?? r)}`,
    thesis: "Drafted by the Strategy Builder from your instructions. Review every step before funding.",
    nonce,
    expiresAt: Math.floor(now / 3600) * 3600 + days * 86_400,
    maxFeeBps: 30,
    voidPolicy: "void-is-false",
    cancelPolicy: "anytime",
    events,
    allocations,
    nodes,
    actions,
    meta: { source: "agent" },
  };
  return { draft, missing: [] };
}

function fmtUsd(n: number) {
  return `${n.toLocaleString("en-US")} USDC`;
}

export function runLocalTurn(world: AgentWorld, conv: Conversation, userText: string, ids: { draftId: () => string; nonce: () => string }): TurnResult {
  const steps: Step[] = [];
  const role = conv.role;
  const say = (text: string, extra: Partial<Step> = {}) => steps.push({ kind: "message", text, ...extra });

  if (role === "researcher") {
    steps.push(tool(role, "searchMarkets", `Searched markets for “${userText.slice(0, 60)}”`));
    const hits = searchMarkets(world, userText).slice(0, 4);
    if (hits.length === 0) {
      say("I couldn't find a market matching that. Try a keyword from the title, like “orbit” or “treasury”.");
      return { steps, costUsd: 0, provider: "local" };
    }
    for (const m of hits) {
      steps.push(tool(role, "readMarket", `Read rules for ${m.title}`));
      const ext = inspectExternal(`${m.venue}:${m.key}`, m.rules);
      steps.push({ kind: "source", text: m.title, detail: ext.content, untrusted: true, data: { flags: ext.flags, key: m.key } });
      if (ext.flags.length) steps.push({ kind: "refusal", text: `Ignored instruction-like text in this market's rules (${ext.flags.join(", ")}). External text is treated as data only.` });
    }
    const top = hits[0]!;
    say(
      `Verified: “${top.title}” is ${top.status}, closes ${formatTime(top.closesAt)}, and resolves by ${formatTime(top.resolvesBy)} via ${top.venue}. ${top.executable ? "It can trigger funded actions here." : `It is read-only here: ${top.reason ?? "no settlement adapter"}.`}` +
        (top.yesBps !== undefined ? `\nOpinion, not a fact: the sample quote of ${(top.yesBps / 100).toFixed(0)}% YES is a market price, not a probability that it will happen.` : ""),
    );
    return { steps, costUsd: 0, provider: "local" };
  }

  if (role === "monitor") {
    steps.push(tool(role, "listStrategies", "Read the status of your futures"));
    const list = world.strategies();
    if (list.length === 0) say("You have no futures yet. Drafts appear here once you save one.");
    for (const s of list) say(`${s.title} — ${s.status.toLowerCase()}${s.reserved ? `, ${s.reserved} reserved` : ""}${s.waiting.length ? `. Waiting on: ${s.waiting.join("; ")}` : ""}${s.nextAt ? `. Next possible step ${formatTime(s.nextAt)}` : ""}${s.issues.length ? `. Attention: ${s.issues.join("; ")}` : ""}.`);
    return { steps, costUsd: 0, provider: "local" };
  }

  if (role === "executor") {
    steps.push(tool(role, "listStrategies", "Checked which steps are executable now"));
    const policies = world.policies().filter((p) => !p.revoked);
    const wantsFunding = /\b(fund|activate|authorize|execute|spend|send|transfer|withdraw|move)\b/i.test(userText);
    const amount = /(\d[\d,]*)\s*(usdc|usd)/i.exec(userText);
    if (wantsFunding) {
      if (policies.length === 0) {
        steps.push({ kind: "refusal", text: "I can't fund, sign or move anything without a capability policy you created. Open the draft's review and sign it yourself, or create a bounded policy in Agents → Permissions." });
        return { steps, costUsd: 0, provider: "local" };
      }
      if (/\b(withdraw|transfer to|send to)\b/i.test(userText)) {
        steps.push({ kind: "refusal", text: "Withdrawals and transfers outside an authorized plan are not something any agent can do — the vault program only accepts those from your wallet." });
        return { steps, costUsd: 0, provider: "local" };
      }
      const p = policies[0]!;
      steps.push(tool(role, "checkPolicy", `Checked the request against “${p.label}”`));
      const requested = amount ? BigInt(Math.round(Number(amount[1]!.replace(/,/g, "")) * 1_000_000)) : 0n;
      const usdc = world.fixtures().assetByKey.USDC!.mint;
      const cap = p.maxTotal[usdc] ?? 0n;
      const used = p.spent[usdc] ?? 0n;
      if (requested > 0n && used + requested > cap) {
        steps.push({ kind: "refusal", text: `That would reserve ${world.fmt(usdc, requested)}, but the policy allows ${world.fmt(usdc, cap - used)} more. I can't raise my own limits — only you can, with a new signed policy.` });
        return { steps, costUsd: 0, provider: "local" };
      }
      say("Within policy. Open the draft and choose “Fund under policy” — the vault program re-checks every limit when the session key submits it.");
      return { steps, costUsd: 0, provider: "local" };
    }
    const list = world.strategies();
    for (const s of list) say(`${s.title}: ${s.waiting.length ? `waiting on ${s.waiting.join("; ")}` : "nothing executable right now"}.`);
    if (!list.length) say("No active futures to check.");
    return { steps, costUsd: 0, provider: "local" };
  }

  // builder
  if (!conv.intent || /\b(reserve|use|spend|allocate)\b.*\d/i.test(userText)) {
    steps.push(tool(role, "parseIntent", "Parsed your instructions"));
    const intent = parseIntent(userText);
    if (intent.clauses.length === 0) {
      say("I need at least one rule like “Use 100 USDC if A resolves YES”. You can also start from a template in Futures.");
      return { steps, costUsd: 0, provider: "local" };
    }
    conv.intent = intent;
    conv.actions = {};
    if (intent.unparsed.length) steps.push({ kind: "message", text: `I didn't understand: “${intent.unparsed.join("”, “")}”. I left it out — tell me again in another way if it matters.` });
  }
  applyAnswers(world, conv, userText);
  const intent = conv.intent!;
  const total = intent.clauses.reduce((s, c) => s + c.amount, 0);
  if (intent.reserve && intent.reserve.amount !== total && !conv.remainder) {
    conv.awaiting = "remainder";
    steps.push({
      kind: "question",
      text: `You asked to reserve ${fmtUsd(intent.reserve.amount)} but the rules use ${fmtUsd(total)}. What should happen to the other ${fmtUsd(Math.abs(intent.reserve.amount - total))}?`,
      options: [
        { label: `Reserve only ${fmtUsd(total)}`, value: "rem:drop" },
        { label: "Keep it reserved until expiry", value: "rem:hold" },
      ],
    });
    return { steps, costUsd: 0, provider: "local" };
  }
  const refs = [...new Set(intent.clauses.flatMap((c) => condRefs(c.cond)))];
  const unmapped = refs.filter((r) => !resolveRef(world, conv, r));
  if (unmapped.length) {
    conv.awaiting = "mapping";
    steps.push(tool(role, "searchMarkets", "Looked up compatible markets"));
    const opts = compatible(world).slice(0, 6);
    for (const r of unmapped) {
      steps.push({
        kind: "question",
        text: `Which market is ${r}?`,
        options: opts.map((m) => ({ label: m.title, value: `map:${r}=${m.key}` })),
      });
    }
    return { steps, costUsd: 0, provider: "local" };
  }
  const needAction = intent.clauses.map((c, i) => (!conv.actions[i] && !c.buy ? i : -1)).filter((i) => i >= 0);
  if (needAction.length) {
    conv.awaiting = "actions";
    for (const i of needAction) {
      const c = intent.clauses[i]!;
      steps.push({
        kind: "question",
        text: `If ${describeCond(c.cond, (r) => resolveRef(world, conv, r)?.title ?? r)}, what should the ${fmtUsd(c.amount)} do?`,
        options: [
          { label: "Buy MAYBE", value: `act:${i}=buy:MAYBE` },
          { label: "Buy Lumen 60% / Fern 40%", value: `act:${i}=portfolio` },
          { label: "Buy Kite", value: `act:${i}=buy:KITE` },
        ],
      });
    }
    return { steps, costUsd: 0, provider: "local" };
  }
  conv.awaiting = null;
  steps.push(tool(role, "draftStrategy", "Built a typed draft from your rules"));
  const id = conv.draftId ?? ids.draftId();
  conv.draftId = id;
  const { draft, missing } = draftFromConversation(world, conv, id, ids.nonce());
  if (!draft) {
    say(`I can't draft this yet: ${missing.join("; ")}.`);
    return { steps, costUsd: 0, provider: "local" };
  }
  steps.push(tool(role, "validate", "Ran deterministic validation"));
  const v = world.validate(draft);
  const errors = v.issues.filter((i) => i.severity === "error");
  steps.push({ kind: "validation", text: errors.length ? `${errors.length} problem${errors.length === 1 ? "" : "s"} to fix before funding` : "Valid — no problems found", data: v.issues });
  steps.push({ kind: "draft", text: draft.title, data: { id } });
  if (v.compiled) {
    steps.push(tool(role, "simulate", "Simulated every outcome path"));
    const report = world.simulate(v.compiled.plan, draft.events.map((e) => e.ref));
    const usdc = world.fixtures().assetByKey.USDC!.mint;
    const worst = report.worstCase.netSpendByMint[usdc] ?? 0n;
    const lines = intent.clauses.map((c, i) => {
      const choice = conv.actions[i] ?? { kind: "buy" as const, asset: c.buy ?? "" };
      const what = choice.kind === "portfolio" ? "buy Lumen 60% / Fern 40%" : choice.kind === "buy" ? `buy ${choice.asset}` : "pay the recipient";
      return `• ${fmtUsd(c.amount)}: if ${describeCond(c.cond, (r) => draft.events.find((e) => e.ref === r)?.title ?? r)}, ${what}.`;
    });
    say(
      `Here's the plan — nothing is funded yet.\n${lines.join("\n")}\n• Anything unspent returns to your available balance on ${formatTime(draft.expiresAt)}.\n${intent.releaseOnFail ? "" : "• If a condition resolves the other way, its allocation waits until expiry. Say “release if not” to return it as soon as that's settled.\n"}Worst case across ${report.combos} outcome combinations: ${world.fmt(usdc, worst)} can leave your vault. Open the review to see every path and sign.`,
    );
  }
  return { steps, draft, costUsd: 0, provider: "local" };
}

export { ROLE_INFO, checkPolicyForPlan };
