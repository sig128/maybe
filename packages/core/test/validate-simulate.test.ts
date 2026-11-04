import { describe, expect, it } from "vitest";
import {
  TEMPLATES,
  validateStrategy,
  simulatePlan,
  compileStrategy,
  buildAuthorization,
  toSentence,
  applyOp,
  History,
  checkPolicyForPlan,
  killSwitch,
  chargePolicy,
  MACHINES,
  transition,
  TransitionError,
  strategyMachine,
  txMachine,
  type CapabilityPolicy,
  type DescribeLookup,
  type Strategy,
} from "../src/index.ts";
import { build, env, fixtures, NOW, OWNER, validationContextFor } from "./helpers.ts";

const f = fixtures();
const e = env();
const USDC = f.assetByKey.USDC!.mint;

describe("templates", () => {
  it.each(TEMPLATES.map((t) => [t.id] as const))("%s validates cleanly and simulates", (id) => {
    const doc = build(id, e);
    const res = validateStrategy(doc, validationContextFor(doc, f));
    const errors = res.issues.filter((i) => i.severity === "error");
    // the dependent template references a predecessor future that isn't a registered market — that's fine
    expect(errors).toEqual([]);
    expect(res.ok).toBe(true);
    const report = simulatePlan(res.compiled!.plan, { start: NOW });
    expect(report.paths.length).toBeGreaterThan(0);
    // worst case never exceeds the reservation in the reservation asset
    for (const [mint, reserved] of Object.entries(report.reservationByMint)) {
      expect((report.worstCase.netSpendByMint[mint] ?? 0n) <= reserved).toBe(true);
    }
  });
});

describe("flagship review", () => {
  const doc = build("flagship", e);
  const c = compileStrategy(doc);
  const report = simulatePlan(c.plan, { start: NOW }, doc.events.map((x) => x.ref));

  it("enumerates every outcome path and the worst case is exactly 500 USDC", () => {
    expect(report.combos).toBe(64);
    expect(report.worstCase.spendByMint[USDC]).toBe(500_000_000n);
    const totalFees = report.worstCase.feesByMint[USDC]!;
    expect(totalFees <= (500_000_000n * 30n) / 10_000n).toBe(true);
    const descriptions = report.paths.map((p) => p.description);
    expect(descriptions.some((d) => d.includes("A: YES") && d.includes("B: YES") && d.includes("C: YES"))).toBe(true);
    // every path closes, and unspent funds come back
    for (const p of report.paths) {
      const spent = p.representative.spentByMint[USDC] ?? 0n;
      const refunded = p.representative.refunded[USDC] ?? 0n;
      const released = p.representative.executed.filter((x) => x.action === 2).reduce((m, x) => m + x.received, 0n);
      expect(spent + refunded + released).toBe(500_000_000n);
    }
  });

  it("authorization is rendered from the decoded bytes", () => {
    const lookup: DescribeLookup = {
      event: (k) => {
        const m = f.markets.find((x) => x.eventKey === k);
        return m ? { title: m.title, venue: m.venue, trust: "trusted attestation (development)", ruleHash: m.ruleHash } : undefined;
      },
      asset: (m) => f.assets.find((a) => a.mint === m),
      ref: (r) => {
        const p = f.pools.find((x) => x.address === r);
        return p ? { label: "Local pool", kind: "pool" } : undefined;
      },
    };
    const auth = buildAuthorization(c.bytes, lookup, report, { events: c.sourceMap.events, actions: doc.actions.map((a) => a.label), allocations: doc.allocations.map((a) => a.label) }, { now: NOW, environment: "Simulation" });
    expect(auth.planHash).toBe(c.hash);
    expect(auth.headline).toContain("500 USDC");
    expect(auth.steps).toHaveLength(4);
    expect(auth.steps[2]!.does).toContain("Return");
    expect(auth.steps[3]!.when).toBe("B resolves YES and C resolves YES");
    expect(auth.warnings).toEqual([]);
  });
});

