import { ActionKind, AmountKind, type Plan } from "./plan.ts";
import { reservationByMint } from "./engine.ts";
import type { VaultState } from "./ledger.ts";

/**
 * Agent capability policies — bounded, revocable authority for an agent
 * session key. The vault program enforces the same checks (policy.rs) when a
 * session key, rather than the owner, creates and funds a strategy. The agent
 * runtime holds only the session key; never the owner's wallet key.
 */

export interface CapabilityPolicy {
  address: string;
  vault: string;
  owner: string;
  sessionKey: string;
  label: string;
  /** must equal the vault's policy epoch; the kill switch bumps the epoch */
  epoch: number;
  canCreate: boolean;
  canCancel: boolean;
  allowedMints: string[];
  /** pool / market accounts the agent may route through */
  allowedRoutes: string[];
  allowedRecipients: string[];
  /** cumulative reservation cap per mint */
  maxTotal: Record<string, bigint>;
  /** cap on any single step's spend per mint */
  maxPerAction: Record<string, bigint>;
  maxFeeBps: number;
  expiresAt: number;
  spent: Record<string, bigint>;
  revoked: boolean;
}

export interface PolicyCheck {
  ok: boolean;
  violations: string[];
}

function stepMax(plan: Plan, i: number): bigint | null {
  const a = plan.actions[i]!;
  const runs = BigInt(a.runs);
  switch (a.amountKind) {
    case AmountKind.FIXED:
      return a.amount * runs;
    case AmountKind.BPS_OF_ALLOCATION:
      return ((plan.allocations[a.alloc]!.amount * BigInt(a.bps)) / 10_000n) * runs;
    case AmountKind.BPS_OF_RECEIVED:
    case AmountKind.ALL_OF_HOLDING:
      // proceeds-based amounts are unbounded by the reservation unless capped
      if (a.amount > 0n) return a.amount * runs;
      return plan.allocations[a.alloc]!.mint === a.inMint ? plan.allocations[a.alloc]!.amount : null;
  }
}

export function checkPolicyForPlan(policy: CapabilityPolicy, plan: Plan, vault: Pick<VaultState, "policyEpoch">, now: number): PolicyCheck {
  const v: string[] = [];
  if (policy.revoked) v.push("policy has been revoked");
  if (policy.epoch !== vault.policyEpoch) v.push("policy predates the latest kill switch");
  if (now >= policy.expiresAt) v.push("policy has expired");
  if (!policy.canCreate) v.push("policy does not allow creating futures");
  if (plan.expiresAt > policy.expiresAt) v.push("future would outlive the policy");
  if (plan.maxFeeBps > policy.maxFeeBps) v.push(`fee cap ${plan.maxFeeBps} bps exceeds policy ${policy.maxFeeBps} bps`);
  for (const m of plan.mints) if (!policy.allowedMints.includes(m)) v.push(`asset ${m} is not allowed`);
  plan.actions.forEach((a, i) => {
    if (a.kind === ActionKind.SWAP && !policy.allowedRoutes.includes(plan.refs[a.ref]!)) v.push(`step ${i + 1} uses a route outside the policy`);
    if (a.kind === ActionKind.TRANSFER && !policy.allowedRecipients.includes(plan.refs[a.ref]!)) v.push(`step ${i + 1} pays a recipient outside the policy`);
    const mint = plan.mints[a.inMint]!;
    const max = stepMax(plan, i);
    const cap = policy.maxPerAction[mint];
    if (max === null) v.push(`step ${i + 1} spends an uncapped amount of proceeds`);
    else if (cap === undefined || max > cap) v.push(`step ${i + 1} can spend ${max} > per-step cap ${cap ?? 0n}`);
  });
  for (const [mint, amount] of Object.entries(reservationByMint(plan))) {
    const cap = policy.maxTotal[mint] ?? 0n;
    const used = policy.spent[mint] ?? 0n;
    if (used + amount > cap) v.push(`reserving ${amount} would exceed the total cap (${used} of ${cap} used)`);
  }
  return { ok: v.length === 0, violations: v };
}

/** Record a successful agent-created reservation against the policy. */
export function chargePolicy(policy: CapabilityPolicy, plan: Plan): CapabilityPolicy {
  const spent = { ...policy.spent };
  for (const [mint, amount] of Object.entries(reservationByMint(plan))) spent[mint] = (spent[mint] ?? 0n) + amount;
  return { ...policy, spent };
}

/** Kill switch: every policy for the vault becomes void at once. Withdrawals are unaffected. */
export function killSwitch<V extends Pick<VaultState, "policyEpoch">>(vault: V): V {
  return { ...vault, policyEpoch: vault.policyEpoch + 1 };
}
