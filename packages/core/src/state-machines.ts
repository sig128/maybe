/**
 * Formal transition tables. Status values anywhere in MAYBE (database rows,
 * API responses, UI badges) come from these machines; code moves between states
 * only through `transition`, which rejects anything not in the table.
 */

export interface Transition<S extends string, E extends string> {
  from: S;
  event: E;
  to: S;
  /** human-readable condition that must hold (enforced by the caller/program) */
  guard?: string;
}

export interface Machine<S extends string, E extends string> {
  name: string;
  states: readonly S[];
  initial: S;
  terminal: readonly S[];
  transitions: ReadonlyArray<Transition<S, E>>;
}

export class TransitionError extends Error {
  constructor(machine: string, from: string, event: string) {
    super(`${machine}: no transition from ${from} on ${event}`);
    this.name = "TransitionError";
  }
}

export function transition<S extends string, E extends string>(m: Machine<S, E>, from: S, event: E): S {
  const t = m.transitions.find((x) => x.from === from && x.event === event);
  if (!t) throw new TransitionError(m.name, from, event);
  return t.to;
}

export function canTransition<S extends string, E extends string>(m: Machine<S, E>, from: S, event: E): boolean {
  return m.transitions.some((x) => x.from === from && x.event === event);
}

export function eventsFrom<S extends string, E extends string>(m: Machine<S, E>, from: S): E[] {
  return m.transitions.filter((x) => x.from === from).map((x) => x.event);
}

// ---------------------------------------------------------------- strategy
export const STRATEGY_STATES = [
  "DRAFT",
  "INVALID",
  "READY",
  "AWAITING_SIGNATURE",
  "UPLOADING",
  "ACTIVATING",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "SUPERSEDED",
  "ACTIVATION_FAILED",
] as const;
export type StrategyLifecycleState = (typeof STRATEGY_STATES)[number];
export type StrategyLifecycleEvent =
  | "EDIT"
  | "VALIDATION_PASSED"
  | "VALIDATION_FAILED"
  | "REQUEST_SIGNATURE"
  | "SIGNATURE_DECLINED"
  | "SIGNED"
  | "UPLOAD_CONFIRMED"
  | "ACTIVATION_CONFIRMED"
  | "ACTIVATION_REJECTED"
  | "PAUSE"
  | "RESUME"
  | "ALL_ACTIONS_TERMINAL"
  | "EXPIRY_REACHED"
  | "CANCEL"
  | "SUPERSEDE";

export const strategyMachine: Machine<StrategyLifecycleState, StrategyLifecycleEvent> = {
  name: "strategy",
  states: STRATEGY_STATES,
  initial: "DRAFT",
  terminal: ["COMPLETED", "EXPIRED", "CANCELLED", "SUPERSEDED"],
  transitions: [
    { from: "DRAFT", event: "VALIDATION_PASSED", to: "READY" },
    { from: "DRAFT", event: "VALIDATION_FAILED", to: "INVALID" },
    { from: "DRAFT", event: "EDIT", to: "DRAFT" },
    { from: "INVALID", event: "EDIT", to: "DRAFT" },
    { from: "READY", event: "EDIT", to: "DRAFT", guard: "any edit invalidates the prepared authorization" },
    { from: "READY", event: "REQUEST_SIGNATURE", to: "AWAITING_SIGNATURE" },
    { from: "AWAITING_SIGNATURE", event: "SIGNATURE_DECLINED", to: "READY" },
    { from: "AWAITING_SIGNATURE", event: "EDIT", to: "DRAFT", guard: "editing discards the pending signature request" },
    { from: "AWAITING_SIGNATURE", event: "SIGNED", to: "UPLOADING" },
    { from: "UPLOADING", event: "UPLOAD_CONFIRMED", to: "ACTIVATING", guard: "sha256(uploaded bytes) == signed plan hash" },
    { from: "UPLOADING", event: "ACTIVATION_REJECTED", to: "ACTIVATION_FAILED" },
    { from: "ACTIVATING", event: "ACTIVATION_CONFIRMED", to: "ACTIVE", guard: "confirmed on-chain; reservation moved" },
    { from: "ACTIVATING", event: "ACTIVATION_REJECTED", to: "ACTIVATION_FAILED" },
    { from: "ACTIVATION_FAILED", event: "EDIT", to: "DRAFT" },
    { from: "ACTIVATION_FAILED", event: "REQUEST_SIGNATURE", to: "AWAITING_SIGNATURE", guard: "no funds were reserved" },
    { from: "ACTIVE", event: "PAUSE", to: "PAUSED", guard: "owner; blocks new actions only" },
    { from: "PAUSED", event: "RESUME", to: "ACTIVE", guard: "owner" },
    { from: "ACTIVE", event: "ALL_ACTIONS_TERMINAL", to: "COMPLETED", guard: "every action executed, expired, lost its branch or became impossible" },
    { from: "ACTIVE", event: "EXPIRY_REACHED", to: "EXPIRED", guard: "now >= expires_at; unspent returned" },
    { from: "PAUSED", event: "EXPIRY_REACHED", to: "EXPIRED" },
    { from: "ACTIVE", event: "CANCEL", to: "CANCELLED", guard: "owner; plan not cancel-locked; unspent returned" },
    { from: "PAUSED", event: "CANCEL", to: "CANCELLED" },
    { from: "ACTIVE", event: "SUPERSEDE", to: "SUPERSEDED", guard: "owner signed a new version; old version cancelled atomically" },
    { from: "PAUSED", event: "SUPERSEDE", to: "SUPERSEDED" },
  ],
};

