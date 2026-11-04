import type { CapabilityPolicy, EventRef, FixtureSet, Plan, SimulationReport, Strategy, ValidationResult } from "@maybe/core";

/**
 * What an agent can see. Everything here is read-only. There is deliberately
 * no method that moves money: agents draft, validate, simulate and explain.
 * Funding happens only through the owner's signature, or — with an explicit,
 * revocable capability policy — through a session key whose limits the vault
 * program enforces on-chain.
 */
export interface AgentMarket {
  key: string;
  eventKey: string;
  title: string;
  venue: string;
  category: string;
  kind: string;
  status: string;
  closesAt: number;
  resolvesBy: number;
  executable: boolean;
  reason?: string;
  rules: string;
  description: string;
  yesBps?: number;
}

export interface AgentStrategySummary {
  id: string;
  title: string;
  status: string;
  reserved: string;
  waiting: string[];
  nextAt?: number;
  issues: string[];
}

export interface AgentWorld {
  now(): number;
  markets(): AgentMarket[];
  fixtures(): FixtureSet;
  eventRef(marketKey: string, ref: string): EventRef | null;
  validate(doc: Strategy): ValidationResult;
  simulate(plan: Plan, refs: string[]): SimulationReport;
  strategies(): AgentStrategySummary[];
  policies(): CapabilityPolicy[];
  vaultEpoch(): number;
  /** format base units of a mint for display */
  fmt(mint: string, units: bigint): string;
}

export type AgentRole = "researcher" | "builder" | "monitor" | "executor";

export type ToolName = "searchMarkets" | "readMarket" | "parseIntent" | "draftStrategy" | "validate" | "simulate" | "listStrategies" | "checkReadiness" | "checkPolicy";

/** Server-side allowlists. Money-moving operations are not tools at all. */
export const ROLE_TOOLS: Record<AgentRole, ToolName[]> = {
  researcher: ["searchMarkets", "readMarket"],
  builder: ["searchMarkets", "readMarket", "parseIntent", "draftStrategy", "validate", "simulate"],
  monitor: ["listStrategies", "searchMarkets", "readMarket"],
  executor: ["listStrategies", "checkReadiness", "checkPolicy", "validate", "simulate"],
};

export const ROLE_INFO: Record<AgentRole, { name: string; job: string }> = {
  researcher: { name: "Researcher", job: "Finds markets and explains their rules, sources and deadlines." },
  builder: { name: "Strategy Builder", job: "Turns what you say into a validated draft you can review." },
  monitor: { name: "Monitor", job: "Watches your futures and tells you what is waiting or needs attention." },
  executor: { name: "Execution Assistant", job: "Checks readiness and limits. Funds drafts only under a policy you created." },
};

export interface Step {
  kind: "message" | "tool" | "source" | "draft" | "validation" | "question" | "refusal";
  text: string;
  detail?: string;
  data?: unknown;
  untrusted?: boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface TurnResult {
  steps: Step[];
  draft?: Strategy;
  costUsd: number;
  provider: string;
}
