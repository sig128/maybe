/** Wire JSON with lossless bigint / Uint8Array tagging (identical to the web client's format). */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return { $b: v.toString() };
    if (v instanceof Uint8Array) return { $u8: Array.from(v) };
    if (v === Number.POSITIVE_INFINITY) return { $inf: 1 };
    return v;
  });
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1) {
        if (keys[0] === "$b" && typeof v.$b === "string" && /^-?\d+$/.test(v.$b)) return BigInt(v.$b);
        if (keys[0] === "$u8" && Array.isArray(v.$u8)) return new Uint8Array(v.$u8);
        if (keys[0] === "$inf") return Number.POSITIVE_INFINITY;
      }
    }
    return v;
  }) as T;
}

/** Plain JSON for jsonb columns: bigints as decimal strings. */
export function toDbJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
