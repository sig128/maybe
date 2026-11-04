import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkVaultInvariants, holdingsByMint, templateById } from "@maybe/core";
import { SimulationBackend } from "./simBackend.ts";

/** The in-browser backend end to end: drafts → review → sign → keeper → refund/withdraw. */
describe("SimulationBackend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function settle(b: SimulationBackend, ms = 4000) {
    await vi.advanceTimersByTimeAsync(ms);
    b.tick();
  }

  it("seeds labelled sample data without double counting", async () => {
    const b = new SimulationBackend({ persist: false, autoStart: false });
    const p = await b.portfolio();
    const usdc = (await b.fixtures()).assetByKey.USDC!.mint;
    // 900 deposited; 300 reserved by the active sample; the voided sample refunded its 80
    expect(p.vault.balances[usdc]).toEqual({ available: 600_000_000n, reserved: 300_000_000n });
    expect(p.strategies.every((s) => s.sample)).toBe(true);
    const active = p.strategies.filter((s) => s.runtime && (s.status === "ACTIVE" || s.status === "PAUSED")).map((s) => s.runtime!);
    expect(checkVaultInvariants(p.vault, holdingsByMint(active))).toEqual([]);
    const markets = await b.markets();
    expect(markets.find((m) => m.key === "exhibition-match")?.status).toBe("voided");
    expect(markets.filter((m) => m.quote).every((m) => m.quote!.sample)).toBe(true);
  });

  it("runs the flagship: reserve 500, resolve, execute, refund the unused branch, withdraw", async () => {
    const b = new SimulationBackend({ persist: false, autoStart: false });
    const fx = await b.fixtures();
    const usdc = fx.assetByKey.USDC!.mint;
    const flagship = (await b.strategies()).find((s) => s.doc.meta?.template === "flagship" || s.title.toLowerCase().includes("500"))!;
    expect(flagship).toBeDefined();
    const prep = await b.prepare(flagship.doc);
    expect(prep.ok).toBe(true);
    expect(prep.report!.reservationByMint[usdc]).toBe(500_000_000n);
    expect(prep.report!.worstCase.netSpendByMint[usdc]).toBe(500_000_000n);
    expect(prep.authorization!.planHash).toBe(prep.hash);

    await expect(b.authorize(flagship.id, "0".repeat(64))).rejects.toThrow(/changed since you reviewed/);
    await b.authorize(flagship.id, prep.hash!);
    await settle(b);
    let v = (await b.strategy(flagship.id))!;
    expect(v.status).toBe("ACTIVE");
    let pf = await b.portfolio();
    expect(pf.vault.balances[usdc]!.reserved).toBe(800_000_000n);

    // event A resolves YES: the lumen/fern branch runs; the release branch never can
    const eventA = flagship.doc.events.find((e) => e.ref === "A")!;
    await b.sim!.resolveEvent(eventA.eventKey, "YES");
    await b.sim!.advance(11 * 60);
    await settle(b);
    v = (await b.strategy(flagship.id))!;
    expect(v.receipts.length).toBeGreaterThanOrEqual(2);
    expect(v.readiness.some((r) => r.state === "executable")).toBe(false);

    pf = await b.portfolio();
    const active = pf.strategies.filter((s) => s.runtime && (s.status === "ACTIVE" || s.status === "PAUSED")).map((s) => s.runtime!);
    expect(checkVaultInvariants(pf.vault, holdingsByMint(active))).toEqual([]);

    // withdrawing more than is available is refused; reserved funds stay put
    const avail = pf.vault.balances[usdc]!.available;
    await expect(b.withdraw(usdc, avail + 1n)).rejects.toThrow(/available/);
    await b.withdraw(usdc, avail);
    await settle(b);
    expect((await b.portfolio()).vault.balances[usdc]!.available).toBe(0n);
  });

  it("an edit after signing becomes a new version that needs a new signature", async () => {
    const b = new SimulationBackend({ persist: false, autoStart: false });
    const active = (await b.strategies()).find((s) => s.status === "ACTIVE")!;
    await expect(b.saveDraft({ ...active.doc, title: "changed" })).rejects.toThrow(/new version/);
    const next = await b.newVersionOf(active.id);
    expect(next.status).toBe("DRAFT");
    expect(next.doc.meta?.supersedes).toContain(active.doc.id);
    expect((await b.strategy(active.id))!.doc.title).toBe(active.doc.title);
  });

  it("templates compile against this environment's fixtures", async () => {
    const b = new SimulationBackend({ persist: false, autoStart: false });
    const fx = await b.fixtures();
    let n = 0;
    const doc = templateById("veto-window")!.build({ now: b.now(), fixtures: fx, id: () => `t${n++}`, nonce: () => "77" });
    const prep = await b.prepare(doc);
    expect(prep.compileIssues ?? []).toEqual([]);
    expect(prep.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
