import { describe, expect, it } from "vitest";
import { b58decode, b58encode, bondingCurveAddress, curveFromCreate, curveMcapSol, curveProgress, curveRemainingSol, decodeCurve, decodePool, decodeTokenAccount, isAddress, isOnCurve, isStandardCurve, INITIAL_REAL_TOKENS, type CurveState } from "./solana.ts";
import { aboveProbability, bidPrice, firstPassage, FlowTracker, FLOW_PRIOR, graduationProbability, linePrice, normCdf, priceSigma, realizedVolPerSqrtHour } from "./model.ts";
import { ipfsUrl } from "./sources.ts";
import { LiveEngine, type Market } from "./engine.ts";

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};

function curveBytes(c: Omit<CurveState, "creator">, creator = new Uint8Array(32).fill(7)): Uint8Array {
  const out = new Uint8Array(166);
  out.set(u64(c.virtualTokens), 8);
  out.set(u64(c.virtualSol), 16);
  out.set(u64(c.realTokens), 24);
  out.set(u64(c.realSol), 32);
  out.set(u64(c.totalSupply), 40);
  out[48] = c.complete ? 1 : 0;
  out.set(creator, 49);
  return out;
}

describe("solana helpers", () => {
  it("base58 round-trips, keeps leading zeros, and validates addresses", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 250, 251]);
    expect(b58decode(b58encode(bytes))).toEqual(bytes);
    expect(isAddress("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")).toBe(true);
    expect(isAddress("not-an-address")).toBe(false);
  });

  it("derives a pump.fun bonding curve address exactly as the chain does", async () => {
    // real launches from the live stream: mint → bondingCurveKey reported by PumpPortal
    expect(await bondingCurveAddress("97ysY4XR8T5pPCdn9fEFbeyeb26mwqmYeQadF4cTpump")).toBe("DcxV4qgrfrDQkc785GZseMPWRpCvQtRNckss7ybtA1as");
    expect(await bondingCurveAddress("9QDHncKKFsqVzvmsP67yDBxUBS9xqf8Qu9Koj5ZQNazt")).toBe("7zWkAezpRqQtFuMmhbxTr4B9ziP3XRCiF7x2mPKezsJW");
  });

  it("tells curve points from program addresses", () => {
    // the ed25519 base point is on the curve; a known PDA is not
    const base = Uint8Array.from([0x58, ...Array(31).fill(0x66)]);
    expect(isOnCurve(base)).toBe(true);
    expect(isOnCurve(b58decode("DcxV4qgrfrDQkc785GZseMPWRpCvQtRNckss7ybtA1as"))).toBe(false);
  });

  it("decodes a bonding curve and reads its progress, price and SOL left", () => {
    const fresh = curveFromCreate({ vTokensInBondingCurve: 1_073_000_000, vSolInBondingCurve: 30, traderPublicKey: "x" })!;
    expect(fresh.realTokens).toBe(INITIAL_REAL_TOKENS);
    expect(curveProgress(fresh)).toBe(0);
    expect(curveRemainingSol(fresh)).toBeCloseTo(85.005, 1);
    expect(curveMcapSol(fresh)).toBeCloseTo(27.96, 1); // PumpPortal reports marketCapSol ≈ 27.96 at launch
    const decoded = decodeCurve(curveBytes({ ...fresh, complete: false }))!;
    expect(decoded.virtualSol).toBe(fresh.virtualSol);
    expect(decoded.complete).toBe(false);
    // half the sellable tokens bought
    const half = { ...fresh, realTokens: INITIAL_REAL_TOKENS / 2n };
    expect(curveProgress(half)).toBeCloseTo(0.5, 6);
    expect(curveProgress({ ...fresh, complete: true })).toBe(1);
    expect(decodeCurve(new Uint8Array(40))).toBeNull();
  });

  it("accepts standard SOL curves and refuses curves launched with other reserves", () => {
    // real PumpPortal create messages, a standard launch with a dev buy and a bare one
    const withDevBuy = curveFromCreate({ vTokensInBondingCurve: 1059053614.995806, vSolInBondingCurve: 30.395061726999984 })!;
    const bare = curveFromCreate({ vTokensInBondingCurve: 1072646865.308542, vSolInBondingCurve: 30.009876540999997 })!;
    expect(isStandardCurve(withDevBuy)).toBe(true);
    expect(isStandardCurve(bare)).toBe(true);
    // launches the board saw with other parameters: the same token reserves against ~775 and ~0.7 "SOL"
    expect(isStandardCurve(curveFromCreate({ vTokensInBondingCurve: 1_073_000_000, vSolInBondingCurve: 775 })!)).toBe(false);
    expect(isStandardCurve(curveFromCreate({ vTokensInBondingCurve: 1_073_000_000, vSolInBondingCurve: 0.7 })!)).toBe(false);
    // halfway up a standard curve on-chain: k and the virtual offset are unchanged by trading
    const vTok = 600_000_000n * 1_000_000n;
    const half: CurveState = { virtualTokens: vTok, virtualSol: (1_073_000_000n * 1_000_000n * 30_000_000_000n) / vTok + 1n, realTokens: vTok - (1_073_000_000n * 1_000_000n - INITIAL_REAL_TOKENS), realSol: 0n, totalSupply: 0n, complete: false, creator: "" };
    expect(isStandardCurve(half)).toBe(true);
    // same k, but a different split between real and virtual tokens
    expect(isStandardCurve({ ...half, realTokens: half.realTokens - 50_000_000n * 1_000_000n })).toBe(false);
  });

  it("decodes PumpSwap pools and token accounts at the verified offsets", () => {
    const pool = new Uint8Array(301);
    pool.set(b58decode("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), 43);
    pool.set(b58decode("So11111111111111111111111111111111111111112"), 75);
    const p = decodePool(pool)!;
    expect(p.baseMint).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    expect(p.quoteMint).toBe("So11111111111111111111111111111111111111112");
    const ta = new Uint8Array(165);
    ta.set(u64(123_456_789n), 64);
    expect(decodeTokenAccount(ta)!.amount).toBe(123_456_789n);
  });

  it("rewrites IPFS links to a gateway browsers can read, leaving other hosts alone", () => {
    expect(ipfsUrl("https://ipfs.io/ipfs/bafkabc")).toBe("https://ipfs.filebase.io/ipfs/bafkabc");
    expect(ipfsUrl("ipfs://bafkabc/meta.json")).toBe("https://ipfs.filebase.io/ipfs/bafkabc/meta.json");
    expect(ipfsUrl("https://cdn.example.org/a.png")).toBe("https://cdn.example.org/a.png");
  });
});

