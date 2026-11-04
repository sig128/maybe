import { PLAN_FLAG_CANCEL_LOCKED, decodePlan, planHash, type Plan } from "./plan.ts";
import { describeAction, describeNode, fmtUnits, formatTime, short, type DescribeLookup, type Labels } from "./describe.ts";
import type { SimulationReport } from "./simulate.ts";

/**
 * The authorization a person signs, rendered from the exact plan bytes.
 * Every number here is derived from the decoded plan and the simulator run over
 * it; nothing comes from the editable draft.
 */

export interface AuthorizationLine {
  label: string;
  value: string;
}

export interface AuthorizationSummary {
  planHash: string;
  sizeBytes: number;
  headline: string;
  expiresAt: number;
  expiresText: string;
  reserved: AuthorizationLine[];
  worstCaseSpend: AuthorizationLine[];
  /** total volume that may be swapped or sent, including proceeds re-spent by later steps */
  grossVolume: AuthorizationLine[];
  maxFees: AuthorizationLine[];
  maxToRecipients: AuthorizationLine[];
  events: Array<{ label: string; title: string; key: string; venue: string; trust: string; ruleHash?: string }>;
  steps: Array<{ index: number; label?: string; when: string; does: string; limits: string[]; allocation: string }>;
  assets: string[];
  dependencies: string[];
  cancellation: string[];
  failure: string[];
  outcomes: string[];
  enforcement: string[];
  warnings: string[];
}

export function buildAuthorization(
  bytes: Uint8Array,
  lookup: DescribeLookup,
  report: SimulationReport,
  labels: Labels,
  opts: { now: number; environment: string },
): AuthorizationSummary {
  const plan: Plan = decodePlan(bytes);
  const hash = planHash(bytes);
  const asset = (m: string) => lookup.asset(m);
  const reserved = Object.entries(report.reservationByMint).map(([m, v]) => ({ label: asset(m)?.symbol ?? short(m), value: fmtUnits(v, asset(m)) }));
  const worst = Object.entries(report.worstCase.netSpendByMint).map(([m, v]) => ({ label: asset(m)?.symbol ?? short(m), value: fmtUnits(v, asset(m)) }));
  const gross = Object.entries(report.worstCase.spendByMint).map(([m, v]) => ({ label: asset(m)?.symbol ?? short(m), value: fmtUnits(v, asset(m)) }));
  const fees = Object.entries(report.worstCase.feesByMint).map(([m, v]) => ({ label: asset(m)?.symbol ?? short(m), value: fmtUnits(v, asset(m)) }));
  const toRecipients = Object.entries(report.worstCase.transfersByRecipient).flatMap(([r, by]) =>
    Object.entries(by).map(([m, v]) => ({ label: lookup.ref(r)?.label ?? short(r), value: fmtUnits(v, asset(m)) })),
  );
  const totalReserved = reserved.map((r) => r.value).join(" + ");
  const events = plan.events.map((key, i) => {
    const e = lookup.event(key);
    return { label: labels.events[i] ?? `E${i + 1}`, title: e?.title ?? "Unknown event", key, venue: e?.venue ?? "unknown", trust: e?.trust ?? "unknown", ...(e?.ruleHash ? { ruleHash: e.ruleHash } : {}) };
  });
  const steps = plan.actions.map((_, i) => {
    const d = describeAction(plan, i, lookup, labels);
    const al = plan.allocations[plan.actions[i]!.alloc]!;
    return {
      index: i,
      ...(labels.actions?.[i] ? { label: labels.actions[i] } : {}),
      when: describeNode(plan, plan.actions[i]!.guard, labels, lookup),
      does: d.title,
      limits: d.limits,
      allocation: `${labels.allocations?.[plan.actions[i]!.alloc] ?? `Allocation ${plan.actions[i]!.alloc + 1}`} · ${fmtUnits(al.amount, asset(plan.mints[al.mint]!))}`,
    };
  });
  const locked = (plan.flags & PLAN_FLAG_CANCEL_LOCKED) !== 0;
  const warnings: string[] = [];
  for (const e of events) if (e.title === "Unknown event") warnings.push(`Event ${e.label} (${short(e.key)}) is not in this environment's registry. Do not sign unless you recognise it.`);
  for (const m of plan.mints) if (!asset(m)) warnings.push(`Token ${short(m)} is not in this environment's asset list.`);
  if (report.enumeration === "partial") warnings.push("This future has many events; outcome paths were enumerated for YES/NO plus refund cases, not every combination.");
  const dependencies = [
    ...new Set([
      ...events.map((e) => `${e.label}: ${e.venue} · ${e.trust}`),
      ...plan.refs.map((r) => {
        const info = lookup.ref(r);
        return info ? `${info.kind === "pool" ? "Route" : info.kind === "recipient" ? "Recipient" : info.kind === "strategy" ? "Predecessor future" : "Market"}: ${info.label} (${short(r)})` : `Account ${short(r)}`;
      }),
    ]),
  ];
  return {
    planHash: hash,
    sizeBytes: bytes.length,
    headline: `Reserve ${totalReserved} until ${formatTime(plan.expiresAt)}`,
    expiresAt: plan.expiresAt,
    expiresText: formatTime(plan.expiresAt),
    reserved,
    worstCaseSpend: worst,
    grossVolume: gross,
    maxFees: fees,
    maxToRecipients: toRecipients,
    events,
    steps,
    assets: plan.mints.map((m) => asset(m)?.symbol ?? short(m)),
    dependencies,
    cancellation: locked
      ? [
          "Cancellation is locked until expiry (fixed in this authorization).",
          `After ${formatTime(plan.expiresAt)} anyone can close it, and everything unspent returns to your available balance.`,
        ]
      : [
          "You can cancel at any time. Everything not yet spent returns to your available balance immediately.",
          "Pausing stops new steps but keeps funds reserved; cancelling releases them.",
          "Cancelling never reverses completed trades or refunds fees. Assets already bought stay yours and return to available.",
        ],
    failure: [
      "If a swap can't meet its minimum received, the transaction fails and nothing is spent. It can be retried until its deadline.",
      "A failed or expired transaction never consumes an allocation.",
      `At ${formatTime(plan.expiresAt)}, every unspent amount — and any asset bought but not yet released — returns to your available balance.`,
      "Withdrawals of available funds are never blocked, including during an emergency pause.",
    ],
    outcomes: [
      "Only final outcomes count. A proposed outcome becomes final after its challenge window; a disputed outcome is not final.",
      "A voided event makes every condition on it false (frozen for this authorization).",
      "Resolving NO is different from not resolving: NO can trigger steps; an event still unresolved at expiry triggers nothing and its funds are refunded.",
    ],
    enforcement: [
      `The vault program checks this exact plan (hash ${hash.slice(0, 16)}…) on every step: conditions, amounts, minimums, fees, recipients, routes and deadlines.`,
      "Keepers and agents can only trigger steps that are already allowed. Any edit creates a new version that needs a new signature.",
      `Environment: ${opts.environment}.`,
    ],
    warnings,
  };
}
