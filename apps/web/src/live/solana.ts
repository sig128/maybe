/**
 * Minimal Solana helpers for reading pump.fun and PumpSwap accounts straight from mainnet in the
 * browser: base58, account decoders (offsets verified against live accounts), and the bonding
 * curve's program-derived address. No wallet, no signing.
 */

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL = "So11111111111111111111111111111111111111112";

/** pump.fun curve constants: 1B supply (6 decimals); 793.1M tokens are sold on the curve. */
export const TOKEN_DECIMALS = 6;
export const TOTAL_SUPPLY_UNITS = 1_000_000_000n * 1_000_000n;
export const INITIAL_REAL_TOKENS = 793_100_000n * 1_000_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000;

// ───────────────────────────────────────── base58 / base64

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58_INDEX.get(c);
    if (v === undefined) throw new Error("not base58");
    n = n * 58n + v;
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function isAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function readU64(b: Uint8Array, offset: number): bigint {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = x * 256n + BigInt(b[offset + i] ?? 0);
  return x;
}

const pubkeyAt = (b: Uint8Array, offset: number) => b58encode(b.subarray(offset, offset + 32));

// ───────────────────────────────────────── accounts

export interface CurveState {
  virtualTokens: bigint;
  virtualSol: bigint;
  realTokens: bigint;
  realSol: bigint;
  totalSupply: bigint;
  complete: boolean;
  creator: string;
}

/** pump.fun BondingCurve: disc(8) vTok vSol rTok rSol supply (u64 each) complete(bool) creator(32). */
export function decodeCurve(data: Uint8Array): CurveState | null {
  if (data.length < 81) return null;
  return {
    virtualTokens: readU64(data, 8),
    virtualSol: readU64(data, 16),
    realTokens: readU64(data, 24),
    realSol: readU64(data, 32),
    totalSupply: readU64(data, 40),
    complete: data[48] === 1,
    creator: pubkeyAt(data, 49),
  };
}

export interface PoolState {
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
}

/** PumpSwap Pool: disc(8) bump(1) index(2) creator(32) base_mint quote_mint lp_mint base_vault quote_vault. */
export function decodePool(data: Uint8Array): PoolState | null {
  if (data.length < 203) return null;
  return { baseMint: pubkeyAt(data, 43), quoteMint: pubkeyAt(data, 75), baseVault: pubkeyAt(data, 139), quoteVault: pubkeyAt(data, 171) };
}

/** SPL / Token-2022 account: mint(32) owner(32) amount(u64) — the same base layout in both programs. */
export function decodeTokenAccount(data: Uint8Array): { mint: string; amount: bigint } | null {
  if (data.length < 72) return null;
  return { mint: pubkeyAt(data, 0), amount: readU64(data, 64) };
}

// ───────────────────────────────────────── curve math

export function curvePriceSol(c: Pick<CurveState, "virtualSol" | "virtualTokens">): number {
  if (c.virtualTokens === 0n) return 0;
  return Number(c.virtualSol) / LAMPORTS_PER_SOL / (Number(c.virtualTokens) / 10 ** TOKEN_DECIMALS);
}

export function curveMcapSol(c: CurveState): number {
  const supply = c.totalSupply > 0n ? c.totalSupply : TOTAL_SUPPLY_UNITS;
  return curvePriceSol(c) * (Number(supply) / 10 ** TOKEN_DECIMALS);
}

/**
 * Share of the curve's sellable tokens already bought, 0..1 (1 once complete) — what pump.fun calls
 * bonding curve progress. A curve launched with other parameters falls back to the SOL raised so far
 * against the SOL it takes to finish.
 */
export function curveProgress(c: CurveState): number {
  if (c.complete) return 1;
  if (c.realTokens > INITIAL_REAL_TOKENS) {
    const raised = Number(c.realSol) / LAMPORTS_PER_SOL;
    const left = curveRemainingSol(c);
    return raised + left > 0 ? Math.min(1, Math.max(0, raised / (raised + left))) : 0;
  }
  const sold = Number(INITIAL_REAL_TOKENS - c.realTokens) / Number(INITIAL_REAL_TOKENS);
  return Math.min(1, Math.max(0, sold));
}

/** vTok·vSol of a standard pump.fun SOL curve: it launches at 1,073,000,000 tokens × 30 SOL and trades keep it. */
export const STANDARD_CURVE_K = 1_073_000_000n * 10n ** BigInt(TOKEN_DECIMALS) * 30n * BigInt(LAMPORTS_PER_SOL);
/** Tokens that exist only virtually (vTok − rTok): 1,073M − 793.1M. Buys and sells move both sides equally. */
export const STANDARD_VIRTUAL_OFFSET = 1_073_000_000n * 10n ** BigInt(TOKEN_DECIMALS) - INITIAL_REAL_TOKENS;

