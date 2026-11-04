import { useSyncExternalStore } from "react";
import { liveEngine, type Market, type Stage } from "./engine.ts";

const engine = () => liveEngine();

export function useLiveToken(mint: string) {
  const e = engine();
  return useSyncExternalStore(e.subscribe, () => e.getToken(mint));
}

export function useColumn(stage: Stage) {
  const e = engine();
  return useSyncExternalStore(e.subscribe, () => e.getColumn(stage));
}

export function useLiveStatus() {
  const e = engine();
  return useSyncExternalStore(e.subscribe, e.getStatus);
}

export function usePractice() {
  const e = engine();
  return useSyncExternalStore(e.subscribe, e.getPractice);
}

export function useHeadline(mint: string): Market | undefined {
  const e = engine();
  return useSyncExternalStore(e.subscribe, () => e.headline(mint));
}

export function useMarket(id: string | undefined): Market | undefined {
  const e = engine();
  return useSyncExternalStore(e.subscribe, () => (id ? e.getMarket(id) : undefined));
}

/** The questions for one token, as a stable key so the list only re-renders when one changes. */
export function useMarketIds(mint: string): string {
  const e = engine();
  return useSyncExternalStore(e.subscribe, () => e.marketsFor(mint).map((m) => `${m.id}`).join("|"));
}

export function useHistoryVersion(mint: string): number {
  const e = engine();
  return useSyncExternalStore(e.subscribe, () => e.historyVersion(mint));
}

// one shared clock for ages and countdowns
let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function subscribeClock(f: () => void) {
  clockListeners.add(f);
  clockTimer ??= setInterval(() => {
    clockNow = Date.now();
    for (const l of clockListeners) l();
  }, 1000);
  return () => {
    clockListeners.delete(f);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}
export function useClock(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow);
}
