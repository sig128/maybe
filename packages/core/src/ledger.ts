import { addU64, subU64 } from "./money.ts";

/**
 * Vault ledger — the accounting model the vault program enforces per mint:
 *
 *   token_account_balance(mint) == available(mint) + reserved(mint)
 *   reserved(mint)              == Σ_active strategies Σ_allocations holdings[alloc][mint]
 *
 * `available` is uncommitted and the only withdrawable amount. `reserved` is
 * committed to authorized strategies (including assets those strategies bought).
 * Nothing is ever counted in both, so balances never double count.
 */

export interface MintBalance {
  available: bigint;
  reserved: bigint;
}

export interface VaultState {
  address: string;
  owner: string;
  /** ledger per mint (address -> balance) */
  balances: Record<string, MintBalance>;
  /** actual token-account balances (chain truth in local-validator mode; mirrored in simulation) */
  tokens: Record<string, bigint>;
  /** incremented by the kill switch; agent policies from older epochs are void */
  policyEpoch: number;
  strategyCount: number;
}

export type LedgerErrorCode = "INSUFFICIENT_AVAILABLE" | "UNKNOWN_MINT" | "ZERO_AMOUNT" | "RESERVED_UNDERFLOW" | "INVARIANT";

export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export function emptyVault(address: string, owner: string): VaultState {
  return { address, owner, balances: {}, tokens: {}, policyEpoch: 0, strategyCount: 0 };
}

export function cloneVault(v: VaultState): VaultState {
  const balances: Record<string, MintBalance> = {};
  for (const [m, b] of Object.entries(v.balances)) balances[m] = { available: b.available, reserved: b.reserved };
  return { ...v, balances, tokens: { ...v.tokens } };
}

function bal(v: VaultState, mint: string): MintBalance {
  let b = v.balances[mint];
  if (!b) {
    b = { available: 0n, reserved: 0n };
    v.balances[mint] = b;
  }
  return b;
}

export function deposit(v0: VaultState, mint: string, amount: bigint): VaultState {
  if (amount <= 0n) throw new LedgerError("ZERO_AMOUNT", "deposit must be positive");
  const v = cloneVault(v0);
  const b = bal(v, mint);
  b.available = addU64(b.available, amount);
  v.tokens[mint] = addU64(v.tokens[mint] ?? 0n, amount);
  return v;
}

/** Withdraw only ever touches `available`. Reserved funds are never withdrawable. */
export function withdraw(v0: VaultState, mint: string, amount: bigint): VaultState {
  if (amount <= 0n) throw new LedgerError("ZERO_AMOUNT", "withdrawal must be positive");
  const v = cloneVault(v0);
  const b = v.balances[mint];
  if (!b) throw new LedgerError("UNKNOWN_MINT", "no balance for mint");
  if (b.available < amount) throw new LedgerError("INSUFFICIENT_AVAILABLE", `only ${b.available} available`);
  b.available -= amount;
  v.tokens[mint] = subU64(v.tokens[mint] ?? 0n, amount);
  return v;
}

/** available -> reserved (strategy activation) */
export function reserve(v0: VaultState, perMint: Record<string, bigint>): VaultState {
  const v = cloneVault(v0);
  for (const [mint, amount] of Object.entries(perMint)) {
    const b = bal(v, mint);
    if (b.available < amount) throw new LedgerError("INSUFFICIENT_AVAILABLE", `need ${amount}, available ${b.available}`);
  }
  for (const [mint, amount] of Object.entries(perMint)) {
    const b = bal(v, mint);
    b.available -= amount;
    b.reserved = addU64(b.reserved, amount);
  }
  return v;
}

/** reserved -> available (release action, cancellation, expiry refund) */
export function release(v0: VaultState, perMint: Record<string, bigint>): VaultState {
  const v = cloneVault(v0);
  for (const [mint, amount] of Object.entries(perMint)) {
    if (amount === 0n) continue;
    const b = bal(v, mint);
    if (b.reserved < amount) throw new LedgerError("RESERVED_UNDERFLOW", `release ${amount} exceeds reserved ${b.reserved}`);
    b.reserved -= amount;
    b.available = addU64(b.available, amount);
  }
  return v;
}

/** Funds leaving the vault from reserved (swap input, fee, transfer to recipient). */
export function spendReserved(v: VaultState, mint: string, amount: bigint): void {
  if (amount === 0n) return;
  const b = bal(v, mint);
  if (b.reserved < amount) throw new LedgerError("RESERVED_UNDERFLOW", `spend ${amount} exceeds reserved ${b.reserved}`);
  b.reserved -= amount;
  v.tokens[mint] = subU64(v.tokens[mint] ?? 0n, amount);
}

/** Funds entering reserved from a route (swap output credited to a strategy allocation). */
export function receiveReserved(v: VaultState, mint: string, amount: bigint): void {
  if (amount === 0n) return;
  const b = bal(v, mint);
  b.reserved = addU64(b.reserved, amount);
  v.tokens[mint] = addU64(v.tokens[mint] ?? 0n, amount);
}

export interface InvariantViolation {
  mint: string;
  message: string;
}

/**
 * Check conservation for one vault. `holdingsByMint` is Σ holdings over the
 * vault's active strategies (pass undefined to skip the reservation check).
 */
export function checkVaultInvariants(v: VaultState, holdingsByMint?: Record<string, bigint>): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const mints = new Set([...Object.keys(v.balances), ...Object.keys(v.tokens), ...Object.keys(holdingsByMint ?? {})]);
  for (const mint of mints) {
    const b = v.balances[mint] ?? { available: 0n, reserved: 0n };
    const tok = v.tokens[mint] ?? 0n;
    if (b.available < 0n || b.reserved < 0n) out.push({ mint, message: "negative balance" });
    if (tok !== b.available + b.reserved) {
      out.push({ mint, message: `token balance ${tok} != available ${b.available} + reserved ${b.reserved}` });
    }
    if (holdingsByMint && (holdingsByMint[mint] ?? 0n) !== b.reserved) {
      out.push({ mint, message: `reserved ${b.reserved} != strategy holdings ${holdingsByMint[mint] ?? 0n}` });
    }
  }
  return out;
}