// ---------------------------------------------------------------- action
export const ACTION_STATES = [
  "WAITING",
  "SCHEDULED",
  "EXECUTABLE",
  "SUBMITTING",
  "PARTIALLY_EXECUTED",
  "EXECUTED",
  "RETRYABLE_FAILURE",
  "BLOCKED",
  "SKIPPED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type ActionLifecycleState = (typeof ACTION_STATES)[number];
export type ActionLifecycleEvent =
  | "GUARD_TRUE"
  | "GUARD_FALSE"
  | "DUE"
  | "SUBMIT"
  | "RUN_CONFIRMED"
  | "FINAL_RUN_CONFIRMED"
  | "FAILED_RETRYABLE"
  | "RETRY"
  | "BLOCK"
  | "UNBLOCK"
  | "BRANCH_LOST"
  | "DEADLINE"
  | "STRATEGY_CLOSED";

const actionCloseable: ActionLifecycleState[] = ["WAITING", "SCHEDULED", "EXECUTABLE", "PARTIALLY_EXECUTED", "RETRYABLE_FAILURE", "BLOCKED"];
export const actionMachine: Machine<ActionLifecycleState, ActionLifecycleEvent> = {
  name: "action",
  states: ACTION_STATES,
  initial: "WAITING",
  terminal: ["EXECUTED", "SKIPPED", "EXPIRED", "CANCELLED"],
  transitions: [
    { from: "WAITING", event: "GUARD_TRUE", to: "SCHEDULED", guard: "guard TRUE; delay or run time not reached" },
    { from: "WAITING", event: "DUE", to: "EXECUTABLE", guard: "guard TRUE and delay elapsed" },
    { from: "WAITING", event: "GUARD_FALSE", to: "SKIPPED", guard: "guard determinately FALSE" },
    { from: "SCHEDULED", event: "DUE", to: "EXECUTABLE" },
    { from: "EXECUTABLE", event: "SUBMIT", to: "SUBMITTING", guard: "keeper recorded intent (strategy, action, run) before sending" },
    { from: "SUBMITTING", event: "RUN_CONFIRMED", to: "PARTIALLY_EXECUTED", guard: "confirmed receipt; more runs remain" },
    { from: "SUBMITTING", event: "FINAL_RUN_CONFIRMED", to: "EXECUTED" },
    { from: "SUBMITTING", event: "FAILED_RETRYABLE", to: "RETRYABLE_FAILURE", guard: "transaction failed or expired; on-chain run counter unchanged" },
    { from: "RETRYABLE_FAILURE", event: "RETRY", to: "EXECUTABLE" },
    { from: "PARTIALLY_EXECUTED", event: "DUE", to: "EXECUTABLE" },
    { from: "PARTIALLY_EXECUTED", event: "GUARD_TRUE", to: "PARTIALLY_EXECUTED" },
    { from: "EXECUTABLE", event: "BLOCK", to: "BLOCKED", guard: "paused, or allocation insufficient" },
    { from: "BLOCKED", event: "UNBLOCK", to: "EXECUTABLE" },
    { from: "WAITING", event: "BRANCH_LOST", to: "SKIPPED" },
    { from: "SCHEDULED", event: "BRANCH_LOST", to: "SKIPPED" },
    { from: "EXECUTABLE", event: "BRANCH_LOST", to: "SKIPPED" },
    { from: "BLOCKED", event: "BRANCH_LOST", to: "SKIPPED" },
    { from: "RETRYABLE_FAILURE", event: "BRANCH_LOST", to: "SKIPPED" },
    ...actionCloseable.map((from) => ({ from, event: "DEADLINE" as const, to: "EXPIRED" as const })),
    ...actionCloseable.map((from) => ({ from, event: "STRATEGY_CLOSED" as const, to: "CANCELLED" as const })),
  ],
};

// ---------------------------------------------------------------- transaction
export const TX_STATES = ["BUILT", "SIGNED", "SUBMITTED", "PROCESSED", "CONFIRMED", "FINALIZED", "FAILED", "EXPIRED", "UNKNOWN"] as const;
export type TxState = (typeof TX_STATES)[number];
export type TxEvent =
  | "SIGN"
  | "SEND"
  | "SEEN_PROCESSED"
  | "SEEN_CONFIRMED"
  | "SEEN_FINALIZED"
  | "ERROR"
  | "BLOCKHASH_EXPIRED"
  | "TIMEOUT"
  | "FOUND"
  | "NOT_FOUND_AFTER_EXPIRY"
  | "ROLLED_BACK";

export const txMachine: Machine<TxState, TxEvent> = {
  name: "transaction",
  states: TX_STATES,
  initial: "BUILT",
  terminal: ["FINALIZED", "FAILED", "EXPIRED"],
  transitions: [
    { from: "BUILT", event: "SIGN", to: "SIGNED" },
    { from: "BUILT", event: "BLOCKHASH_EXPIRED", to: "EXPIRED" },
    { from: "SIGNED", event: "SEND", to: "SUBMITTED" },
    { from: "SIGNED", event: "BLOCKHASH_EXPIRED", to: "EXPIRED", guard: "never sent; safe to rebuild" },
    { from: "SUBMITTED", event: "SEEN_PROCESSED", to: "PROCESSED" },
    { from: "SUBMITTED", event: "SEEN_CONFIRMED", to: "CONFIRMED" },
    { from: "SUBMITTED", event: "SEEN_FINALIZED", to: "FINALIZED" },
    { from: "SUBMITTED", event: "ERROR", to: "FAILED", guard: "transaction executed with an error; state rolled back" },
    { from: "SUBMITTED", event: "TIMEOUT", to: "UNKNOWN", guard: "no status yet; outcome ambiguous" },
    { from: "PROCESSED", event: "SEEN_CONFIRMED", to: "CONFIRMED" },
    { from: "PROCESSED", event: "SEEN_FINALIZED", to: "FINALIZED" },
    { from: "PROCESSED", event: "ERROR", to: "FAILED" },
    { from: "PROCESSED", event: "ROLLED_BACK", to: "UNKNOWN", guard: "processed slot skipped by the cluster" },
    { from: "CONFIRMED", event: "SEEN_FINALIZED", to: "FINALIZED" },
    { from: "CONFIRMED", event: "ROLLED_BACK", to: "UNKNOWN" },
    { from: "UNKNOWN", event: "FOUND", to: "CONFIRMED", guard: "signature status found" },
    { from: "UNKNOWN", event: "ERROR", to: "FAILED" },
    { from: "UNKNOWN", event: "NOT_FOUND_AFTER_EXPIRY", to: "EXPIRED", guard: "block height > lastValidBlockHeight and signature absent: can never land" },
  ],
};

// ---------------------------------------------------------------- outcome registry
export const EVENT_STATES = ["OPEN", "PENDING", "DISPUTED", "FINAL"] as const;
export type EventLifecycleState = (typeof EVENT_STATES)[number];
export type EventLifecycleEvent =
  | "ATTEST"
  | "ATTEST_SAME"
  | "ATTEST_CONFLICT"
  | "WINDOW_ELAPSED"
  | "ADJUDICATE"
  | "DISPUTE_TIMEOUT"
  | "OBSERVE_THRESHOLD"
  | "DEADLINE_PASSED";

export const eventMachine: Machine<EventLifecycleState, EventLifecycleEvent> = {
  name: "event",
  states: EVENT_STATES,
  initial: "OPEN",
  terminal: ["FINAL"],
  transitions: [
    { from: "OPEN", event: "ATTEST", to: "PENDING", guard: ">= threshold attestor signatures over the domain-separated message; fresh nonce" },
    { from: "PENDING", event: "ATTEST_SAME", to: "PENDING", guard: "same outcome; idempotent" },
    { from: "PENDING", event: "ATTEST_CONFLICT", to: "DISPUTED", guard: "threshold signatures for a different outcome during the challenge window" },
    { from: "PENDING", event: "WINDOW_ELAPSED", to: "FINAL", guard: "now >= proposed_at + challenge window (lazy)" },
    { from: "DISPUTED", event: "ADJUDICATE", to: "FINAL", guard: "super-threshold of the same attestor set; outcome in {YES, NO, VOID}; cannot move funds" },
    { from: "DISPUTED", event: "DISPUTE_TIMEOUT", to: "FINAL", guard: "unadjudicated past timeout: final VOID" },
    { from: "OPEN", event: "OBSERVE_THRESHOLD", to: "FINAL", guard: "balance adapter: observed balance >= threshold at or before deadline: YES" },
    { from: "OPEN", event: "DEADLINE_PASSED", to: "FINAL", guard: "balance adapter: no qualifying observation by deadline: NO at deadline+1 (lazy)" },
  ],
};

// ---------------------------------------------------------------- durable job
export const JOB_STATES = ["QUEUED", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "DEAD", "CANCELLED"] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobEvent = "CLAIM" | "SUCCEED" | "FAIL_RETRYABLE" | "FAIL_FATAL" | "LEASE_EXPIRED" | "RETRY_DUE" | "CANCEL" | "ATTEMPTS_EXHAUSTED";

export const jobMachine: Machine<JobState, JobEvent> = {
  name: "job",
  states: JOB_STATES,
  initial: "QUEUED",
  terminal: ["SUCCEEDED", "DEAD", "CANCELLED"],
  transitions: [
    { from: "QUEUED", event: "CLAIM", to: "RUNNING", guard: "FOR UPDATE SKIP LOCKED; lease set" },
    { from: "QUEUED", event: "CANCEL", to: "CANCELLED" },
    { from: "RUNNING", event: "SUCCEED", to: "SUCCEEDED" },
    { from: "RUNNING", event: "FAIL_RETRYABLE", to: "RETRY_WAIT", guard: "backoff scheduled" },
    { from: "RUNNING", event: "FAIL_FATAL", to: "DEAD" },
    { from: "RUNNING", event: "ATTEMPTS_EXHAUSTED", to: "DEAD" },
    { from: "RUNNING", event: "LEASE_EXPIRED", to: "QUEUED", guard: "worker died; the job re-reads chain state before acting" },
    { from: "RETRY_WAIT", event: "RETRY_DUE", to: "QUEUED" },
    { from: "RETRY_WAIT", event: "CANCEL", to: "CANCELLED" },
  ],
};

// ---------------------------------------------------------------- agent capability policy
export const POLICY_STATES = ["ACTIVE", "EXHAUSTED", "EXPIRED", "REVOKED"] as const;
export type PolicyState = (typeof POLICY_STATES)[number];
export type PolicyEvent = "SPEND" | "LIMIT_REACHED" | "EXPIRY" | "REVOKE" | "KILL_SWITCH";

export const policyMachine: Machine<PolicyState, PolicyEvent> = {
  name: "agent-policy",
  states: POLICY_STATES,
  initial: "ACTIVE",
  terminal: ["EXPIRED", "REVOKED"],
  transitions: [
    { from: "ACTIVE", event: "SPEND", to: "ACTIVE", guard: "within total, per-action, asset, venue, recipient and fee limits" },
    { from: "ACTIVE", event: "LIMIT_REACHED", to: "EXHAUSTED" },
    { from: "ACTIVE", event: "EXPIRY", to: "EXPIRED" },
    { from: "EXHAUSTED", event: "EXPIRY", to: "EXPIRED" },
    { from: "ACTIVE", event: "REVOKE", to: "REVOKED", guard: "owner signature" },
    { from: "EXHAUSTED", event: "REVOKE", to: "REVOKED" },
    { from: "ACTIVE", event: "KILL_SWITCH", to: "REVOKED", guard: "owner bumps vault policy epoch; all sessions void" },
    { from: "EXHAUSTED", event: "KILL_SWITCH", to: "REVOKED" },
  ],
};

export const MACHINES = [strategyMachine, actionMachine, txMachine, eventMachine, jobMachine, policyMachine] as const;
