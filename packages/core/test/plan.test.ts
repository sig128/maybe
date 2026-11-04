import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compileStrategy, decodePlan, encodePlan, PlanError, planHash, TEMPLATES, LIMITS, HEADER_SIZE, NODE_SIZE } from "../src/index.ts";
import { env } from "./helpers.ts";

describe("plan encoding (MYB1)", () => {
  const e = env();
  const compiled = TEMPLATES.map((t) => ({ id: t.id, c: compileStrategy(t.build(e)) }));

  it.each(compiled.map((x) => [x.id, x.c] as const))("%s round-trips byte-for-byte", (_id, c) => {
    const decoded = decodePlan(c.bytes);
    expect(encodePlan(decoded)).toEqual(c.bytes);
    expect(planHash(encodePlan(decoded))).toBe(c.hash);
    expect(c.bytes.length).toBeLessThanOrEqual(LIMITS.MAX_PLAN_BYTES);
  });

  it("compilation is deterministic", () => {
    const t = TEMPLATES.find((x) => x.id === "flagship")!;
    const fixed = { ...e, id: () => "same", nonce: () => "42" };
    expect(compileStrategy(t.build(fixed)).hash).toBe(compileStrategy(t.build(fixed)).hash);
  });

  it("a different nonce gives a different authorization hash", () => {
    const t = TEMPLATES.find((x) => x.id === "flagship")!;
    const a = compileStrategy(t.build({ ...e, nonce: () => "1" }));
    const b = compileStrategy(t.build({ ...e, nonce: () => "2" }));
    expect(a.hash).not.toBe(b.hash);
  });

  it("rejects non-canonical encodings (reserved bytes, unused child slots)", () => {
    const c = compiled.find((x) => x.id === "flagship")!.c;
    const bad = c.bytes.slice();
    bad[15] = 1; // header reserved
    expect(() => decodePlan(bad)).toThrowError(PlanError);
    const nodeStart = HEADER_SIZE + 32 * (c.plan.events.length + c.plan.mints.length + c.plan.refs.length) + 16 * c.plan.allocations.length;
    const bad2 = c.bytes.slice();
    bad2[nodeStart + 8 + 7] = 0; // last child slot of node 0 must be 0xFF
    expect(() => decodePlan(bad2)).toThrowError(/NON_CANONICAL/);
    const bad3 = c.bytes.slice();
    bad3[nodeStart + 5] = 9; // node reserved
    expect(() => decodePlan(bad3)).toThrowError(/NON_CANONICAL/);
  });

  it("rejects truncation, trailing bytes and bad magic", () => {
    const c = compiled[0]!.c;
    expect(() => decodePlan(c.bytes.slice(0, c.bytes.length - 1))).toThrowError(/TRUNCATED/);
    const longer = new Uint8Array(c.bytes.length + 1);
    longer.set(c.bytes);
    expect(() => decodePlan(longer)).toThrowError(/TRAILING_BYTES/);
    const m = c.bytes.slice();
    m[0] = 0;
    expect(() => decodePlan(m)).toThrowError(/BAD_MAGIC/);
  });

  it("rejects forward references (non-topological predicates)", () => {
    const c = compiled.find((x) => x.id === "both-yes")!.c;
    const plan = decodePlan(c.bytes);
    const andIdx = plan.nodes.findIndex((n) => n.op === 3);
    const broken = { ...plan, nodes: plan.nodes.map((n, i) => (i === andIdx ? { ...n, children: [andIdx, 0] } : n)) };
    expect(() => encodePlan(broken)).toThrowError(/NOT_TOPOLOGICAL/);
  });

  it("rejects fees above the plan maximum and swaps without a minimum", () => {
    const plan = decodePlan(compiled.find((x) => x.id === "yes-buys-token")!.c.bytes);
    expect(() => encodePlan({ ...plan, actions: plan.actions.map((a) => ({ ...a, feeBps: a.kind === 1 ? 999 : 0 })) })).toThrowError(/FEE_TOO_HIGH/);
    expect(() => encodePlan({ ...plan, actions: plan.actions.map((a) => (a.kind === 1 ? { ...a, minOut: 0n } : a)) })).toThrowError(/BAD_AMOUNT/);
  });

  it("random bytes never crash the decoder — they are rejected with a PlanError", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 3000 }), (bytes) => {
        try {
          decodePlan(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(PlanError);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("single-byte mutations of a valid plan are either rejected or still structurally valid", () => {
    const c = compiled.find((x) => x.id === "flagship")!.c;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: c.bytes.length - 1 }), fc.integer({ min: 0, max: 255 }), (pos, val) => {
        const b = c.bytes.slice();
        b[pos] = val;
        try {
          const p = decodePlan(b);
          expect(encodePlan(p)).toEqual(b); // anything accepted re-encodes identically: one encoding per plan
        } catch (err) {
          expect(err).toBeInstanceOf(PlanError);
        }
      }),
      { numRuns: 600 },
    );
  });

  it("node size constant matches layout", () => {
    expect(NODE_SIZE).toBe(24);
  });
});