describe("the live line", () => {
  it("normal CDF and first passage behave", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    // driftless: P(hit a by t) = 2·(1 − Φ(a/σ√t)) — the reflection principle
    expect(firstPassage(10, 0, 2, 25)).toBeCloseTo(2 * (1 - normCdf(10 / (2 * 5))), 6);
    expect(firstPassage(0, 0, 1, 1)).toBe(1);
    expect(firstPassage(5, 100, 1, 1)).toBeCloseTo(1, 6);
    expect(Number.isFinite(firstPassage(80, 400, 0.5, 60))).toBe(true);
  });

  it("graduation odds rise with flow and time, fall with SOL still needed, and stay in range", () => {
    const flow = { mu: 3, sigma: 4, minutes: 5 };
    const base = graduationProbability(40, flow, 15);
    expect(graduationProbability(20, flow, 15)).toBeGreaterThan(base);
    expect(graduationProbability(40, flow, 30)).toBeGreaterThan(base);
    expect(graduationProbability(40, { ...flow, mu: 8 }, 15)).toBeGreaterThan(base);
    expect(graduationProbability(40, { ...flow, mu: -3 }, 15)).toBeLessThan(base);
    expect(graduationProbability(0, flow, 15)).toBe(1);
    expect(graduationProbability(40, flow, 0)).toBe(0);
    for (const r of [1, 10, 85]) for (const t of [1, 15, 60]) {
      const p = graduationProbability(r, flow, t);
      expect(p).toBeGreaterThanOrEqual(0.005);
      expect(p).toBeLessThanOrEqual(0.995);
    }
    // a fresh launch with no flow yet sits near pump.fun's base rate
    const prior = graduationProbability(85, FLOW_PRIOR, 60);
    expect(prior).toBeGreaterThan(0.005);
    expect(prior).toBeLessThan(0.05);
  });

  it("price odds follow the ratio to the strike", () => {
    expect(aboveProbability(1.5, 0.5, 1.6)).toBeGreaterThan(aboveProbability(1, 0.5, 1.6));
    expect(aboveProbability(0.5, 0.5, 1.6)).toBeLessThan(aboveProbability(1, 0.5, 1.6));
    expect(aboveProbability(1.2, 0, 1.6)).toBeCloseTo(0.995, 3);
    // at the strike an hour out: a little under even, from the downward median drift
    const atStrike = aboveProbability(1, 1, priceSigma(null));
    expect(atStrike).toBeGreaterThan(0.35);
    expect(atStrike).toBeLessThan(0.5);
    // 10% above the strike is better than at it, and well above it is likely
    expect(aboveProbability(1.1, 1, priceSigma(null))).toBeGreaterThan(atStrike);
    expect(aboveProbability(3, 1, priceSigma(null))).toBeGreaterThan(0.8);
    // trade-by-trade volatility is tempered and bounded
    expect(priceSigma(20)).toBe(2.5);
    expect(priceSigma(0)).toBe(0.5);
  });

  it("the line charges a spread both ways", () => {
    expect(linePrice(0.3, "YES")).toBeCloseTo(0.32, 6);
    expect(linePrice(0.3, "NO")).toBeCloseTo(0.72, 6);
    expect(bidPrice(0.3, "YES")).toBeCloseTo(0.28, 6);
    expect(linePrice(0.999, "YES")).toBe(0.99);
  });

  it("flow tracker estimates a steady inflow and fades when trading stops", () => {
    const f = new FlowTracker(1);
    let t = 0;
    let sol = 0;
    for (let i = 0; i < 120; i++) {
      t += 5000;
      sol += 0.5; // 6 SOL a minute
      f.observe(t, sol);
    }
    expect(f.estimate(t).mu).toBeGreaterThan(5);
    expect(f.estimate(t + 5 * 60_000).mu).toBeLessThan(1);
  });

  it("realized volatility needs enough samples", () => {
    expect(realizedVolPerSqrtHour([[0, 1]])).toBeNull();
    const samples: Array<[number, number]> = Array.from({ length: 30 }, (_, i) => [i * 60_000, i % 2 ? 1.1 : 1]);
    expect(realizedVolPerSqrtHour(samples)).toBeGreaterThan(0.5);
  });
});

