import { z } from "zod";

/**
 * Server configuration. Environment labels are explicit and persistent, and
 * the dangerous combinations are refused at startup rather than documented.
 */
const zConfig = z.object({
  MAYBE_MODE: z.enum(["localnet", "devnet", "production"]).default("localnet"),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().default("postgres://maybe:maybe-local-dev@127.0.0.1:5432/maybe"),
  RPC_URL: z.string().default("http://127.0.0.1:8899"),
  WEB_ORIGIN: z.string().default("http://127.0.0.1:5173"),
  AUTH_DOMAIN: z.string().default("127.0.0.1:5173"),
  LOCALNET_BOOK: z.string().optional(),
  KEEPER_KEYPAIR: z.string().optional(),
  DEV_ATTESTORS: z.string().optional(),
  ALLOW_DEV_ATTESTORS: z.enum(["true", "false"]).default("true"),
  ANTHROPIC_API_KEY: z.string().optional(),
  MAYBE_AGENT_MODEL: z.string().optional(),
  SESSION_HOURS: z.coerce.number().default(12),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(240),
  /** reverse proxies in front of the API that append to X-Forwarded-For; 0 = use the socket address */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
});

export type Config = z.infer<typeof zConfig>;

export class ConfigError extends Error {}

/** A local validator: loopback, or the host machine as seen from a local container. */
export function isLocalRpc(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h) || h === "host.docker.internal";
  } catch {
    return false;
  }
}

/** Host only: RPC URLs often carry API keys in the path or query, which must never be logged or shown. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host || "an invalid URL";
  } catch {
    return "an invalid URL";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = zConfig.parse(env);
  const problems: string[] = [];
  // localnet turns on test faucets, development attestors and server-held agent keys: only ever against a local validator
  if (c.MAYBE_MODE === "localnet" && !isLocalRpc(c.RPC_URL)) problems.push(`MAYBE_MODE=localnet needs a local RPC_URL (got ${rpcHost(c.RPC_URL)}); set MAYBE_MODE=devnet for a remote cluster`);
  if (c.MAYBE_MODE === "production") {
    if (c.ALLOW_DEV_ATTESTORS === "true") problems.push("ALLOW_DEV_ATTESTORS must be false in production");
    if (c.DEV_ATTESTORS) problems.push("DEV_ATTESTORS must not be set in production (development mock signers are never allowed)");
    if (c.LOCALNET_BOOK) problems.push("LOCALNET_BOOK is a local fixture and must not be used in production");
    if (isLocalRpc(c.RPC_URL)) problems.push("production RPC_URL points at a local validator");
    if (c.DATABASE_URL.includes("maybe-local-dev")) problems.push("production DATABASE_URL uses the local development password");
  }
  if (/mainnet/.test(c.RPC_URL) && (c.DEV_ATTESTORS || c.LOCALNET_BOOK)) {
    problems.push("refusing to route mainnet funds through local settlement fixtures");
  }
  if (problems.length) throw new ConfigError(`Unsafe configuration:\n - ${problems.join("\n - ")}`);
  return c;
}