/**
 * Whether a curve has pump.fun's standard SOL parameters. Curves launched with other reserves or
 * another quote asset fail this check; their graduation can't be priced the same way, so the board
 * leaves them out rather than show numbers that mean nothing.
 */
export function isStandardCurve(c: Pick<CurveState, "virtualSol" | "virtualTokens" | "realTokens">): boolean {
  if (c.virtualTokens <= 0n || c.virtualSol <= 0n || c.realTokens < 0n) return false;
  const k = c.virtualTokens * c.virtualSol;
  // each trade's rounding nudges k up by a hair; another launch configuration is off by far more
  if (k * 100n < STANDARD_CURVE_K * 98n || k * 100n > STANDARD_CURVE_K * 103n) return false;
  const offset = c.virtualTokens - c.realTokens;
  const slack = 1_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
  return offset > STANDARD_VIRTUAL_OFFSET - slack && offset < STANDARD_VIRTUAL_OFFSET + slack;
}

/** SOL still needed to buy every remaining token on the curve (constant product: vSol·vTok = k). */
export function curveRemainingSol(c: CurveState): number {
  if (c.complete || c.realTokens <= 0n) return 0;
  const k = c.virtualSol * c.virtualTokens;
  const finalVirtualTokens = c.virtualTokens - c.realTokens;
  if (finalVirtualTokens <= 0n) return 0;
  const finalVirtualSol = k / finalVirtualTokens;
  return Math.max(0, Number(finalVirtualSol - c.virtualSol) / LAMPORTS_PER_SOL);
}

/** Curve state from a PumpPortal create message (tokens and SOL given as decimal numbers). */
export function curveFromCreate(m: { vTokensInBondingCurve?: number; vSolInBondingCurve?: number; traderPublicKey?: string }): CurveState | null {
  if (typeof m.vTokensInBondingCurve !== "number" || typeof m.vSolInBondingCurve !== "number") return null;
  const virtualTokens = BigInt(Math.round(m.vTokensInBondingCurve * 10 ** TOKEN_DECIMALS));
  const virtualSol = BigInt(Math.round(m.vSolInBondingCurve * LAMPORTS_PER_SOL));
  // virtual reserves start at 1,073,000,000 tokens / 30 SOL; real = virtual minus the virtual offset
  const realTokens = virtualTokens - (1_073_000_000n * 1_000_000n - INITIAL_REAL_TOKENS);
  const realSol = virtualSol - 30n * BigInt(LAMPORTS_PER_SOL);
  return { virtualTokens, virtualSol, realTokens: realTokens > 0n ? realTokens : 0n, realSol: realSol > 0n ? realSol : 0n, totalSupply: TOTAL_SUPPLY_UNITS, complete: false, creator: m.traderPublicKey ?? "" };
}

// ───────────────────────────────────────── program-derived addresses

const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n, P);

function mod(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  let x = ((b % m) + m) % m;
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = (r * x) % m;
    x = (x * x) % m;
    k >>= 1n;
  }
  return r;
}
function modInv(a: bigint): bigint {
  return modPow(a, P - 2n, P);
}

/** Is this 32-byte string a valid compressed ed25519 point? PDAs must not be. */
export function isOnCurve(bytes: Uint8Array): boolean {
  const last = bytes[31] ?? 0;
  const sign = last >> 7;
  const yBytes = Uint8Array.from(bytes);
  yBytes[31] = last & 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(yBytes[i] ?? 0);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * modPow(mod(u * v7), (P - 5n) / 8n, P));
  const vx2 = mod(v * x * x);
  if (vx2 === u) {
    // x is a root
  } else if (vx2 === mod(-u)) {
    x = mod(x * SQRT_M1);
  } else {
    return false;
  }
  if (x === 0n && sign === 1) return false;
  return true;
}

const enc = new TextEncoder();

export async function findProgramAddress(seeds: Uint8Array[], programId: string): Promise<string> {
  const program = b58decode(programId);
  const marker = enc.encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, marker];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    if (!isOnCurve(hash)) return b58encode(hash);
  }
  throw new Error("no program address");
}

export function bondingCurveAddress(mint: string): Promise<string> {
  return findProgramAddress([enc.encode("bonding-curve"), b58decode(mint)], PUMP_PROGRAM);
}
