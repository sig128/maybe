import type { EventView, Readiness, StrategyLifecycleState, TxState } from "@maybe/core";
import type { IconName } from "../components/Icon.tsx";
import type { Tone } from "../components/ui.tsx";
import { relTime } from "./time.ts";

export interface StatusDisplay {
  tone: Tone;
  icon: IconName;
  label: string;
  detail?: string;
}

export const STRATEGY_STATUS: Record<StrategyLifecycleState, StatusDisplay> = {
  DRAFT: { tone: "quiet", icon: "sentence", label: "Draft" },
  INVALID: { tone: "error", icon: "alert", label: "Needs fixes" },
  READY: { tone: "quiet", icon: "check", label: "Ready to review" },
  AWAITING_SIGNATURE: { tone: "pending", icon: "clock", label: "Awaiting signature" },
  UPLOADING: { tone: "pending", icon: "clock", label: "Submitting" },
  ACTIVATING: { tone: "pending", icon: "clock", label: "Submitting" },
  ACTIVE: { tone: "live", icon: "dot", label: "Active" },
  PAUSED: { tone: "pending", icon: "pause", label: "Paused" },
  COMPLETED: { tone: "neutral", icon: "check", label: "Completed" },
  EXPIRED: { tone: "neutral", icon: "time", label: "Expired" },
  CANCELLED: { tone: "neutral", icon: "close", label: "Cancelled" },
  SUPERSEDED: { tone: "neutral", icon: "branch", label: "Replaced" },
  ACTIVATION_FAILED: { tone: "error", icon: "alert", label: "Not activated" },
};

const BLOCKED: Record<string, string> = {
  STRATEGY_PAUSED: "Paused by you",
  EXECUTION_PAUSED: "Emergency pause",
  AMOUNT_ZERO: "Nothing to spend yet",
  INSUFFICIENT_ALLOCATION: "Allocation too small",
};

const DONE: Record<string, StatusDisplay> = {
  ACTION_COMPLETE: { tone: "neutral", icon: "check", label: "Done" },
  GUARD_FALSE: { tone: "neutral", icon: "close", label: "Won't run" },
  DEADLINE_PASSED: { tone: "neutral", icon: "time", label: "Expired unfilled" },
  BRANCH_LOST: { tone: "neutral", icon: "branch", label: "Other branch ran" },
  STRATEGY_CLOSED: { tone: "neutral", icon: "close", label: "Closed" },
};

export function readinessDisplay(r: Readiness | undefined, now: number): StatusDisplay {
  if (!r) return { tone: "quiet", icon: "sentence", label: "Not authorized" };
  switch (r.state) {
    case "executable":
      return { tone: "live", icon: "play", label: "Executing next", detail: "Conditions are met; the keeper will submit it" };
    case "waiting":
      return { tone: "quiet", icon: "clock", label: "Waiting for outcome" };
    case "scheduled":
      return { tone: "pending", icon: "time", label: `Runs ${relTime(r.at, now)}`, detail: r.reason === "DELAY_PENDING" ? "Delay after the condition became final" : "Next scheduled run" };
    case "blocked":
      return { tone: "pending", icon: "pause", label: BLOCKED[r.reason] ?? "Blocked" };
    case "done":
      return DONE[r.reason] ?? { tone: "neutral", icon: "check", label: "Done" };
  }
}

export const TX_STATUS: Record<TxState, StatusDisplay> = {
  BUILT: { tone: "quiet", icon: "clock", label: "Prepared" },
  SIGNED: { tone: "pending", icon: "clock", label: "Signed" },
  SUBMITTED: { tone: "pending", icon: "clock", label: "Submitted" },
  PROCESSED: { tone: "pending", icon: "clock", label: "Processed" },
  CONFIRMED: { tone: "live", icon: "check", label: "Confirmed" },
  FINALIZED: { tone: "live", icon: "check", label: "Finalized" },
  FAILED: { tone: "error", icon: "alert", label: "Failed" },
  EXPIRED: { tone: "error", icon: "alert", label: "Didn't land" },
  UNKNOWN: { tone: "pending", icon: "refresh", label: "Checking" },
};

export function eventDisplay(e: EventView | undefined, now: number): StatusDisplay {
  if (!e) return { tone: "quiet", icon: "clock", label: "Unknown" };
  if (e.status === "FINAL") return { tone: "solid", icon: "check", label: `Final ${e.outcome}` };
  if (e.status === "PENDING") {
    if (e.finalAt !== null && now >= e.finalAt) return { tone: "solid", icon: "check", label: `Final ${e.outcome}` };
    return { tone: "pending", icon: "clock", label: `${e.outcome} proposed`, detail: e.finalAt ? `Final ${relTime(e.finalAt, now)} unless disputed` : undefined };
  }
  if (e.status === "DISPUTED") return { tone: "pending", icon: "alert", label: "Disputed", detail: "Not final until adjudicated or voided" };
  if (e.adapter === "BALANCE" && e.deadline !== undefined && now > e.deadline) return { tone: "solid", icon: "check", label: "Final NO" };
  return { tone: "quiet", icon: "clock", label: "Unresolved" };
}
