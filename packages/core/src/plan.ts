import { LIMITS, NONE } from "./limits.ts";
import { addressToBytes, base58Encode, bytesToHex, sha256Bytes } from "./hash.ts";

/**
 * Compiled plan, binary layout "MYB1" (version 1). This is the ONLY thing a user
 * signs and the ONLY thing the vault program enforces. See docs/INTERFACE_CONTRACT.md.
 * All integers little-endian. Reserved bytes must be zero; unused child slots 0xFF.
 * Decoding is strict so that every plan has exactly one canonical encoding.
 */

export const PLAN_MAGIC = [0x4d, 0x59, 0x42, 0x31] as const; // "MYB1"
export const PLAN_VERSION = 1;
export const HEADER_SIZE = 32;
export const ALLOC_SIZE = 16;
export const NODE_SIZE = 24;
export const ACTION_SIZE = 72;

export const PLAN_FLAG_CANCEL_LOCKED = 0b0000_0001;
export const ACTION_FLAG_MIN_OUT_IS_RATE = 0b0000_0001;
export const ACTION_FLAG_MISSED_CATCH_UP = 0b0000_0010;

export enum NodeOp {
  ALWAYS = 0,
  OUTCOME = 1,
  NOT = 2,
  AND = 3,
  OR = 4,
  ATLEAST = 5,
  VETO = 6,
  RECEIPT = 7,
  AFTER = 8,
}

export enum ActionKind {
  SWAP = 1,
  TRANSFER = 2,
  RELEASE = 3,
}

export enum RouteKind {
  NONE = 0,
  CP_SWAP = 1,
  OUTCOME_BUY = 2,
  OUTCOME_REDEEM = 3,
}

export enum AmountKind {
  FIXED = 1,
  BPS_OF_ALLOCATION = 2,
  BPS_OF_RECEIVED = 3,
  ALL_OF_HOLDING = 4,
}

export const OUTCOME_NO = 0;
export const OUTCOME_YES = 1;

export interface PlanAllocation {
  mint: number;
  amount: bigint;
}

export interface PlanNode {
  op: NodeOp;
  /** OUTCOME/VETO: event index. RECEIPT: ref index (NONE = this strategy). */
  a: number;
  /** OUTCOME/VETO: outcome (1 YES, 0 NO). RECEIPT: action index. */
  b: number;
  /** ATLEAST: threshold */
  k: number;
  /** child node indices (NOT: [child], VETO: [trigger]) */
  children: number[];
  /** VETO: window seconds. AFTER: unix seconds. */
  param: number;
}

export interface PlanAction {
  kind: ActionKind;
  guard: number;
  alloc: number;
  inMint: number;
  outMint: number;
  routeKind: RouteKind;
  /** SWAP: pool/market ref. TRANSFER: recipient ref. RELEASE: NONE */
  ref: number;
  group: number;
  branch: number;
  amountKind: AmountKind;
  amountRef: number;
  flags: number;
  bps: number;
  feeBps: number;
  runs: number;
  delay: number;
  interval: number;
  /** FIXED: amount per run. BPS_OF_RECEIVED / ALL_OF_HOLDING: cap per run (0 = none). */
  amount: bigint;
  /** absolute minimum output per run, or rate x1e9 when ACTION_FLAG_MIN_OUT_IS_RATE */
  minOut: bigint;
  /** unix seconds, 0 = strategy expiry */
  deadline: number;
}

export interface Plan {
  version: number;
  flags: number;
  maxFeeBps: number;
  voidPolicy: number;
  expiresAt: number;
  nonce: bigint;
  events: string[];
  mints: string[];
  refs: string[];
  allocations: PlanAllocation[];
  nodes: PlanNode[];
  actions: PlanAction[];
}

export type PlanErrorCode =
  | "BAD_MAGIC"
  | "BAD_VERSION"
  | "TRUNCATED"
  | "TRAILING_BYTES"
  | "TOO_LARGE"
  | "NON_CANONICAL"
  | "COUNT_OUT_OF_RANGE"
  | "DUPLICATE_ENTRY"
  | "INDEX_OUT_OF_RANGE"
  | "NOT_TOPOLOGICAL"
  | "BAD_NODE"
  | "BAD_ACTION"
  | "BAD_AMOUNT"
  | "FEE_TOO_HIGH"
  | "BAD_SCHEDULE"
  | "BAD_DEADLINE"
  | "DEPTH_EXCEEDED"
  | "BAD_FLAGS";

