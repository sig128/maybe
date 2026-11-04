import { PublicKey } from "@solana/web3.js";
import { Reader, accountDisc, hasDisc, optTime } from "./codec.ts";

/**
 * Account decoders. Zero-copy accounts (Config, Vault, Strategy, Policy) are
 * read at fixed offsets pinned by programs/programs/maybe-vault/src/state.rs
 * (layout_tests); Borsh accounts are read field by field.
 */

export class DecodeError extends Error {}

function body(data: Uint8Array, name: string): Uint8Array {
  if (!hasDisc(data, accountDisc(name))) throw new DecodeError(`not a ${name} account`);
  return data.subarray(8);
}

export interface AssetEntry {
  mint: PublicKey;
  tokenProgram: PublicKey;
  treasury: PublicKey;
  decimals: number;
  enabled: boolean;
}
export interface RouteEntry {
  programId: PublicKey;
  kind: number;
  enabled: boolean;
}
export interface ConfigAccount {
  admin: PublicKey;
  treasuryOwner: PublicKey;
  maxFeeBpsCap: number;
  allowDevAttestors: boolean;
  pausedExecution: boolean;
  assets: AssetEntry[];
  routes: RouteEntry[];
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  const b = body(data, "Config");
  const rd = new Reader(b);
  const admin = rd.pubkey();
  const treasuryOwner = rd.pubkey();
  const maxFeeBpsCap = rd.u16();
  const allowDevAttestors = rd.bool();
  const pausedExecution = rd.bool();
  const nAssets = rd.u8();
  const nRoutes = rd.u8();
  const assets: AssetEntry[] = [];
  for (let i = 0; i < nAssets; i++) {
    const a = rd.at(72 + i * 104);
    assets.push({ mint: a.pubkey(), tokenProgram: a.pubkey(), treasury: a.pubkey(), decimals: a.u8(), enabled: a.bool() });
  }
  const routes: RouteEntry[] = [];
  for (let i = 0; i < nRoutes; i++) {
    const a = rd.at(1736 + i * 40);
    routes.push({ programId: a.pubkey(), kind: a.u8(), enabled: a.bool() });
  }
  return { admin, treasuryOwner, maxFeeBpsCap, allowDevAttestors, pausedExecution, assets, routes };
}

export interface MintBalanceEntry {
  mint: PublicKey;
  tokenAccount: PublicKey;
  available: bigint;
  reserved: bigint;
}
export interface VaultAccount {
  owner: PublicKey;
  vaultId: bigint;
  strategyCount: bigint;
  policyEpoch: number;
  bump: number;
  balances: MintBalanceEntry[];
}

export function decodeVault(data: Uint8Array): VaultAccount {
  const b = body(data, "Vault");
  const rd = new Reader(b);
  const owner = rd.pubkey();
  const vaultId = rd.u64();
  const strategyCount = rd.u64();
  const policyEpoch = rd.u32();
  const n = rd.u8();
  const bump = rd.u8();
  const balances: MintBalanceEntry[] = [];
  for (let i = 0; i < n; i++) {
    const a = rd.at(56 + i * 80);
    balances.push({ mint: a.pubkey(), tokenAccount: a.pubkey(), available: a.u64(), reserved: a.u64() });
  }
  return { owner, vaultId, strategyCount, policyEpoch, bump, balances };
}

export interface ActionStateAccount {
  firstExecutedAt: number | null;
  lastExecutedAt: number | null;
  received: bigint;
  spent: bigint;
  fees: bigint;
  runsDone: number;
  executedRuns: number;
}
export interface StrategyAccount {
  vault: PublicKey;
  owner: PublicKey;
  creator: PublicKey;
  policy: PublicKey;
  planHash: Uint8Array;
  strategyId: bigint;
  createdAt: number;
  activatedAt: number;
  closedAt: number | null;
  execNonce: bigint;
  version: number;
  planLen: number;
  written: number;
  status: number;
  groupClaims: number[];
  holdings: bigint[][];
  actions: ActionStateAccount[];
  plan: Uint8Array;
}

export const STRATEGY_STATUS = ["UPLOADING", "ACTIVE", "PAUSED", "COMPLETED", "EXPIRED", "CANCELLED"] as const;

export function decodeStrategy(data: Uint8Array): StrategyAccount {
  const b = body(data, "Strategy");
  const rd = new Reader(b);
  const vault = rd.pubkey();
  const owner = rd.pubkey();
  const creator = rd.pubkey();
  const policy = rd.pubkey();
  const planHash = rd.fixed(32);
  const strategyId = rd.u64();
  const createdAt = Number(rd.i64());
  const activatedAt = Number(rd.i64());
  const closedAt = optTime(rd.i64());
  const execNonce = rd.u64();
  const version = rd.u32();
  const planLen = rd.u16();
  const written = rd.u16();
  const status = rd.u8();
  rd.u8(); // bump
  const groupClaims = [...rd.fixed(8)];
  const holdings: bigint[][] = [];
  const h = rd.at(224);
  for (let a = 0; a < 4; a++) {
    const row: bigint[] = [];
    for (let m = 0; m < 6; m++) row.push(h.u64());
    holdings.push(row);
  }
  const actions: ActionStateAccount[] = [];
  for (let i = 0; i < 12; i++) {
    const a = rd.at(416 + i * 48);
    actions.push({
      firstExecutedAt: optTime(a.i64()),
      lastExecutedAt: optTime(a.i64()),
      received: a.u64(),
      spent: a.u64(),
      fees: a.u64(),
      runsDone: a.u16(),
      executedRuns: a.u16(),
    });
  }
  const plan = b.slice(992, 992 + planLen);
  return { vault, owner, creator, policy, planHash, strategyId, createdAt, activatedAt, closedAt, execNonce, version, planLen, written, status, groupClaims, holdings, actions, plan };
}