describe("validation pinpoints problems", () => {
  const base = build("yes-buys-token", e);
  const ctx = validationContextFor(base, f);
  const issuesFor = (doc: Strategy) => validateStrategy(doc, ctx).issues.filter((i) => i.severity === "error");

  it("impossible condition: A YES and A NO", () => {
    const doc: Strategy = { ...base, nodes: [...base.nodes, { id: "both", kind: "and", children: ["aYes", "aNo"] }], actions: base.actions.map((a) => (a.id === "buy" ? { ...a, guard: "both" } : a)) };
    const issues = issuesFor(doc);
    expect(issues.find((i) => i.code === "IMPOSSIBLE_CONDITION")?.target).toEqual({ kind: "node", id: "both" });
    expect(issues.find((i) => i.code === "UNREACHABLE_ACTION")?.target).toEqual({ kind: "action", id: "buy" });
  });

  it("overallocated budget is reported on the allocation", () => {
    const doc = applyOp(base, { op: "setAllocationAmount", allocationId: "main", amount: "50000000" });
    const issue = issuesFor(doc).find((i) => i.code === "OVERALLOCATED");
    expect(issue?.target).toEqual({ kind: "allocation", id: "main" });
  });

  it("deadline after expiry and expiry in the past", () => {
    const doc = applyOp(base, { op: "setActionDeadline", actionId: "buy", deadline: base.expiresAt + 10 });
    expect(issuesFor(doc).some((i) => i.code === "DEADLINE_AFTER_EXPIRY" && i.target.id === "buy")).toBe(true);
    expect(issuesFor({ ...base, expiresAt: NOW - 1 }).some((i) => i.code === "EXPIRY_IN_PAST")).toBe(true);
  });

  it("read-only venue cannot trigger funded actions", () => {
    const ro = { ...ctx, markets: { ...ctx.markets, [base.events[0]!.eventKey]: { venue: "polymarket" as const, executable: false, binary: true, reason: "Polymarket is read-only here" } } };
    const issue = validateStrategy(base, ro).issues.find((i) => i.code === "VENUE_READ_ONLY");
    expect(issue?.target).toEqual({ kind: "event", id: "A" });
  });

  it("multi-outcome and voided markets are rejected as triggers", () => {
    const multi = f.markets.find((m) => m.key === "winter-cup-winner")!;
    const doc: Strategy = { ...base, events: [{ ...base.events[0]!, eventKey: multi.eventKey }] };
    expect(issuesFor(doc).some((i) => i.code === "NOT_BINARY")).toBe(true);
    const voided = f.markets.find((m) => m.key === "exhibition-match")!;
    const doc2: Strategy = { ...base, events: [{ ...base.events[0]!, eventKey: voided.eventKey }] };
    expect(issuesFor(doc2).some((i) => i.code === "ALREADY_RESOLVED")).toBe(true);
  });

  it("tokens with transfer fees are rejected", () => {
    const taxed = f.assetByKey.TAXED!.mint;
    const doc: Strategy = { ...base, actions: base.actions.map((a) => (a.kind === "swap" ? { ...a, outputMint: taxed } : a)) };
    expect(issuesFor(doc).some((i) => i.code === "UNSUPPORTED_TOKEN" && i.message.includes("TransferFeeConfig"))).toBe(true);
  });

  it("agent drafts with open questions can never compile", () => {
    const doc: Strategy = { ...base, unresolved: [{ field: "events.A", question: "Which 'election' market did you mean?" }] };
    const r = validateStrategy(doc, ctx);
    expect(r.ok).toBe(false);
    expect(r.compiled).toBeUndefined();
  });

  it("reservation larger than the vault's available balance", () => {
    const r = validateStrategy(base, { ...ctx, availableByMint: { [USDC]: 10n } });
    expect(r.issues.some((i) => i.code === "INSUFFICIENT_AVAILABLE")).toBe(true);
  });
});

