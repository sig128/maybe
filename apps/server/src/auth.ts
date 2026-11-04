import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import bs58 from "bs58";
import type { Queryable } from "./jobs.ts";

/**
 * Sign-In-With-Solana style authentication. A challenge is single use, bound
 * to this server's domain and to one address, and expires. Sessions store
 * only a hash of the bearer token. Signing in never moves funds: every
 * fund-moving action still needs the wallet's signature on a transaction.
 */

const CHALLENGE_MINUTES = 10;

export class AuthError extends Error {
  readonly status = 401;
}

export function siwsMessage(o: { domain: string; address: string; uri: string; chainId: string; nonce: string; issuedAt: Date; expiresAt: Date; statement: string }): string {
  return [
    `${o.domain} wants you to sign in with your Solana account:`,
    o.address,
    "",
    o.statement,
    "",
    `URI: ${o.uri}`,
    "Version: 1",
    `Chain ID: ${o.chainId}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${o.issuedAt.toISOString()}`,
    `Expiration Time: ${o.expiresAt.toISOString()}`,
  ].join("\n");
}

export function isAddress(a: unknown): a is string {
  if (typeof a !== "string" || a.length < 32 || a.length > 44) return false;
  try {
    return bs58.decode(a).length === 32;
  } catch {
    return false;
  }
}

export async function createChallenge(q: Queryable, o: { address: string; domain: string; uri: string; chainId: string; mode: string }): Promise<{ message: string; nonce: string; expiresAt: number }> {
  if (!isAddress(o.address)) throw new AuthError("Not a Solana address.");
  const nonce = bs58.encode(randomBytes(16));
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_MINUTES * 60_000);
  const message = siwsMessage({ ...o, nonce, issuedAt, expiresAt, statement: `Sign in to MAYBE (${o.mode}). Signing in doesn't move funds or cost anything.` });
  await q.query(`INSERT INTO auth_challenges (nonce, address, domain, message, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`, [nonce, o.address, o.domain, message, issuedAt, expiresAt]);
  await q.query(`DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'`);
  return { message, nonce, expiresAt: Math.floor(expiresAt.getTime() / 1000) };
}

export function verifySignature(message: string, signatureB58: string, address: string): boolean {
  try {
    const sig = bs58.decode(signatureB58);
    const pub = bs58.decode(address);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return ed25519.verify(sig, new TextEncoder().encode(message), pub);
  } catch {
    return false;
  }
}

export const tokenHash = (token: string) => bytesToHex(sha256(new TextEncoder().encode(token)));

export async function verifyChallenge(
  q: Queryable,
  o: { address: string; message: string; signature: string; domain: string; sessionHours: number; userAgent?: string },
): Promise<{ session: string; expiresAt: number }> {
  if (!isAddress(o.address)) throw new AuthError("Not a Solana address.");
  const nonce = /\nNonce: ([1-9A-HJ-NP-Za-km-z]+)\n/.exec(o.message)?.[1];
  if (!nonce) throw new AuthError("Malformed sign-in message.");
  if (!o.message.startsWith(`${o.domain} wants you to sign in with your Solana account:\n${o.address}\n`)) throw new AuthError("This sign-in message was made for a different site or address.");
  if (!verifySignature(o.message, o.signature, o.address)) throw new AuthError("The signature doesn't match this address.");
  // consume atomically: exactly one verify can succeed per challenge
  const r = await q.query<{ message: string }>(
    `UPDATE auth_challenges SET used_at = now() WHERE nonce = $1 AND address = $2 AND domain = $3 AND used_at IS NULL AND expires_at > now() RETURNING message`,
    [nonce, o.address, o.domain],
  );
  if (!r.rowCount || r.rows[0]!.message !== o.message) throw new AuthError("This sign-in request has expired or was already used. Sign in again.");
  const session = Buffer.from(randomBytes(32)).toString("base64url");
  const expiresAt = new Date(Date.now() + o.sessionHours * 3600_000);
  await q.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT (address) DO UPDATE SET last_seen_at = now()`, [o.address]);
  await q.query(`INSERT INTO wallet_sessions (token_hash, address, expires_at, user_agent) VALUES ($1, $2, $3, $4)`, [tokenHash(session), o.address, expiresAt, o.userAgent?.slice(0, 200) ?? null]);
  return { session, expiresAt: Math.floor(expiresAt.getTime() / 1000) };
}

export async function sessionAddress(q: Queryable, bearer: string | undefined): Promise<string | null> {
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  if (!token || token.length > 200) return null;
  const r = await q.query<{ address: string }>(`SELECT address FROM wallet_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, [tokenHash(token)]);
  return r.rows[0]?.address ?? null;
}

export async function revokeSession(q: Queryable, bearer: string | undefined): Promise<void> {
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  if (token) await q.query(`UPDATE wallet_sessions SET revoked_at = now() WHERE token_hash = $1`, [tokenHash(token)]);
}

/**
 * Token bucket per key, stored in Postgres so limits hold across API processes. A refused request
 * doesn't dig the bucket deeper (the floor is -1), so hammering can't extend a lockout: the
 * bucket is usable again within a couple of refill intervals of the client slowing down.
 */
export async function rateLimit(q: Queryable, bucket: string, perMinute: number): Promise<boolean> {
  const r = await q.query<{ tokens: number }>(
    `INSERT INTO rate_limits (bucket, tokens, refreshed_at) VALUES ($1, $2 - 1, now())
     ON CONFLICT (bucket) DO UPDATE SET
       tokens = GREATEST(LEAST($2, rate_limits.tokens + EXTRACT(EPOCH FROM (now() - rate_limits.refreshed_at)) * $2 / 60.0) - 1, -1),
       refreshed_at = now()
     RETURNING tokens`,
    [bucket, perMinute],
  );
  return (r.rows[0]?.tokens ?? 0) >= 0;
}
