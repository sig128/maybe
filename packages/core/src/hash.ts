import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import bs58 from "bs58";

export { bytesToHex, hexToBytes, utf8ToBytes };

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === "string" ? utf8ToBytes(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256Bytes(data));
}

export function base58Encode(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

export function base58Decode(s: string): Uint8Array {
  return bs58.decode(s);
}

const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True if `s` is a base58 string that decodes to exactly 32 bytes (a Solana address). */
export function isAddress(s: string): boolean {
  if (!B58_RE.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function addressToBytes(s: string): Uint8Array {
  const b = bs58.decode(s);
  if (b.length !== 32) throw new Error(`invalid address ${s}`);
  return b;
}

/**
 * Deterministic placeholder address for simulation fixtures. These are hashes,
 * not keypairs: no one holds a key for them, and the simulation backend never
 * treats them as real chain accounts.
 */
export function simAddress(label: string): string {
  return bs58.encode(sha256(utf8ToBytes(`maybe:sim:${label}`)));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
