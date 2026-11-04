import { PublicKey } from "@solana/web3.js";
import { bytesToHex, decodePlan, type EventView, type StrategyState, type StrategyStatus, type VaultState } from "@maybe/core";
import { EVENT_STATUS, OUTCOME_NAME, STRATEGY_STATUS, type OutcomeEventAccount, type StrategyAccount, type VaultAccount } from "./accounts.ts";
import { ADAPTER_BALANCE } from "./ids.ts";

/** Convert on-chain accounts into the shapes the shared engine evaluates. */

export function toEventView(e: OutcomeEventAccount): EventView {
  const status = EVENT_STATUS[e.status] ?? "OPEN";
  const has = status !== "OPEN";
  return {
    status,
    outcome: has ? (OUTCOME_NAME[e.outcome] ?? null) : null,
    finalAt: has ? e.finalAt : null,
    adapter: e.adapter === ADAPTER_BALANCE ? "BALANCE" : "ATTESTATION",
    ...(e.adapter === ADAPTER_BALANCE ? { deadline: e.deadline } : {}),
  };
}

/** Returns null while the plan is still being uploaded. */
export function toStrategyState(address: PublicKey, s: StrategyAccount): StrategyState | null {
  const status = STRATEGY_STATUS[s.status];
  if (!status || status === "UPLOADING") return null;
  const plan = decodePlan(s.plan);
  return {
    address: address.toBase58(),
    vault: s.vault.toBase58(),
    owner: s.owner.toBase58(),
    planHash: bytesToHex(s.planHash),
    plan,
    status: status as StrategyStatus,
    createdBy: s.policy.equals(PublicKey.default) ? { kind: "owner" } : { kind: "policy", policy: s.policy.toBase58() },
    activatedAt: s.activatedAt,
    closedAt: s.closedAt,
    holdings: s.holdings.slice(0, plan.allocations.length).map((row) => row.slice(0, plan.mints.length)),
    groupClaims: s.groupClaims,
    actions: s.actions.slice(0, plan.actions.length).map((a) => ({
      runsDone: a.runsDone,
      executedRuns: a.executedRuns,
      firstExecutedAt: a.firstExecutedAt,
      lastExecutedAt: a.lastExecutedAt,
      received: a.received,
      spent: a.spent,
      fees: a.fees,
    })),
    execNonce: Number(s.execNonce),
  };
}

/** Ledger view of a vault. `tokens` must come from the actual token accounts (pass them for reconciliation). */
export function toVaultState(address: PublicKey, v: VaultAccount, tokenBalances?: Record<string, bigint>): VaultState {
  const balances: VaultState["balances"] = {};
  const tokens: VaultState["tokens"] = {};
  for (const b of v.balances) {
    const m = b.mint.toBase58();
    balances[m] = { available: b.available, reserved: b.reserved };
    tokens[m] = tokenBalances?.[m] ?? b.available + b.reserved;
  }
  return { address: address.toBase58(), owner: v.owner.toBase58(), balances, tokens, policyEpoch: v.policyEpoch, strategyCount: Number(v.strategyCount) };
}
