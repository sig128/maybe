import { parse, stringify } from "@maybe/api";

/** Wire format lives in @maybe/api; this adds storage helpers for the simulation. */
export { parse, stringify };

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