describe("sentence view & history", () => {
  it("renders the simple IF / THEN / OTHERWISE / BEFORE sentence", () => {
    const doc = build("yes-buys-token", e);
    const s = toSentence(doc, (m) => f.assets.find((a) => a.mint === m));
    expect(s.simple).toBe(true);
    const words = s.clauses[0]!.tokens.map((t) => ("text" in t ? t.text : t.t === "outcome" ? t.outcome : t.t === "event" ? `[${t.ref}]` : "")).join(" ");
    expect(words).toMatch(/^IF \[A\] resolves YES THEN use 100 USDC to buy MAYBE OTHERWISE return unspent funds BEFORE/);
  });
  it("edits in one view are undoable edits of the shared document", () => {
    const doc = build("yes-buys-token", e);
    const h = new History(doc);
    h.push(applyOp(h.present, { op: "setOutcome", nodeId: "aYes", outcome: "NO" }));
    expect(h.present.nodes.find((n) => n.id === "aYes")).toMatchObject({ outcome: "NO" });
    h.undo();
    expect(h.present).toBe(doc);
    h.redo();
    expect(h.present.nodes.find((n) => n.id === "aYes")).toMatchObject({ outcome: "NO" });
  });
});

describe("agent capability policy", () => {
  const doc = build("yes-buys-token", e);
  const plan = compileStrategy(doc).plan;
  const policy: CapabilityPolicy = {
    address: "pol",
    vault: "v",
    owner: OWNER,
    sessionKey: "sess",
    label: "Strategy Builder",
    epoch: 0,
    canCreate: true,
    canCancel: false,
    allowedMints: plan.mints,
    allowedRoutes: plan.refs,
    allowedRecipients: [],
    maxTotal: { [USDC]: 150_000_000n },
    maxPerAction: { [USDC]: 100_000_000n },
    maxFeeBps: 30,
    expiresAt: NOW + 90 * 86_400,
    spent: {},
    revoked: false,
  };
  it("allows an in-policy plan and charges it", () => {
    expect(checkPolicyForPlan(policy, plan, { policyEpoch: 0 }, NOW)).toEqual({ ok: true, violations: [] });
    const charged = chargePolicy(policy, plan);
    expect(charged.spent[USDC]).toBe(100_000_000n);
    expect(checkPolicyForPlan(charged, plan, { policyEpoch: 0 }, NOW).ok).toBe(false); // total cap now exceeded
  });
  it("rejects out-of-policy assets, routes, fees, and anything after the kill switch", () => {
    expect(checkPolicyForPlan({ ...policy, allowedMints: [USDC] }, plan, { policyEpoch: 0 }, NOW).ok).toBe(false);
    expect(checkPolicyForPlan({ ...policy, allowedRoutes: [] }, plan, { policyEpoch: 0 }, NOW).ok).toBe(false);
    expect(checkPolicyForPlan({ ...policy, maxFeeBps: 10 }, plan, { policyEpoch: 0 }, NOW).ok).toBe(false);
    const v = killSwitch({ policyEpoch: 0 });
    expect(checkPolicyForPlan(policy, plan, v, NOW).violations).toContain("policy predates the latest kill switch");
  });
});

describe("state machines", () => {
  it.each(MACHINES.map((m) => [m.name, m] as const))("%s: every state reachable, terminal states have no exits", (_n, m) => {
    const reach = new Set([m.initial]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of m.transitions)
        if (reach.has(t.from as never) && !reach.has(t.to as never)) {
          reach.add(t.to as never);
          grew = true;
        }
    }
    expect([...m.states].filter((s) => !reach.has(s as never))).toEqual([]);
    for (const term of m.terminal) expect(m.transitions.filter((t) => t.from === term)).toEqual([]);
  });
  it("rejects transitions not in the table", () => {
    expect(() => transition(strategyMachine, "COMPLETED", "CANCEL")).toThrowError(TransitionError);
    expect(transition(strategyMachine, "READY", "EDIT")).toBe("DRAFT");
    expect(transition(txMachine, "UNKNOWN", "NOT_FOUND_AFTER_EXPIRY")).toBe("EXPIRED");
  });
});
