import { RouteKind } from "./plan.ts";
import type { SwapFill, SwapRequest, Venue } from "./engine.ts";

/**
 * Constant-product pool math, identical to the local swap venue program
 * (programs/maybe-testswap). Used by the simulation backend, by quotes in the
 * builder, and as the conformance reference for the program.
 */

export interface CpPool {
  address: string;
  mintA: string;
  mintB: string;
  reserveA: bigint;
  reserveB: bigint;
  /** venue fee charged by the pool itself (not MAYBE's protocol fee) */
  feeBps: number;
}

export interface OutcomeMarketPool {
  address: string;
  /** event account this market settles against */
  event: string;
  collateralMint: string;
  yesMint: string;
  /** collateral micro-units per 1 outcome token (6 decimals), fixed in the local venue */
  yesPriceE6: bigint;
}

export function cpQuote(pool: CpPool, inMint: string, amountIn: bigint): bigint {
  const aToB = inMint === pool.mintA;
  if (!aToB && inMint !== pool.mintB) throw new Error("mint not in pool");
  const rin = aToB ? pool.reserveA : pool.reserveB;
  const rout = aToB ? pool.reserveB : pool.reserveA;
  const inAfterFee = (amountIn * BigInt(10_000 - pool.feeBps)) / 10_000n;
  if (inAfterFee === 0n) return 0n;
  return (rout * inAfterFee) / (rin + inAfterFee);
}

export function cpApply(pool: CpPool, inMint: string, amountIn: bigint): { pool: CpPool; out: bigint } {
  const out = cpQuote(pool, inMint, amountIn);
  const aToB = inMint === pool.mintA;
  return {
    out,
    pool: aToB
      ? { ...pool, reserveA: pool.reserveA + amountIn, reserveB: pool.reserveB - out }
      : { ...pool, reserveB: pool.reserveB + amountIn, reserveA: pool.reserveA - out },
  };
}

/** Spot price of 1 whole `base` token in `quote` micro units (display only). */
export function cpSpotE6(pool: CpPool, base: string, baseDecimals: number, quoteDecimals: number): bigint {
  const [rb, rq] = base === pool.mintA ? [pool.reserveA, pool.reserveB] : [pool.reserveB, pool.reserveA];
  if (rb === 0n) return 0n;
  return (rq * 10n ** BigInt(baseDecimals) * 1_000_000n) / (rb * 10n ** BigInt(quoteDecimals));
}

export interface SimVenueState {
  cp: Record<string, CpPool>;
  outcome: Record<string, OutcomeMarketPool>;
  /** final outcomes of events, for redemption */
  eventOutcome: (event: string) => "YES" | "NO" | "VOID" | null;
}

/**
 * Simulated venue. Mutates pool reserves on successful swaps. `behaviour`
 * lets tests model a malicious or failing route.
 */
export class SimVenue implements Venue {
  constructor(
    public state: SimVenueState,
    public behaviour: "honest" | "overspend" | "underdeliver" | "fail" | "partial" = "honest",
  ) {}

  quote(req: Omit<SwapRequest, "minOut" | "now">): bigint {
    if (req.routeKind === RouteKind.CP_SWAP) {
      const p = this.state.cp[req.pool];
      return p ? cpQuote(p, req.inMint, req.amountIn) : 0n;
    }
    const m = this.state.outcome[req.pool];
    if (!m) return 0n;
    if (req.routeKind === RouteKind.OUTCOME_BUY) return (req.amountIn * 1_000_000n) / m.yesPriceE6;
    const o = this.state.eventOutcome(m.event);
    return o === "YES" ? req.amountIn : o === "VOID" ? (req.amountIn * m.yesPriceE6) / 1_000_000n : 0n;
  }

  swap(req: SwapRequest): SwapFill {
    if (this.behaviour === "fail") return { error: "route unavailable" };
    if (req.routeKind === RouteKind.CP_SWAP) {
      const p = this.state.cp[req.pool];
      if (!p) return { error: "unknown pool" };
      if (!((req.inMint === p.mintA && req.outMint === p.mintB) || (req.inMint === p.mintB && req.outMint === p.mintA))) return { error: "pair mismatch" };
      const spend = this.behaviour === "partial" ? req.amountIn / 2n : req.amountIn;
      const { pool, out } = cpApply(p, req.inMint, spend);
      if (out < req.minOut && this.behaviour === "honest") return { error: "slippage: minimum received not met" };
      this.state.cp[req.pool] = pool;
      if (this.behaviour === "overspend") return { spentIn: spend + 1n, receivedOut: out };
      if (this.behaviour === "underdeliver") return { spentIn: spend, receivedOut: out / 2n };
      return { spentIn: spend, receivedOut: out };
    }
    const m = this.state.outcome[req.pool];
    if (!m) return { error: "unknown outcome market" };
    if (req.routeKind === RouteKind.OUTCOME_BUY) {
      if (req.inMint !== m.collateralMint || req.outMint !== m.yesMint) return { error: "pair mismatch" };
      return { spentIn: req.amountIn, receivedOut: (req.amountIn * 1_000_000n) / m.yesPriceE6 };
    }
    if (req.inMint !== m.yesMint || req.outMint !== m.collateralMint) return { error: "pair mismatch" };
    const o = this.state.eventOutcome(m.event);
    if (o === null) return { error: "market not settled" };
    const out = o === "YES" ? req.amountIn : o === "VOID" ? (req.amountIn * m.yesPriceE6) / 1_000_000n : 0n;
    if (out === 0n) return { error: "losing outcome tokens redeem for nothing" };
    return { spentIn: req.amountIn, receivedOut: out };
  }
}