describe("practice ledger", () => {
  type Internals = { openMarket(mint: string, kind: Market["kind"], o: number, c: number, s?: number): Market | undefined; addToken(t: object): void; resolve(id: string, o: "yes" | "no" | "void", note: string): void };
  const engine = () => {
    const e = new LiveEngine();
    const i = e as unknown as Internals;
    i.addToken({ mint: "M1", symbol: "AAA", name: "A", createdAt: Date.now(), seenAt: Date.now(), source: "launch", stage: "new", stageAt: Date.now() });
    const m = i.openMarket("M1", "grad-1h", Date.now(), Date.now() + 3_600_000)!;
    return { e, i, m };
  };

  it("buys at the line, pays 1 per share on a win, nothing on a loss", () => {
    const { e, i, m } = engine();
    const start = e.getPractice().balance;
    const yes = e.buy(m.id, "YES", 1);
    const no = e.buy(m.id, "NO", 0.5);
    expect(yes.ok && no.ok).toBe(true);
    expect(e.getPractice().balance).toBeCloseTo(start - 1.5, 9);
    const yesPos = yes.ok ? yes.position : null;
    i.resolve(m.id, "yes", "test");
    const p = e.getPractice();
    expect(p.positions.find((x) => x.id === yesPos!.id)!.status).toBe("won");
    expect(p.balance).toBeCloseTo(start - 1.5 + yesPos!.shares, 9);
    expect(p.positions.filter((x) => x.status === "lost")).toHaveLength(1);
  });

  it("refuses more than the balance, a closed question, and returns stakes on a void", () => {
    const { e, i, m } = engine();
    expect(e.buy(m.id, "YES", 1e6)).toMatchObject({ ok: false });
    const r = e.buy(m.id, "NO", 2);
    const before = e.getPractice().balance;
    i.resolve(m.id, "void", "test");
    expect(e.getPractice().balance).toBeCloseTo(before + 2, 9);
    expect(e.buy(m.id, "YES", 1)).toMatchObject({ ok: false, reason: "This question has closed." });
    expect(r.ok).toBe(true);
  });

  it("sells back at the bid before the close", () => {
    const { e, m } = engine();
    const r = e.buy(m.id, "YES", 1);
    if (!r.ok) throw new Error("buy failed");
    const v = e.value(r.position)!;
    expect(v).toBeLessThan(1); // the spread
    const back = e.sell(r.position.id)!;
    expect(back).toBeCloseTo(v, 9);
    expect(e.getPractice().positions[0]!.status).toBe("closed");
  });
});
