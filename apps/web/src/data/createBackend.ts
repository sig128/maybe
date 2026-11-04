import type { Backend } from "./types.ts";
import { SimulationBackend } from "./sim/simBackend.ts";
import { HttpBackend } from "./http/httpBackend.ts";

/**
 * Environment selection is explicit and persistent:
 *  - VITE_MAYBE_API (or ?api=… once) → the API server for a local validator / devnet
 *  - otherwise → in-browser simulation
 * The chosen mode is shown at all times in the top bar.
 */
export function createBackend(): Backend {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  let api: string | null = params.get("api");
  try {
    if (api) localStorage.setItem("maybe.api", api);
    if (params.get("api") === "off") {
      localStorage.removeItem("maybe.api");
      api = null;
    } else api ??= localStorage.getItem("maybe.api");
  } catch {
    /* storage unavailable */
  }
  api ??= (import.meta.env.VITE_MAYBE_API as string | undefined) ?? null;
  if (api && api !== "off") return new HttpBackend(api);
  return new SimulationBackend();
}
