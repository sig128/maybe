export function usdCompact(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e5 ? 0 : a >= 1e4 ? 1 : 2)}K`;
  return `$${v.toFixed(a >= 100 ? 0 : 2)}`;
}

export function solAmount(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function count(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function pct(v: number | undefined | null, digits = 0): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

/** 0.342 → "34%"; keeps one decimal near the ends so 0.4% and 99.6% stay distinct. */
export function odds(p: number): string {
  const v = p * 100;
  if (v < 1 || v > 99) return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}

export function cents(price: number): string {
  return `${Math.round(price * 100)}¢`;
}

export function age(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function countdown(toMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((toMs - nowMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** A calm, stable hue for a token without an image. */
export function monoHue(mint: string): number {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) % 360;
  return h;
}

/** Only http(s) links leave the page; anything else is dropped. */
export function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u.startsWith("http") ? u : `https://${u}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** X links: a handle or a status URL becomes an x.com link. */
export function xUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(u)) return `https://x.com/${u.replace(/^@/, "")}`;
  return safeUrl(u);
}