export interface PlanIssue {
  code: PlanErrorCode;
  message: string;
  /** location within the plan */
  at?: { kind: "header" | "event" | "mint" | "ref" | "allocation" | "node" | "action"; index?: number };
}

export class PlanError extends Error {
  constructor(public readonly issue: PlanIssue) {
    super(`${issue.code}: ${issue.message}`);
    this.name = "PlanError";
  }
}

export function planSize(p: Pick<Plan, "events" | "mints" | "refs" | "allocations" | "nodes" | "actions">): number {
  return (
    HEADER_SIZE +
    32 * (p.events.length + p.mints.length + p.refs.length) +
    ALLOC_SIZE * p.allocations.length +
    NODE_SIZE * p.nodes.length +
    ACTION_SIZE * p.actions.length
  );
}

export function encodePlan(plan: Plan): Uint8Array {
  const issues = checkPlanStructure(plan);
  if (issues.length > 0) throw new PlanError(issues[0]!);
  const size = planSize(plan);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf.set(PLAN_MAGIC, 0);
  dv.setUint8(4, plan.version);
  dv.setUint8(5, plan.flags);
  dv.setUint8(6, plan.events.length);
  dv.setUint8(7, plan.mints.length);
  dv.setUint8(8, plan.refs.length);
  dv.setUint8(9, plan.allocations.length);
  dv.setUint8(10, plan.nodes.length);
  dv.setUint8(11, plan.actions.length);
  dv.setUint16(12, plan.maxFeeBps, true);
  dv.setUint8(14, plan.voidPolicy);
  dv.setUint8(15, 0);
  dv.setBigInt64(16, BigInt(plan.expiresAt), true);
  dv.setBigUint64(24, plan.nonce, true);
  let off = HEADER_SIZE;
  for (const list of [plan.events, plan.mints, plan.refs]) {
    for (const addr of list) {
      buf.set(addressToBytes(addr), off);
      off += 32;
    }
  }
  for (const a of plan.allocations) {
    dv.setUint8(off, a.mint);
    dv.setBigUint64(off + 8, a.amount, true);
    off += ALLOC_SIZE;
  }
  for (const n of plan.nodes) {
    dv.setUint8(off, n.op);
    dv.setUint8(off + 1, n.a);
    dv.setUint8(off + 2, n.b);
    dv.setUint8(off + 3, n.k);
    dv.setUint8(off + 4, n.children.length);
    for (let i = 0; i < LIMITS.MAX_CHILDREN; i++) dv.setUint8(off + 8 + i, n.children[i] ?? NONE);
    dv.setBigInt64(off + 16, BigInt(n.param), true);
    off += NODE_SIZE;
  }
  for (const a of plan.actions) {
    dv.setUint8(off, a.kind);
    dv.setUint8(off + 1, a.guard);
    dv.setUint8(off + 2, a.alloc);
    dv.setUint8(off + 3, a.inMint);
    dv.setUint8(off + 4, a.outMint);
    dv.setUint8(off + 5, a.routeKind);
    dv.setUint8(off + 6, a.ref);
    dv.setUint8(off + 7, a.group);
    dv.setUint8(off + 8, a.branch);
    dv.setUint8(off + 9, a.amountKind);
    dv.setUint8(off + 10, a.amountRef);
    dv.setUint8(off + 11, a.flags);
    dv.setUint16(off + 12, a.bps, true);
    dv.setUint16(off + 14, a.feeBps, true);
    dv.setUint16(off + 16, a.runs, true);
    dv.setUint32(off + 20, a.delay, true);
    dv.setUint32(off + 24, a.interval, true);
    dv.setBigUint64(off + 32, a.amount, true);
    dv.setBigUint64(off + 40, a.minOut, true);
    dv.setBigInt64(off + 48, BigInt(a.deadline), true);
    off += ACTION_SIZE;
  }
  return buf;
}

function fail(code: PlanErrorCode, message: string, at?: PlanIssue["at"]): never {
  throw new PlanError({ code, message, ...(at ? { at } : {}) });
}

function requireZero(buf: Uint8Array, start: number, len: number, what: string, at?: PlanIssue["at"]) {
  for (let i = start; i < start + len; i++) if (buf[i] !== 0) fail("NON_CANONICAL", `${what}: reserved byte ${i} is not zero`, at);
}

function safeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) fail("BAD_DEADLINE", `${what} out of range`);
  return Number(v);
}

/** Strict decoder. Throws PlanError on any malformed or non-canonical input. */
export function decodePlan(buf: Uint8Array): Plan {
  if (buf.length > LIMITS.MAX_PLAN_BYTES) fail("TOO_LARGE", `plan is ${buf.length} bytes (max ${LIMITS.MAX_PLAN_BYTES})`);
  if (buf.length < HEADER_SIZE) fail("TRUNCATED", "plan shorter than header");
  for (let i = 0; i < 4; i++) if (buf[i] !== PLAN_MAGIC[i]) fail("BAD_MAGIC", "missing MYB1 magic", { kind: "header" });
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint8(4);
  if (version !== PLAN_VERSION) fail("BAD_VERSION", `unsupported plan version ${version}`, { kind: "header" });
  const flags = dv.getUint8(5);
  const nEvents = dv.getUint8(6);
  const nMints = dv.getUint8(7);
  const nRefs = dv.getUint8(8);
  const nAllocs = dv.getUint8(9);
  const nNodes = dv.getUint8(10);
  const nActions = dv.getUint8(11);
  const maxFeeBps = dv.getUint16(12, true);
  const voidPolicy = dv.getUint8(14);
  requireZero(buf, 15, 1, "header", { kind: "header" });
  const expiresAt = safeNumber(dv.getBigInt64(16, true), "expires_at");
  const nonce = dv.getBigUint64(24, true);
  const expected = planSize({
    events: new Array(nEvents),
    mints: new Array(nMints),
    refs: new Array(nRefs),
    allocations: new Array(nAllocs),
    nodes: new Array(nNodes),
    actions: new Array(nActions),
  });
  if (buf.length < expected) fail("TRUNCATED", `plan declares ${expected} bytes but has ${buf.length}`);
  if (buf.length > expected) fail("TRAILING_BYTES", `plan has ${buf.length - expected} trailing bytes`);
  let off = HEADER_SIZE;
  const readAddrs = (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(base58Encode(buf.slice(off, off + 32)));
      off += 32;
    }
    return out;
  };
  const events = readAddrs(nEvents);
  const mints = readAddrs(nMints);
  const refs = readAddrs(nRefs);
  const allocations: PlanAllocation[] = [];
  for (let i = 0; i < nAllocs; i++) {
    requireZero(buf, off + 1, 7, "allocation", { kind: "allocation", index: i });
    allocations.push({ mint: dv.getUint8(off), amount: dv.getBigUint64(off + 8, true) });
    off += ALLOC_SIZE;
  }
  const nodes: PlanNode[] = [];
  for (let i = 0; i < nNodes; i++) {
    const at = { kind: "node" as const, index: i };
    requireZero(buf, off + 5, 3, "node", at);
    const n = dv.getUint8(off + 4);
    if (n > LIMITS.MAX_CHILDREN) fail("BAD_NODE", "too many children", at);
    const children: number[] = [];
    for (let c = 0; c < LIMITS.MAX_CHILDREN; c++) {
      const v = dv.getUint8(off + 8 + c);
      if (c < n) children.push(v);
      else if (v !== NONE) fail("NON_CANONICAL", "unused child slot is not 0xFF", at);
    }
    nodes.push({
      op: dv.getUint8(off) as NodeOp,
      a: dv.getUint8(off + 1),
      b: dv.getUint8(off + 2),
      k: dv.getUint8(off + 3),
      children,
      param: safeNumber(dv.getBigInt64(off + 16, true), "node param"),
    });
    off += NODE_SIZE;
  }
  const actions: PlanAction[] = [];
  for (let i = 0; i < nActions; i++) {
    const at = { kind: "action" as const, index: i };
    requireZero(buf, off + 18, 2, "action", at);
    requireZero(buf, off + 28, 4, "action", at);
    requireZero(buf, off + 56, 16, "action", at);
    actions.push({
      kind: dv.getUint8(off) as ActionKind,
      guard: dv.getUint8(off + 1),
      alloc: dv.getUint8(off + 2),
      inMint: dv.getUint8(off + 3),
      outMint: dv.getUint8(off + 4),
      routeKind: dv.getUint8(off + 5) as RouteKind,
      ref: dv.getUint8(off + 6),
      group: dv.getUint8(off + 7),
      branch: dv.getUint8(off + 8),
      amountKind: dv.getUint8(off + 9) as AmountKind,
      amountRef: dv.getUint8(off + 10),
      flags: dv.getUint8(off + 11),
      bps: dv.getUint16(off + 12, true),
      feeBps: dv.getUint16(off + 14, true),
      runs: dv.getUint16(off + 16, true),
      delay: dv.getUint32(off + 20, true),
      interval: dv.getUint32(off + 24, true),
      amount: dv.getBigUint64(off + 32, true),
      minOut: dv.getBigUint64(off + 40, true),
      deadline: safeNumber(dv.getBigInt64(off + 48, true), "deadline"),
    });
    off += ACTION_SIZE;
  }
  const plan: Plan = { version, flags, maxFeeBps, voidPolicy, expiresAt, nonce, events, mints, refs, allocations, nodes, actions };
  const issues = checkPlanStructure(plan);
  if (issues.length > 0) throw new PlanError(issues[0]!);
  return plan;
}

