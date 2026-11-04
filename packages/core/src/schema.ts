import { z } from "zod";
import { isAddress } from "./hash.ts";
import { LIMITS } from "./limits.ts";

/**
 * maybe.strategy/1 — the typed strategy document.
 *
 * This document is what the sentence view, graph view, list view, templates and
 * agents all edit. It is never executed directly: it is validated, compiled to a
 * bounded binary plan (plan.ts), and only the plan bytes are signed and enforced
 * on-chain. Everything the review screen shows is decoded from those bytes.
 */

export const zAddress = z.string().refine(isAddress, { message: "must be a base58 Solana address" });
export const zAmount = z.string().regex(/^(0|[1-9]\d*)$/, "must be a base-unit integer string");
export const zHex32 = z.string().regex(/^[0-9a-f]{64}$/, "must be 32 bytes of lowercase hex");
export const zId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/, "ids are 1-32 chars, start with a letter");
export const zUnixSeconds = z.number().int().nonnegative();

export const OUTCOMES = ["YES", "NO"] as const;
export const zOutcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof zOutcome>;
/** The result an event can finalize to. VOID = cancelled/annulled market. */
export type FinalOutcome = Outcome | "VOID";

export const VENUES = ["maybe-local", "solana", "polymarket", "kalshi"] as const;
export const zVenue = z.enum(VENUES);
export type VenueId = z.infer<typeof zVenue>;

export const ADAPTERS = ["attestation", "balance-threshold"] as const;
export const zAdapter = z.enum(ADAPTERS);
export type AdapterKind = z.infer<typeof zAdapter>;

export const zEventRef = z.object({
  ref: z.string().regex(/^[A-Z][A-Z0-9]{0,3}$/, "event refs are short uppercase labels like A, B, E2"),
  eventKey: zAddress,
  venue: zVenue,
  venueMarketId: z.string().min(1).max(128),
  ruleHash: zHex32,
  title: z.string().min(1).max(200),
  adapter: zAdapter,
  closesAt: zUnixSeconds.optional(),
  resolvesBy: zUnixSeconds.optional(),
});
export type EventRef = z.infer<typeof zEventRef>;

export const zAllocation = z.object({
  id: zId,
  label: z.string().min(1).max(60),
  mint: zAddress,
  amount: zAmount,
});
export type Allocation = z.infer<typeof zAllocation>;

const nodeBase = { id: zId };
export const zNode = z.discriminatedUnion("kind", [
  z.object({ ...nodeBase, kind: z.literal("always") }),
  z.object({ ...nodeBase, kind: z.literal("outcome"), event: z.string(), outcome: zOutcome }),
  z.object({ ...nodeBase, kind: z.literal("not"), child: zId }),
  z.object({ ...nodeBase, kind: z.literal("and"), children: z.array(zId).min(2).max(LIMITS.MAX_CHILDREN) }),
  z.object({ ...nodeBase, kind: z.literal("or"), children: z.array(zId).min(2).max(LIMITS.MAX_CHILDREN) }),
  z.object({
    ...nodeBase,
    kind: z.literal("atLeast"),
    k: z.number().int().min(1),
    children: z.array(zId).min(2).max(LIMITS.MAX_CHILDREN),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal("veto"),
    /** the vetoing event */
    event: z.string(),
    /** the veto outcome (usually YES = "veto happened") */
    outcome: zOutcome,
    /** node whose TRUE-time starts the evaluation window */
    trigger: zId,
    windowSeconds: z.number().int().min(0).max(LIMITS.MAX_VETO_WINDOW_SECONDS),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal("receipt"),
    /** "self" or the address of a predecessor strategy account */
    strategy: z.union([z.literal("self"), zAddress]),
    /** action id when strategy === "self"; action index (as string) for external strategies */
    action: z.string().min(1).max(32),
  }),
  z.object({ ...nodeBase, kind: z.literal("after"), at: zUnixSeconds }),
]);
export type PredicateNode = z.infer<typeof zNode>;
export type NodeKind = PredicateNode["kind"];

export const zAmountSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amount: zAmount }),
  z.object({ kind: z.literal("bpsOfAllocation"), bps: z.number().int().min(1).max(10_000) }),
  z.object({
    kind: z.literal("bpsOfReceived"),
    action: zId,
    bps: z.number().int().min(1).max(10_000),
    cap: zAmount.optional(),
  }),
  z.object({ kind: z.literal("allOfHolding"), cap: zAmount.optional() }),
]);
export type AmountSpec = z.infer<typeof zAmountSpec>;

