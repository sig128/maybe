/** JSON with lossless bigint and Uint8Array, for simulation persistence. */

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
    if (v && typeof v === "object") {
      if ("$b" in v && Object.keys(v).length === 1) return BigInt(v.$b);
      if ("$u8" in v && Object.keys(v).length === 1) return new Uint8Array(v.$u8);
      if ("$inf" in v && Object.keys(v).length === 1) return Number.POSITIVE_INFINITY;
    }
    return v;
  }) as T;
}

export function safeLoad<T>(key: string): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? parse<T>(raw) : null;
  } catch {
    return null;
  }
}

export function safeSave(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, stringify(value));
  } catch {
    /* storage unavailable or full: simulation continues in memory */
  }
}

export function safeRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}