export function planHash(bytes: Uint8Array): string {
  return bytesToHex(sha256Bytes(bytes));
}

/**
 * Time-independent structural checks. The vault program performs exactly these
 * checks at activation (plus time and balance checks). Returns all issues found.
 */
export function checkPlanStructure(plan: Plan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const push = (code: PlanErrorCode, message: string, at?: PlanIssue["at"]) => issues.push({ code, message, ...(at ? { at } : {}) });
  const H = { kind: "header" as const };
  if (plan.version !== PLAN_VERSION) push("BAD_VERSION", "unsupported version", H);
  if ((plan.flags & ~PLAN_FLAG_CANCEL_LOCKED) !== 0) push("BAD_FLAGS", "unknown plan flags", H);
  if (plan.voidPolicy !== 0) push("BAD_FLAGS", "unknown void policy", H);
  if (plan.maxFeeBps > LIMITS.MAX_FEE_BPS) push("FEE_TOO_HIGH", `max fee ${plan.maxFeeBps} bps exceeds ${LIMITS.MAX_FEE_BPS}`, H);
  if (plan.expiresAt <= 0) push("BAD_DEADLINE", "expiry must be set", H);
  if (plan.nonce > (1n << 64n) - 1n || plan.nonce < 0n) push("BAD_AMOUNT", "nonce out of u64 range", H);
  const range = (n: number, lo: number, hi: number, what: string) => {
    if (n < lo || n > hi) push("COUNT_OUT_OF_RANGE", `${what} count ${n} not in [${lo}, ${hi}]`, H);
  };
  range(plan.events.length, 0, LIMITS.MAX_EVENTS, "event");
  range(plan.mints.length, 1, LIMITS.MAX_MINTS, "mint");
  range(plan.refs.length, 0, LIMITS.MAX_REFS, "ref");
  range(plan.allocations.length, 1, LIMITS.MAX_ALLOCATIONS, "allocation");
  range(plan.nodes.length, 1, LIMITS.MAX_NODES, "node");
  range(plan.actions.length, 1, LIMITS.MAX_ACTIONS, "action");
  const dupCheck = (list: string[], kind: "event" | "mint" | "ref") => {
    const seen = new Set<string>();
    list.forEach((a, i) => {
      if (seen.has(a)) push("DUPLICATE_ENTRY", `duplicate ${kind} ${a}`, { kind, index: i });
      seen.add(a);
    });
  };
  dupCheck(plan.events, "event");
  dupCheck(plan.mints, "mint");
  dupCheck(plan.refs, "ref");
  plan.allocations.forEach((a, i) => {
    const at = { kind: "allocation" as const, index: i };
    if (a.mint >= plan.mints.length) push("INDEX_OUT_OF_RANGE", "allocation mint index out of range", at);
    if (a.amount <= 0n || a.amount > (1n << 64n) - 1n) push("BAD_AMOUNT", "allocation amount must be positive", at);
  });
  // nodes: topological order, op-specific shape
  const depth: number[] = [];
  plan.nodes.forEach((n, i) => {
    const at = { kind: "node" as const, index: i };
    let d = 1;
    for (const c of n.children) {
      if (c >= i) push("NOT_TOPOLOGICAL", `node ${i} references node ${c} which is not earlier`, at);
      else d = Math.max(d, (depth[c] ?? 1) + 1);
    }
    depth[i] = d;
    if (d > LIMITS.MAX_DEPTH) push("DEPTH_EXCEEDED", `predicate depth ${d} exceeds ${LIMITS.MAX_DEPTH}`, at);
    const shape = (cond: boolean, msg: string) => {
      if (!cond) push("BAD_NODE", msg, at);
    };
    switch (n.op) {
      case NodeOp.ALWAYS:
        shape(n.a === 0 && n.b === 0 && n.k === 0 && n.children.length === 0 && n.param === 0, "ALWAYS takes no operands");
        break;
      case NodeOp.OUTCOME:
        shape(n.a < plan.events.length, "OUTCOME event index out of range");
        shape(n.b === OUTCOME_YES || n.b === OUTCOME_NO, "OUTCOME must be YES or NO");
        shape(n.k === 0 && n.children.length === 0 && n.param === 0, "OUTCOME has extra operands");
        break;
      case NodeOp.NOT:
        shape(n.children.length === 1 && n.a === 0 && n.b === 0 && n.k === 0 && n.param === 0, "NOT takes exactly one child");
        break;
      case NodeOp.AND:
      case NodeOp.OR:
        shape(n.children.length >= 2 && n.a === 0 && n.b === 0 && n.k === 0 && n.param === 0, "AND/OR need at least two children");
        break;
      case NodeOp.ATLEAST:
        shape(n.children.length >= 2 && n.k >= 1 && n.k <= n.children.length && n.a === 0 && n.b === 0 && n.param === 0, "ATLEAST needs 1 <= k <= children");
        break;
      case NodeOp.VETO:
        shape(n.a < plan.events.length, "VETO event index out of range");
        shape(n.b === OUTCOME_YES || n.b === OUTCOME_NO, "VETO outcome must be YES or NO");
        shape(n.children.length === 1 && n.k === 0, "VETO takes exactly one trigger child");
        shape(n.param >= 0 && n.param <= LIMITS.MAX_VETO_WINDOW_SECONDS, "VETO window out of range");
        break;
      case NodeOp.RECEIPT:
        shape(n.a === NONE || n.a < plan.refs.length, "RECEIPT strategy ref out of range");
        shape(n.b < (n.a === NONE ? plan.actions.length : 256), "RECEIPT action index out of range");
        shape(n.k === 0 && n.children.length === 0 && n.param === 0, "RECEIPT has extra operands");
        break;
      case NodeOp.AFTER:
        shape(n.a === 0 && n.b === 0 && n.k === 0 && n.children.length === 0 && n.param > 0, "AFTER needs a timestamp");
        break;
      default:
        push("BAD_NODE", `unknown op ${n.op as number}`, at);
    }
  });
  plan.actions.forEach((a, i) => {
    const at = { kind: "action" as const, index: i };
    const bad = (code: PlanErrorCode, msg: string) => push(code, msg, at);
    if (a.guard >= plan.nodes.length) bad("INDEX_OUT_OF_RANGE", "guard node out of range");
    if (a.alloc >= plan.allocations.length) bad("INDEX_OUT_OF_RANGE", "allocation out of range");
    if (a.inMint >= plan.mints.length) bad("INDEX_OUT_OF_RANGE", "input mint out of range");
    if ((a.flags & ~(ACTION_FLAG_MIN_OUT_IS_RATE | ACTION_FLAG_MISSED_CATCH_UP)) !== 0) bad("BAD_FLAGS", "unknown action flags");
    if (a.feeBps > plan.maxFeeBps) bad("FEE_TOO_HIGH", `action fee ${a.feeBps} bps exceeds plan max ${plan.maxFeeBps}`);
    switch (a.kind) {
      case ActionKind.SWAP:
        if (a.outMint >= plan.mints.length) bad("INDEX_OUT_OF_RANGE", "output mint out of range");
        else if (a.outMint === a.inMint) bad("BAD_ACTION", "swap input and output mints must differ");
        if (a.routeKind < RouteKind.CP_SWAP || a.routeKind > RouteKind.OUTCOME_REDEEM) bad("BAD_ACTION", "unknown route kind");
        if (a.ref >= plan.refs.length) bad("INDEX_OUT_OF_RANGE", "route pool ref out of range");
        if (a.minOut === 0n) bad("BAD_AMOUNT", "swaps require a non-zero minimum received");
        break;
      case ActionKind.TRANSFER:
        if (a.outMint !== NONE || a.routeKind !== RouteKind.NONE) bad("BAD_ACTION", "transfer has swap fields");
        if (a.ref >= plan.refs.length) bad("INDEX_OUT_OF_RANGE", "recipient ref out of range");
        if (a.minOut !== 0n || (a.flags & ACTION_FLAG_MIN_OUT_IS_RATE) !== 0) bad("BAD_ACTION", "transfer has min-out");
        break;
      case ActionKind.RELEASE:
        if (a.outMint !== NONE || a.routeKind !== RouteKind.NONE || a.ref !== NONE) bad("BAD_ACTION", "release has swap/recipient fields");
        if (a.feeBps !== 0) bad("BAD_ACTION", "release cannot charge a fee");
        if (a.minOut !== 0n || (a.flags & ACTION_FLAG_MIN_OUT_IS_RATE) !== 0) bad("BAD_ACTION", "release has min-out");
        break;
      default:
        bad("BAD_ACTION", `unknown action kind ${a.kind as number}`);
    }
    if (a.group !== NONE) {
      if (a.group >= LIMITS.MAX_GROUPS || a.branch >= LIMITS.MAX_BRANCHES_PER_GROUP) bad("BAD_ACTION", "branch group out of range");
    } else if (a.branch !== 0) bad("NON_CANONICAL", "branch set without group");
    switch (a.amountKind) {
      case AmountKind.FIXED:
        if (a.amount === 0n) bad("BAD_AMOUNT", "fixed amount must be positive");
        if (a.bps !== 0 || a.amountRef !== NONE) bad("NON_CANONICAL", "fixed amount has bps/ref");
        break;
      case AmountKind.BPS_OF_ALLOCATION:
        if (a.bps < 1 || a.bps > 10_000) bad("BAD_AMOUNT", "bps out of range");
        if (a.amount !== 0n || a.amountRef !== NONE) bad("NON_CANONICAL", "bps-of-allocation has amount/ref");
        break;
      case AmountKind.BPS_OF_RECEIVED: {
        if (a.bps < 1 || a.bps > 10_000) bad("BAD_AMOUNT", "bps out of range");
        const src = plan.actions[a.amountRef];
        if (!src || a.amountRef === i) bad("INDEX_OUT_OF_RANGE", "received-amount source action invalid");
        else if (src.kind !== ActionKind.SWAP) bad("BAD_AMOUNT", "received-amount source must be a swap");
        else if (src.outMint !== a.inMint) bad("BAD_AMOUNT", "received-amount source output mint must match input mint");
        break;
      }
      case AmountKind.ALL_OF_HOLDING:
        if (a.bps !== 0 || a.amountRef !== NONE) bad("NON_CANONICAL", "all-of-holding has bps/ref");
        break;
      default:
        bad("BAD_AMOUNT", "unknown amount kind");
    }
    if (a.runs < 1 || a.runs > LIMITS.MAX_RUNS) bad("BAD_SCHEDULE", "runs out of range");
    if (a.runs === 1) {
      if (a.interval !== 0 || (a.flags & ACTION_FLAG_MISSED_CATCH_UP) !== 0) bad("NON_CANONICAL", "single-run action has schedule fields");
    } else if (a.interval < LIMITS.MIN_SCHEDULE_INTERVAL_SECONDS) bad("BAD_SCHEDULE", "schedule interval too short");
    if (a.delay > LIMITS.MAX_DELAY_SECONDS) bad("BAD_SCHEDULE", "delay too long");
    if (a.deadline < 0 || (a.deadline !== 0 && a.deadline > plan.expiresAt)) bad("BAD_DEADLINE", "action deadline must be within strategy expiry");
  });
  return issues;
}

/** Effective deadline of an action: its own deadline or the strategy expiry. */
export function actionDeadline(plan: Plan, a: PlanAction): number {
  return a.deadline === 0 ? plan.expiresAt : Math.min(a.deadline, plan.expiresAt);
}

/** Chunking for upload transactions (plan bytes exceed one Solana transaction). */
export function chunkPlan(bytes: Uint8Array, chunkSize = 800): Array<{ offset: number; data: Uint8Array }> {
  const out: Array<{ offset: number; data: Uint8Array }> = [];
  for (let off = 0; off < bytes.length; off += chunkSize) out.push({ offset: off, data: bytes.slice(off, off + chunkSize) });
  return out;
}
