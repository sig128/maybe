import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { AssetInfo } from "@maybe/core";
import { useBackend } from "./BackendContext.tsx";

export function useEnvironment() {
  const b = useBackend();
  return useQuery({ queryKey: ["environment"], queryFn: () => b.environment(), staleTime: Infinity });
}

export function useAssets() {
  const b = useBackend();
  return useQuery({ queryKey: ["assets"], queryFn: () => b.assets() });
}

export function useAssetMap(): Map<string, AssetInfo> {
  const { data } = useAssets();
  return useMemo(() => new Map((data ?? []).map((a) => [a.mint, a])), [data]);
}

export function useWallet() {
  const b = useBackend();
  return useQuery({ queryKey: ["wallet"], queryFn: () => b.wallet() });
}

export function usePortfolio() {
  const b = useBackend();
  return useQuery({ queryKey: ["portfolio"], queryFn: () => b.portfolio() });
}

export function useMarkets() {
  const b = useBackend();
  return useQuery({ queryKey: ["markets"], queryFn: () => b.markets() });
}

export function useMarket(key: string | undefined) {
  const b = useBackend();
  return useQuery({ queryKey: ["markets", key], queryFn: () => b.market(key!), enabled: !!key });
}

export function useStrategies() {
  const b = useBackend();
  return useQuery({ queryKey: ["strategies"], queryFn: () => b.strategies() });
}

export function useStrategy(id: string | undefined) {
  const b = useBackend();
  return useQuery({ queryKey: ["strategies", id], queryFn: () => b.strategy(id!), enabled: !!id });
}

export function useActivity() {
  const b = useBackend();
  return useQuery({ queryKey: ["activity"], queryFn: () => b.activity() });
}

export function useAgentSessions() {
  const b = useBackend();
  return useQuery({ queryKey: ["agents", "sessions"], queryFn: () => b.agentSessions() });
}

export function usePolicies() {
  const b = useBackend();
  return useQuery({ queryKey: ["agents", "policies"], queryFn: () => b.policies() });
}

export function useRooms() {
  const b = useBackend();
  return useQuery({ queryKey: ["rooms"], queryFn: () => b.rooms() });
}

export function useRoom(slug: string | undefined) {
  const b = useBackend();
  return useQuery({ queryKey: ["rooms", slug], queryFn: () => b.room(slug!), enabled: !!slug });
}

export function useOps() {
  const b = useBackend();
  return useQuery({ queryKey: ["ops"], queryFn: () => b.ops() });
}

/** The backend's clock (simulated time in simulation mode), re-rendering every `ms`. */
export function useNow(ms = 1000): number {
  const b = useBackend();
  const [now, setNow] = useState(() => b.now());
  useEffect(() => {
    const t = setInterval(() => setNow(b.now()), ms);
    const unsub = b.subscribe((e) => {
      if (e.topics.includes("clock")) setNow(b.now());
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [b, ms]);
  return now;
}

/** The environment's fixture set (static per session). */
export function useFixturesOnce() {
  const b = useBackend();
  const { data } = useQuery({ queryKey: ["fixtures"], queryFn: () => b.fixtures(), staleTime: Infinity });
  return data;
}
