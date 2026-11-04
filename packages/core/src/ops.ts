import type { Action, AmountSpec, EventRef, PredicateNode, Strategy } from "./schema.ts";

/**
 * Pure document operations. Every editor (sentence chips, graph, list, agents)
 * edits through these, so there is exactly one representation and one history.
 * Any operation that changes execution yields a new document; if the previous
 * document was authorized, the caller bumps the version (requiring a new signature).
 */

export type Op =
  | { op: "setTitle"; title: string }
  | { op: "setThesis"; thesis: string }
  | { op: "setExpiry"; expiresAt: number }
  | { op: "setAllocationAmount"; allocationId: string; amount: string }
  | { op: "setAllocationLabel"; allocationId: string; label: string }
  | { op: "setOutcome"; nodeId: string; outcome: "YES" | "NO" }
  | { op: "setNodeEvent"; nodeId: string; ref: string }
  | { op: "replaceEvent"; ref: string; event: EventRef }
  | { op: "addEvent"; event: EventRef }
  | { op: "setActionAmount"; actionId: string; amount: AmountSpec }
  | { op: "setActionOutput"; actionId: string; outputMint: string; pool: string; minOut: Action extends infer _ ? { kind: "absolute"; amount: string } | { kind: "rate"; outPerInE9: string } : never }
  | { op: "setActionDelay"; actionId: string; delaySeconds: number }
  | { op: "setActionDeadline"; actionId: string; deadline?: number }
  | { op: "setActionLabel"; actionId: string; label: string }
  | { op: "setActionGuard"; actionId: string; guard: string }
  | { op: "setThreshold"; nodeId: string; k: number }
  | { op: "setVetoWindow"; nodeId: string; windowSeconds: number }
  | { op: "addNode"; node: PredicateNode }
  | { op: "removeNode"; nodeId: string }
  | { op: "addAction"; action: Action }
  | { op: "removeAction"; actionId: string }
  | { op: "setLayout"; id: string; x: number; y: number };

/** Operations that only affect presentation never invalidate an authorization. */
export function affectsExecution(op: Op): boolean {
  return op.op !== "setLayout" && op.op !== "setTitle" && op.op !== "setThesis" && op.op !== "setAllocationLabel" && op.op !== "setActionLabel";
}

function mapAction(doc: Strategy, id: string, f: (a: Action) => Action): Strategy {
  return { ...doc, actions: doc.actions.map((a) => (a.id === id ? f(a) : a)) };
}

function mapNode(doc: Strategy, id: string, f: (n: PredicateNode) => PredicateNode): Strategy {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? f(n) : n)) };
}

export function nextEventRef(doc: Strategy): string {
  for (let i = 0; i < 26; i++) {
    const r = String.fromCharCode(65 + i);
    if (!doc.events.some((e) => e.ref === r)) return r;
  }
  return `E${doc.events.length + 1}`;
}

export function uniqueId(doc: Strategy, prefix: string): string {
  const used = new Set([...doc.nodes.map((n) => n.id), ...doc.actions.map((a) => a.id), ...doc.allocations.map((a) => a.id)]);
  for (let i = 1; i < 1000; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return `${prefix}${Date.now()}`;
}

export function applyOp(doc: Strategy, op: Op): Strategy {
  switch (op.op) {
    case "setTitle":
      return { ...doc, title: op.title };
    case "setThesis":
      return { ...doc, thesis: op.thesis };
    case "setExpiry":
      return { ...doc, expiresAt: op.expiresAt };
    case "setAllocationAmount":
      return { ...doc, allocations: doc.allocations.map((a) => (a.id === op.allocationId ? { ...a, amount: op.amount } : a)) };
    case "setAllocationLabel":
      return { ...doc, allocations: doc.allocations.map((a) => (a.id === op.allocationId ? { ...a, label: op.label } : a)) };
    case "setOutcome":
      return mapNode(doc, op.nodeId, (n) => (n.kind === "outcome" || n.kind === "veto" ? { ...n, outcome: op.outcome } : n));
    case "setNodeEvent":
      return mapNode(doc, op.nodeId, (n) => (n.kind === "outcome" || n.kind === "veto" ? { ...n, event: op.ref } : n));
    case "replaceEvent":
      return { ...doc, events: doc.events.map((e) => (e.ref === op.ref ? { ...op.event, ref: op.ref } : e)) };
    case "addEvent":
      return { ...doc, events: [...doc.events, op.event] };
    case "setActionAmount":
      return mapAction(doc, op.actionId, (a) => ({ ...a, amount: op.amount }));
    case "setActionOutput":
      return mapAction(doc, op.actionId, (a) => (a.kind === "swap" ? { ...a, outputMint: op.outputMint, route: { ...a.route, pool: op.pool }, minOut: op.minOut } : a));
    case "setActionDelay":
      return mapAction(doc, op.actionId, (a) => ({ ...a, delaySeconds: op.delaySeconds }));
    case "setActionDeadline":
      return mapAction(doc, op.actionId, (a) => {
        const { deadline: _d, ...rest } = a;
        return (op.deadline ? { ...rest, deadline: op.deadline } : rest) as Action;
      });
    case "setActionLabel":
      return mapAction(doc, op.actionId, (a) => ({ ...a, label: op.label }));
    case "setActionGuard":
      return mapAction(doc, op.actionId, (a) => ({ ...a, guard: op.guard }));
    case "setThreshold":
      return mapNode(doc, op.nodeId, (n) => (n.kind === "atLeast" ? { ...n, k: op.k } : n));
    case "setVetoWindow":
      return mapNode(doc, op.nodeId, (n) => (n.kind === "veto" ? { ...n, windowSeconds: op.windowSeconds } : n));
    case "addNode":
      return { ...doc, nodes: [...doc.nodes, op.node] };
    case "removeNode":
      return { ...doc, nodes: doc.nodes.filter((n) => n.id !== op.nodeId) };
    case "addAction":
      return { ...doc, actions: [...doc.actions, op.action] };
    case "removeAction":
      return { ...doc, actions: doc.actions.filter((a) => a.id !== op.actionId) };
    case "setLayout":
      return { ...doc, layout: { ...(doc.layout ?? {}), [op.id]: { x: op.x, y: op.y } } };
  }
}

/** A new version that must be re-authorized: new nonce, version + 1, supersedes the old id. */
export function newVersion(doc: Strategy, nonce: string): Strategy {
  return { ...doc, version: doc.version + 1, nonce, meta: { ...(doc.meta ?? {}), supersedes: `${doc.id}@${doc.version}` } };
}

/** Undo/redo history over documents. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(public present: T, private readonly limit = 200) {}
  push(next: T) {
    if (next === this.present) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.future = [];
  }
  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.present);
    this.present = prev;
    return true;
  }
  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.present);
    this.present = next;
    return true;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
