import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { effectiveEvent, evaluateNodes, INF, NodeOp, truthAt, type EventView, type Plan, type PlanNode } from "../src/index.ts";

const EV = (n: number) => Array.from({ length: n }, (_, i) => `E${i}`);
function plan(nodes: PlanNode[], nEvents = 3): Plan {
  return {
    version: 1,
    flags: 0,
    maxFeeBps: 0,
    voidPolicy: 0,
    expiresAt: 10_000,
    nonce: 0n,
    events: EV(nEvents),
    mints: ["M"],
    refs: [],
    allocations: [{ mint: 0, amount: 1n }],
    nodes,
    actions: [],
  };
}
const node = (op: NodeOp, o: Partial<PlanNode> = {}): PlanNode => ({ op, a: 0, b: 0, k: 0, children: [], param: 0, ...o });
const outcome = (e: number, yes: boolean) => node(NodeOp.OUTCOME, { a: e, b: yes ? 1 : 0 });
const open: EventView = { status: "OPEN", outcome: null, finalAt: null, adapter: "ATTESTATION" };
const fin = (o: "YES" | "NO" | "VOID", at: number): EventView => ({ status: "FINAL", outcome: o, finalAt: at, adapter: "ATTESTATION" });

function evalAt(p: Plan, events: EventView[], now: number, activatedAt = 0) {
  return evaluateNodes(p, { now, activatedAt, event: (i) => events[i], receipt: () => undefined });
}

describe("event finality", () => {
  it("pending becomes final exactly at the end of the challenge window (lazy)", () => {
    const e: EventView = { status: "PENDING", outcome: "YES", finalAt: 100, adapter: "ATTESTATION" };
    expect(effectiveEvent(e, 99).final).toBe(false);
    expect(effectiveEvent(e, 100)).toEqual({ final: true, outcome: "YES", finalAt: 100 });
  });
  it("disputed is never final", () => {
    expect(effectiveEvent({ status: "DISPUTED", outcome: "YES", finalAt: 1, adapter: "ATTESTATION" }, 1e9).final).toBe(false);
  });
  it("balance threshold: open through the deadline second, final NO at deadline + 1", () => {
    const e: EventView = { status: "OPEN", outcome: null, finalAt: null, adapter: "BALANCE", deadline: 500 };
    expect(effectiveEvent(e, 500).final).toBe(false);
    expect(effectiveEvent(e, 501)).toEqual({ final: true, outcome: "NO", finalAt: 501 });
  });
});

describe("truth tables", () => {
  const states: Array<[string, EventView]> = [
    ["open", open],
    ["yes", fin("YES", 10)],
    ["no", fin("NO", 10)],
    ["void", fin("VOID", 10)],
    ["disputed", { status: "DISPUTED", outcome: "YES", finalAt: 10, adapter: "ATTESTATION" }],
  ];
  const expectYes: Record<string, string> = { open: "PENDING", yes: "TRUE", no: "FALSE", void: "FALSE", disputed: "PENDING" };
  const expectNo: Record<string, string> = { open: "PENDING", yes: "FALSE", no: "TRUE", void: "FALSE", disputed: "PENDING" };

  it.each(states)("OUTCOME YES / NO / NOT for %s", (name, ev) => {
    const p = plan([outcome(0, true), outcome(0, false), node(NodeOp.NOT, { children: [0] })]);
    const r = evalAt(p, [ev], 50);
    expect(truthAt(r[0], 50)).toBe(expectYes[name]);
    expect(truthAt(r[1], 50)).toBe(expectNo[name]);
    // NOT of an unresolved/disputed event stays unresolved; NOT(YES) is TRUE for NO and for VOID
    expect(truthAt(r[2], 50)).toBe(expectYes[name] === "PENDING" ? "PENDING" : expectYes[name] === "TRUE" ? "FALSE" : "TRUE");
  });

  it("AND / OR / ATLEAST over all 3-event combinations match Kleene logic", () => {
    const vals: EventView[] = [open, fin("YES", 5), fin("NO", 7)];
    const kleene = (v: EventView) => (v.status === "OPEN" ? "P" : v.outcome === "YES" ? "T" : "F");
    const p = plan([
      outcome(0, true),
      outcome(1, true),
      outcome(2, true),
      node(NodeOp.AND, { children: [0, 1, 2] }),
      node(NodeOp.OR, { children: [0, 1, 2] }),
      node(NodeOp.ATLEAST, { k: 2, children: [0, 1, 2] }),
    ]);
    for (const a of vals)
      for (const b of vals)
        for (const c of vals) {
          const ks = [a, b, c].map(kleene);
          const r = evalAt(p, [a, b, c], 100);
          const and = ks.includes("F") ? "FALSE" : ks.every((k) => k === "T") ? "TRUE" : "PENDING";
          const or = ks.includes("T") ? "TRUE" : ks.every((k) => k === "F") ? "FALSE" : "PENDING";
          const t = ks.filter((k) => k === "T").length;
          const pend = ks.filter((k) => k === "P").length;
          const atl = t >= 2 ? "TRUE" : t + pend < 2 ? "FALSE" : "PENDING";
          expect(truthAt(r[3], 100)).toBe(and);
          expect(truthAt(r[4], 100)).toBe(or);
          expect(truthAt(r[5], 100)).toBe(atl);
        }
  });

  it("time-of-truth: AND is true at the latest child, OR at the earliest, ATLEAST at the k-th", () => {
    const p = plan([outcome(0, true), outcome(1, true), outcome(2, true), node(NodeOp.AND, { children: [0, 1, 2] }), node(NodeOp.OR, { children: [0, 1, 2] }), node(NodeOp.ATLEAST, { k: 2, children: [0, 1, 2] })]);
    const r = evalAt(p, [fin("YES", 30), fin("YES", 10), fin("YES", 20)], 100);
    expect(r[3]!.t).toBe(30);
    expect(r[4]!.t).toBe(10);
    expect(r[5]!.t).toBe(20);
  });
});

