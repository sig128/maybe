/**
 * Fixed-point money. Every amount in MAYBE is an integer count of base units
 * (bigint), never a float. Values crossing JSON are decimal strings.
 * All arithmetic is checked against the on-chain u64 range.
 */

export const U64_MAX = (1n << 64n) - 1n;
export const BPS_DENOMINATOR = 10_000n;
export const RATE_SCALE = 1_000_000_000n; // limit rates are output-per-input scaled by 1e9

export class MoneyError extends Error {
  constructor(
    public readonly code:
      | "OVERFLOW"
      | "UNDERFLOW"
      | "NEGATIVE"
      | "INVALID_AMOUNT"
      | "TOO_MANY_DECIMALS"
      | "DIVIDE_BY_ZERO"
      | "INVALID_BPS",
    message: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertU64(value: bigint, label = "amount"): bigint {
  if (value < 0n) throw new MoneyError("NEGATIVE", `${label} is negative`);
  if (value > U64_MAX) throw new MoneyError("OVERFLOW", `${label} exceeds u64`);
  return value;
}

export function addU64(a: bigint, b: bigint): bigint {
  return assertU64(assertU64(a) + assertU64(b), "sum");
}

export function subU64(a: bigint, b: bigint): bigint {
  assertU64(a);
  assertU64(b);
  if (b > a) throw new MoneyError("UNDERFLOW", `cannot subtract ${b} from ${a}`);
  return a - b;
}

/** floor(a * b / c) with a 128-bit-safe intermediate (bigint is unbounded, result is u64-checked). */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new MoneyError("DIVIDE_BY_ZERO", "division by zero");
  assertU64(a);
  assertU64(b);
  return assertU64((a * b) / c, "mulDiv result");
}

export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new MoneyError("DIVIDE_BY_ZERO", "division by zero");
  assertU64(a);
  assertU64(b);
  const p = a * b;
  return assertU64((p + c - 1n) / c, "mulDiv result");
}

export function assertBps(bps: number, label = "bps"): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError("INVALID_BPS", `${label} must be an integer between 0 and 10000`);
  }
  return bps;
}

/** floor(amount * bps / 10000) — fees and percentages always round down (in the user's favour for fees). */
export function bpsOf(amount: bigint, bps: number): bigint {
  assertBps(bps);
  return mulDivFloor(amount, BigInt(bps), BPS_DENOMINATOR);
}

const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a human decimal string into base units. Rejects anything ambiguous:
 * signs, exponents, separators other than ".", and more fractional digits than
 * the asset supports (no silent rounding of user input).
 */
export function parseAmount(input: string, decimals: number): bigint {
  const s = input.trim().replace(/_/g, "");
  if (s.length === 0) throw new MoneyError("INVALID_AMOUNT", "amount is empty");
  const normalized = s.startsWith(".") ? `0${s}` : s.endsWith(".") ? s.slice(0, -1) : s;
  const m = AMOUNT_RE.exec(normalized);
  if (!m) throw new MoneyError("INVALID_AMOUNT", `"${input}" is not a valid amount`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw new MoneyError("TOO_MANY_DECIMALS", `at most ${decimals} decimal places are supported`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return assertU64(units);
}

export interface FormatOptions {
  /** minimum fractional digits to show (default 2, capped at decimals) */
  minFraction?: number;
  /** maximum fractional digits to show (default = decimals). Truncates toward zero — never rounds up a balance. */
  maxFraction?: number;
  grouping?: boolean;
  /** compact suffix for large values (display only) */
  compact?: boolean;
}

/** Format base units for display. Truncates (never rounds up) so a displayed balance is never more than what exists. */
export function formatAmount(units: bigint, decimals: number, opts: FormatOptions = {}): string {
  const negative = units < 0n;
  let v = negative ? -units : units;
  const maxF = Math.min(opts.maxFraction ?? decimals, decimals);
  const minF = Math.min(opts.minFraction ?? Math.min(2, decimals), maxF);
  const base = 10n ** BigInt(decimals);
  if (opts.compact) {
    const whole = v / base;
    const thresholds: Array<[bigint, string]> = [
      [1_000_000_000n, "B"],
      [1_000_000n, "M"],
      [10_000n, "K"],
    ];
    for (const [t, suffix] of thresholds) {
      if (whole >= t) {
        const divisor = t === 10_000n ? 1_000n : t;
        const scaled = (v * 10n) / (divisor * base); // one decimal, truncated
        const str = `${scaled / 10n}${scaled % 10n !== 0n ? `.${scaled % 10n}` : ""}${suffix}`;
        return negative ? `-${str}` : str;
      }
    }
  }
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxF);
  // trim trailing zeros down to minF
  while (frac.length > minF && frac.endsWith("0")) frac = frac.slice(0, -1);
  const wholeStr = opts.grouping === false ? whole.toString() : groupThousands(whole.toString());
  const out = frac.length > 0 ? `${wholeStr}.${frac}` : wholeStr;
  v = 0n;
  return negative ? `-${out}` : out;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** JSON-safe encoding for u64 amounts. */
export function toJsonAmount(units: bigint): string {
  return assertU64(units).toString();
}

const DIGITS_RE = /^(0|[1-9]\d*)$/;
export function fromJsonAmount(value: unknown, label = "amount"): bigint {
  if (typeof value === "bigint") return assertU64(value, label);
  if (typeof value !== "string" || !DIGITS_RE.test(value)) {
    throw new MoneyError("INVALID_AMOUNT", `${label} must be a base-unit decimal string`);
  }
  return assertU64(BigInt(value), label);
}

/** Replacer for JSON.stringify that encodes bigint as decimal strings. */
export function jsonBigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Maximum spendable amount for an input field: balance minus any fee reserve
 * (e.g. lamports kept for rent/fees when the asset is SOL), never negative.
 */
export function maxSpendable(balance: bigint, feeReserve = 0n): bigint {
  return balance > feeReserve ? balance - feeReserve : 0n;
}

/** Amount for a percentage chip (25/50/75/100) — floor, decimal-aware, and capped by maxSpendable. */
export function percentOf(balance: bigint, percent: number, feeReserve = 0n): bigint {
  const max = maxSpendable(balance, feeReserve);
  if (percent >= 100) return max;
  return mulDivFloor(max, BigInt(Math.round(percent * 100)), 10_000n);
}

/** Estimated value in quote units (e.g. USD micro-units) — display only, clearly an estimate. */
export function estimateValue(units: bigint, decimals: number, priceE6: bigint): bigint {
  // priceE6: quote micro-units per 1 whole token
  return (units * priceE6) / 10n ** BigInt(decimals);
}