export const zSchedule = z.object({
  runs: z.number().int().min(2).max(LIMITS.MAX_RUNS),
  intervalSeconds: z.number().int().min(LIMITS.MIN_SCHEDULE_INTERVAL_SECONDS),
  /** skip: a run not executed before the next run time is skipped. catchUp: late runs may still execute, one per transaction. */
  missed: z.enum(["skip", "catchUp"]),
});
export type Schedule = z.infer<typeof zSchedule>;

export const ROUTE_KINDS = ["cp-swap", "outcome-buy", "outcome-redeem"] as const;
export const zRoute = z.object({ kind: z.enum(ROUTE_KINDS), pool: zAddress });
export type Route = z.infer<typeof zRoute>;

export const zMinOut = z.discriminatedUnion("kind", [
  /** minimum output per run, in output base units */
  z.object({ kind: z.literal("absolute"), amount: zAmount }),
  /** minimum output per input base unit, scaled by 1e9 (a limit price) */
  z.object({ kind: z.literal("rate"), outPerInE9: zAmount }),
]);
export type MinOut = z.infer<typeof zMinOut>;

const actionBase = {
  id: zId,
  label: z.string().max(80).optional(),
  allocation: zId,
  guard: zId,
  branch: z.object({ group: zId, branch: zId }).optional(),
  delaySeconds: z.number().int().min(0).max(LIMITS.MAX_DELAY_SECONDS).default(0),
  /** unix seconds; defaults to the strategy expiry */
  deadline: zUnixSeconds.optional(),
  schedule: zSchedule.optional(),
};

export const zAction = z.discriminatedUnion("kind", [
  z.object({
    ...actionBase,
    kind: z.literal("swap"),
    inputMint: zAddress,
    outputMint: zAddress,
    amount: zAmountSpec,
    minOut: zMinOut,
    route: zRoute,
    feeBps: z.number().int().min(0).max(LIMITS.MAX_FEE_BPS).default(0),
  }),
  z.object({
    ...actionBase,
    kind: z.literal("transfer"),
    mint: zAddress,
    amount: zAmountSpec,
    /** wallet that receives the tokens (its associated token account) */
    recipient: zAddress,
    feeBps: z.number().int().min(0).max(LIMITS.MAX_FEE_BPS).default(0),
  }),
  z.object({
    ...actionBase,
    kind: z.literal("release"),
    mint: zAddress,
    amount: zAmountSpec,
  }),
]);
export type Action = z.infer<typeof zAction>;
export type DocActionKind = Action["kind"];

export const zLayout = z.record(z.string(), z.object({ x: z.number(), y: z.number() }));

export const zStrategy = z.object({
  schema: z.literal("maybe.strategy/1"),
  id: z.string().min(1).max(64),
  version: z.number().int().min(1),
  title: z.string().min(1).max(120),
  thesis: z.string().max(2000).optional(),
  /** client-chosen u64; makes every authorization unique even for identical rules */
  nonce: zAmount,
  expiresAt: zUnixSeconds,
  maxFeeBps: z.number().int().min(0).max(LIMITS.MAX_FEE_BPS),
  /** Frozen at authorization. v1 supports exactly one policy: a VOID event makes every outcome leaf on it FALSE. */
  voidPolicy: z.literal("void-is-false").default("void-is-false"),
  cancelPolicy: z.enum(["anytime", "locked-until-expiry"]).default("anytime"),
  events: z.array(zEventRef).max(LIMITS.MAX_EVENTS),
  allocations: z.array(zAllocation).min(1).max(LIMITS.MAX_ALLOCATIONS),
  nodes: z.array(zNode).max(LIMITS.MAX_NODES),
  actions: z.array(zAction).min(1).max(LIMITS.MAX_ACTIONS),
  layout: zLayout.optional(),
  /** Questions an agent could not resolve. A draft with open questions can never be compiled. */
  unresolved: z.array(z.object({ field: z.string(), question: z.string() })).optional(),
  meta: z
    .object({
      source: z.enum(["builder", "template", "agent", "room-clone"]).optional(),
      template: z.string().optional(),
      roomId: z.string().optional(),
      roomVersion: z.number().int().optional(),
      supersedes: z.string().optional(),
    })
    .optional(),
});
export type Strategy = z.infer<typeof zStrategy>;
export type StrategyInput = z.input<typeof zStrategy>;

export function parseStrategy(input: unknown): { ok: true; value: Strategy } | { ok: false; issues: string[] } {
  const r = zStrategy.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