export interface PolicyAccount {
  vault: PublicKey;
  owner: PublicKey;
  sessionKey: PublicKey;
  allowedMints: PublicKey[];
  allowedRoutes: PublicKey[];
  allowedRecipients: PublicKey[];
  maxTotal: bigint[];
  maxPerAction: bigint[];
  spent: bigint[];
  expiresAt: number;
  epoch: number;
  maxFeeBps: number;
  canCreate: boolean;
  canCancel: boolean;
  revoked: boolean;
}

export function decodePolicy(data: Uint8Array): PolicyAccount {
  const b = body(data, "Policy");
  const rd = new Reader(b);
  const vault = rd.pubkey();
  const owner = rd.pubkey();
  const sessionKey = rd.pubkey();
  const tail = rd.at(766);
  const nMints = tail.u8();
  const nRoutes = tail.u8();
  const nRecipients = tail.u8();
  const canCreate = tail.bool();
  const canCancel = tail.bool();
  const revoked = tail.bool();
  const keys = (off: number, n: number) => Array.from({ length: n }, (_, i) => rd.at(off + i * 32).pubkey());
  const u64s = (off: number, n: number) => Array.from({ length: n }, (_, i) => rd.at(off + i * 8).u64());
  return {
    vault,
    owner,
    sessionKey,
    allowedMints: keys(96, nMints),
    allowedRoutes: keys(288, nRoutes),
    allowedRecipients: keys(480, nRecipients),
    maxTotal: u64s(608, nMints),
    maxPerAction: u64s(656, nMints),
    spent: u64s(704, nMints),
    expiresAt: Number(rd.at(752).i64()),
    epoch: rd.at(760).u32(),
    maxFeeBps: rd.at(764).u16(),
    canCreate,
    canCancel,
    revoked,
  };
}

export interface AttestorSetAccount {
  setId: bigint;
  keys: PublicKey[];
  threshold: number;
  adjudicationThreshold: number;
  revoked: number;
  isDev: boolean;
  challengeSeconds: number;
  disputeTimeoutSeconds: number;
}

export function decodeAttestorSet(data: Uint8Array): AttestorSetAccount {
  const rd = new Reader(body(data, "AttestorSet"));
  const setId = rd.u64();
  const all = Array.from({ length: 5 }, () => rd.pubkey());
  const n = rd.u8();
  return { setId, keys: all.slice(0, n), threshold: rd.u8(), adjudicationThreshold: rd.u8(), revoked: rd.u8(), isDev: rd.bool(), challengeSeconds: rd.u32(), disputeTimeoutSeconds: rd.u32() };
}

export interface OutcomeEventAccount {
  adapter: number;
  venue: number;
  marketIdHash: Uint8Array;
  ruleHash: Uint8Array;
  binding: PublicKey;
  status: number;
  outcome: number;
  proposedAt: number;
  finalAt: number;
  disputedAt: number;
  lastNonce: bigint;
  threshold: bigint;
  deadline: number;
  watchedMint: PublicKey;
}

export const EVENT_STATUS = ["OPEN", "PENDING", "DISPUTED", "FINAL"] as const;
export const OUTCOME_NAME = ["NO", "YES", "VOID"] as const;

export function decodeOutcomeEvent(data: Uint8Array): OutcomeEventAccount {
  const rd = new Reader(body(data, "OutcomeEvent"));
  return {
    adapter: rd.u8(),
    venue: rd.u8(),
    marketIdHash: rd.fixed(32),
    ruleHash: rd.fixed(32),
    binding: rd.pubkey(),
    status: rd.u8(),
    outcome: rd.u8(),
    proposedAt: Number(rd.i64()),
    finalAt: Number(rd.i64()),
    disputedAt: Number(rd.i64()),
    lastNonce: rd.u64(),
    threshold: rd.u64(),
    deadline: Number(rd.i64()),
    watchedMint: rd.pubkey(),
  };
}

export interface PoolAccount {
  poolId: bigint;
  admin: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
  decimalsA: number;
  decimalsB: number;
  feeBps: number;
  mode: number;
}

export function decodePool(data: Uint8Array): PoolAccount {
  const rd = new Reader(body(data, "Pool"));
  return {
    poolId: rd.u64(),
    admin: rd.pubkey(),
    mintA: rd.pubkey(),
    mintB: rd.pubkey(),
    vaultA: rd.pubkey(),
    vaultB: rd.pubkey(),
    tokenProgramA: rd.pubkey(),
    tokenProgramB: rd.pubkey(),
    decimalsA: rd.u8(),
    decimalsB: rd.u8(),
    feeBps: rd.u16(),
    mode: rd.u8(),
  };
}

export interface OutcomeMarketAccount {
  event: PublicKey;
  admin: PublicKey;
  collateralMint: PublicKey;
  yesMint: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
  collateralDecimals: number;
  yesPriceE6: bigint;
}

export function decodeOutcomeMarket(data: Uint8Array): OutcomeMarketAccount {
  const rd = new Reader(body(data, "OutcomeMarket"));
  return {
    event: rd.pubkey(),
    admin: rd.pubkey(),
    collateralMint: rd.pubkey(),
    yesMint: rd.pubkey(),
    vault: rd.pubkey(),
    tokenProgram: rd.pubkey(),
    collateralDecimals: rd.u8(),
    yesPriceE6: rd.u64(),
  };
}
