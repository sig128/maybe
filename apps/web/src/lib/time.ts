const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dateYearFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function fmtDate(unix: number, withYear = false): string {
  return (withYear ? dateYearFmt : dateFmt).format(new Date(unix * 1000));
}

export function fmtDateTime(unix: number): string {
  return dateTimeFmt.format(new Date(unix * 1000));
}

export function fmtClock(unix: number): string {
  return timeFmt.format(new Date(unix * 1000));
}

/** "in 3d", "5m ago", "now" — relative to the backend clock (simulated in simulation mode). */
export function relTime(unix: number, now: number): string {
  const d = unix - now;
  const a = Math.abs(d);
  if (a < 30) return "now";
  const unit = a < 3600 ? `${Math.round(a / 60)}m` : a < 86_400 ? `${Math.round(a / 3600)}h` : a < 86_400 * 60 ? `${Math.round(a / 86_400)}d` : `${Math.round(a / (86_400 * 30))}mo`;
  return d > 0 ? `in ${unit}` : `${unit} ago`;
}

export function quoteAge(asOf: number, now: number): { label: string; stale: boolean } {
  const s = Math.max(0, now - asOf);
  return { label: s < 2 ? "just now" : s < 60 ? `${Math.floor(s)}s ago` : `${Math.floor(s / 60)}m ago`, stale: s > 60 };
}
