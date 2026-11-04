import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Backend } from "./types.ts";

const Ctx = createContext<Backend | null>(null);

const TOPIC_KEYS: Record<string, string[][]> = {
  wallet: [["wallet"], ["portfolio"]],
  portfolio: [["portfolio"], ["assets"]],
  markets: [["markets"]],
  quotes: [["markets"], ["assets"]],
  strategies: [["strategies"], ["portfolio"], ["markets"]],
  activity: [["activity"]],
  agents: [["agents"]],
  rooms: [["rooms"]],
  ops: [["ops"]],
  clock: [["ops"]],
};

export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  const qc = useQueryClient();
  useEffect(
    () =>
      backend.subscribe((e) => {
        const seen = new Set<string>();
        for (const t of e.topics)
          for (const key of TOPIC_KEYS[t] ?? []) {
            const k = key.join("/");
            if (seen.has(k)) continue;
            seen.add(k);
            void qc.invalidateQueries({ queryKey: key });
          }
      }),
    [backend, qc],
  );
  return <Ctx.Provider value={backend}>{children}</Ctx.Provider>;
}

export function useBackend(): Backend {
  const b = useContext(Ctx);
  if (!b) throw new Error("BackendProvider missing");
  return b;
}
