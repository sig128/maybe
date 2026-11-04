import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { simAddressBook, type AddressBook } from "@maybe/core";

/**
 * Localnet address book written by scripts/localnet-setup.ts. Keys mirror the
 * core fixture keys, so `buildFixtures(now, toCoreAddressBook(book), "localnet")`
 * yields templates that reference real local accounts.
 */

export interface LocalnetAsset {
  mint: string;
  tokenProgram: string;
  decimals: number;
  treasury: string;
  listed: boolean;
}
export interface LocalnetEvent {
  address: string;
  adapter: number;
  venueMarketId: string;
  marketIdHash: string;
  ruleHash: string;
  binding: string;
  deadline: number;
}
export interface LocalnetPool {
  address: string;
  poolId: string;
  mode: number;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
}
export interface LocalnetBook {
  cluster: "localnet";
  rpc: string;
  createdAt: number;
  programIds: { vault: string; venue: string };
  admin: string;
  keeper: string;
  treasuryOwner: string;
  config: string;
  attestorSet: { address: string; setId: string; keys: string[]; threshold: number; challengeSeconds: number };
  assets: Record<string, LocalnetAsset>;
  events: Record<string, LocalnetEvent>;
  pools: Record<string, LocalnetPool>;
  maliciousPools: Record<string, LocalnetPool>;
  outcomeMarkets: Record<string, { address: string; collateralMint: string; yesMint: string; vault: string; event: string }>;
  watched: Record<string, { address: string; mint: string; owner: string }>;
}

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function defaultBookPath(): string {
  return process.env.MAYBE_LOCALNET_BOOK ?? join(repoRoot(), ".localnet", "localnet.json");
}

export function loadLocalnetBook(path = defaultBookPath()): LocalnetBook | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as LocalnetBook;
}

/** Load a localnet-only keypair from programs/keys/localnet. Refuses anything else. */
export function localnetKeypair(name: string): Keypair {
  const p = join(repoRoot(), "programs", "keys", "localnet", `${name}.json`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
}

export function toCoreAddressBook(book: LocalnetBook): AddressBook {
  const need = (rec: Record<string, { address?: string; mint?: string }>, k: string, what: string) => {
    const v = rec[k];
    const a = v?.address ?? v?.mint;
    if (!a) throw new Error(`localnet book has no ${what} ${k}`);
    return a;
  };
  return {
    asset: (k) => need(book.assets, k, "asset"),
    // non-binary fixture markets are display-only and not created on-chain; they keep placeholder addresses
    event: (k) => book.events[k]?.address ?? simAddressBook.event(k),
    pool: (k) => need(book.pools, k, "pool"),
    outcomeMarket: (k) => need(book.outcomeMarkets, k, "outcome market"),
    watched: (k) => need(book.watched, k, "watched account"),
  };
}