describe("veto evaluation timing", () => {
  // node0: trigger A=YES ; node1: VETO(V=YES, trigger=node0, window=100) ; node2: AND(0,1)
  const p = plan([outcome(0, true), node(NodeOp.VETO, { a: 1, b: 1, children: [0], param: 100 }), node(NodeOp.AND, { children: [0, 1] })], 2);
  const trigger = fin("YES", 1000);

  it("veto final before the window ends blocks the trigger", () => {
    const r = evalAt(p, [trigger, fin("YES", 1050)], 5000);
    expect(truthAt(r[2], 5000)).toBe("FALSE");
  });
  it("veto final exactly at T = trigger + window still counts (inclusive boundary)", () => {
    const r = evalAt(p, [trigger, fin("YES", 1100)], 5000);
    expect(truthAt(r[2], 5000)).toBe("FALSE");
  });
  it("veto one second late does not block; truth time is T", () => {
    const r = evalAt(p, [trigger, fin("YES", 1101)], 5000);
    expect(truthAt(r[2], 5000)).toBe("TRUE");
    expect(r[2]!.t).toBe(1100);
  });
  it("no veto yet: pending until T, true from T — independent of when a keeper looks", () => {
    expect(truthAt(evalAt(p, [trigger, open], 1099)[2], 1099)).toBe("PENDING");
    const at = evalAt(p, [trigger, open], 1100);
    expect(truthAt(at[2], 1100)).toBe("TRUE");
    // a veto that finalizes after T doesn't flip an already-true result
    const later = evalAt(p, [trigger, fin("YES", 1200)], 2000);
    expect(later[2]!.t).toBe(1100);
  });
  it("veto resolving NO before the trigger removes the wait", () => {
    const r = evalAt(p, [trigger, fin("NO", 500)], 1000);
    expect(r[2]!.t).toBe(1000);
  });
  it("veto final before the trigger exists still blocks", () => {
    const r = evalAt(p, [open, fin("YES", 10)], 20);
    expect(truthAt(r[1], 20)).toBe("FALSE");
  });
});

describe("properties", () => {
  const evArb = fc.oneof(
    fc.constant(open),
    fc.record({ status: fc.constant("FINAL" as const), outcome: fc.constantFrom("YES" as const, "NO" as const, "VOID" as const), finalAt: fc.integer({ min: 0, max: 1000 }), adapter: fc.constant("ATTESTATION" as const) }),
    fc.record({ status: fc.constant("PENDING" as const), outcome: fc.constantFrom("YES" as const, "NO" as const), finalAt: fc.integer({ min: 0, max: 1000 }), adapter: fc.constant("ATTESTATION" as const) }),
  );
  const p = plan([
    outcome(0, true),
    outcome(1, false),
    outcome(2, true),
    node(NodeOp.NOT, { children: [0] }),
    node(NodeOp.AND, { children: [3, 1] }),
    node(NodeOp.OR, { children: [4, 2] }),
    node(NodeOp.ATLEAST, { k: 2, children: [0, 1, 2] }),
    node(NodeOp.VETO, { a: 1, b: 1, children: [6], param: 50 }),
    node(NodeOp.AND, { children: [6, 7] }),
  ]);
  it("a node is never both TRUE and FALSE, and results never revert as time passes", () => {
    fc.assert(
      fc.property(fc.array(evArb, { minLength: 3, maxLength: 3 }), fc.integer({ min: 0, max: 1200 }), fc.integer({ min: 0, max: 500 }), (events, t1, dt) => {
        const a = evalAt(p, events, t1);
        const b = evalAt(p, events, t1 + dt);
        a.forEach((x, i) => {
          expect(x.t === INF || x.f === INF).toBe(true);
          const before = truthAt(x, t1);
          const after = truthAt(b[i], t1 + dt);
          if (before !== "PENDING") expect(after).toBe(before);
          if (x.t !== INF) expect(b[i]!.t).toBe(x.t); // truth time is a recorded fact, stable
        });
      }),
      { numRuns: 1500 },
    );
  });
});
