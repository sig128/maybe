import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bpsOf, formatAmount, fromJsonAmount, mulDivFloor, parseAmount, percentOf, subU64, toJsonAmount, U64_MAX, addU64, MoneyError } from "../src/index.ts";

describe("fixed-point money", () => {
  it("parses decimals exactly and rejects ambiguity", () => {
    expect(parseAmount("100", 6)).toBe(100_000_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("1.5", 9)).toBe(1_500_000_000n);
    expect(parseAmount(".25", 2)).toBe(25n);
    expect(() => parseAmount("1.0000001", 6)).toThrowError(MoneyError);
    expect(() => parseAmount("-1", 6)).toThrowError(MoneyError);
    expect(() => parseAmount("1e6", 6)).toThrowError(MoneyError);
    expect(() => parseAmount("1,000", 6)).toThrowError(MoneyError);
    expect(() => parseAmount("", 6)).toThrowError(MoneyError);
    expect(() => parseAmount("18446744073709.551616", 6)).toThrowError(MoneyError); // u64 max + 1
  });

  it("format → parse round-trips for every decimals setting", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), fc.integer({ min: 0, max: 12 }), (units, decimals) => {
        const s = formatAmount(units, decimals, { grouping: false, minFraction: 0 });
        expect(parseAmount(s, decimals)).toBe(units);
      }),
    );
  });

  it("formatting truncates and never rounds a balance up", () => {
    expect(formatAmount(1_999_999n, 6, { maxFraction: 2 })).toBe("1.99");
    expect(formatAmount(1_234_567_890_000n, 6)).toBe("1,234,567.89");
    expect(formatAmount(50_000_000_000n, 6, { compact: true })).toBe("50K");
  });

  it("checked arithmetic refuses overflow and underflow", () => {
    expect(() => addU64(U64_MAX, 1n)).toThrowError(MoneyError);
    expect(() => subU64(1n, 2n)).toThrowError(MoneyError);
    expect(mulDivFloor(U64_MAX, 10_000n, 10_000n)).toBe(U64_MAX);
  });

  it("bps and percentage chips floor and never exceed the balance", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), fc.integer({ min: 0, max: 10_000 }), (a, bps) => {
        const v = bpsOf(a, bps);
        expect(v <= a).toBe(true);
        expect(v * 10_000n <= a * BigInt(bps)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.constantFrom(25, 50, 75, 100), fc.bigInt({ min: 0n, max: 10n ** 7n }), (bal, pct, reserveForFees) => {
        const v = percentOf(bal, pct, reserveForFees);
        expect(v <= bal).toBe(true);
        expect(v + (bal > reserveForFees ? reserveForFees : bal) <= bal + reserveForFees).toBe(true);
      }),
    );
  });

  it("JSON encoding is lossless for u64", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), (v) => {
        expect(fromJsonAmount(toJsonAmount(v))).toBe(v);
      }),
    );
    expect(() => fromJsonAmount("01")).toThrowError();
    expect(() => fromJsonAmount(5)).toThrowError();
    expect(() => fromJsonAmount("18446744073709551616")).toThrowError();
  });
});
