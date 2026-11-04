/**
 * Hard bounds on strategy size. These are part of the on-chain contract
 * (programs/maybe-vault/src/plan.rs mirrors them) so every committed plan can be
 * parsed and evaluated within one Solana transaction's compute budget.
 */
export const LIMITS = {
  MAX_EVENTS: 8,
  MAX_MINTS: 6,
  MAX_REFS: 6,
  MAX_ALLOCATIONS: 4,
  MAX_NODES: 24,
  MAX_ACTIONS: 12,
  MAX_CHILDREN: 8,
  MAX_GROUPS: 8,
  MAX_BRANCHES_PER_GROUP: 8,
  MAX_RUNS: 52,
  MAX_DEPTH: 8,
  MAX_PLAN_BYTES: 2_600,
  /** maximum protocol fee any plan may authorize (1.00%) */
  MAX_FEE_BPS: 100,
  MIN_SCHEDULE_INTERVAL_SECONDS: 60,
  MAX_DELAY_SECONDS: 365 * 24 * 3600,
  MAX_STRATEGY_DURATION_SECONDS: 400 * 24 * 3600,
  MAX_VETO_WINDOW_SECONDS: 30 * 24 * 3600,
} as const;

export const NONE = 0xff;
