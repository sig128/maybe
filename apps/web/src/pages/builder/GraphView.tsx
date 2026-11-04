import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, applyNodeChanges, getNodesBounds, type Edge, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { actionVerb, conditionTokens, formatAmount, type AssetInfo, type Op, type PredicateNode, type Strategy } from "@maybe/core";
import { BRANCH_VARS } from "../../components/PathsDiagram.tsx";
import type { IssueIndex, Sel } from "./model.ts";

type GData = { kind: "event" | "condition" | "allocation" | "action" | "expiry"; title: string; sub?: string; sel: Sel | null; issue?: "error" | "warning"; branch?: string; delay?: string };
type GNode = Node<GData, "g">;

const KIND_LABEL: Record<GData["kind"], string> = { event: "Event", condition: "Condition", allocation: "Reserved", action: "Step", expiry: "At expiry" };

const GraphNode = memo(function GraphNode({ data, selected }: NodeProps<GNode>) {
  return (
    <div
      className={`gnode gnode-${data.kind}`}
      data-selected={selected}
      data-issue={data.issue}
      style={{ ["--branch" as string]: data.branch }}
      aria-label={`${KIND_LABEL[data.kind]}: ${data.title}${data.sub ? `, ${data.sub}` : ""}`}
    >
      {data.kind !== "event" && data.kind !== "allocation" && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <span className="gnode-kind">
        {KIND_LABEL[data.kind]}
        {data.delay && <span className="faint">· waits {data.delay}</span>}
      </span>
      <span className="strong" style={{ fontWeight: 560 }}>
        {data.title}
      </span>
      {data.sub && <span className="muted">{data.sub}</span>}
      {data.kind !== "action" && data.kind !== "expiry" && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
});

const nodeTypes = { g: GraphNode };

function nodeTitle(doc: Strategy, n: PredicateNode): string {
  switch (n.kind) {
    case "outcome":
      return `${n.event} resolves ${n.outcome}`;
    case "and":
      return "All of";
    case "or":
      return "Any of";
    case "atLeast":
      return `At least ${n.k} of ${n.children.length}`;
    case "not":
      return "Settled otherwise";
    case "veto":
      return `No ${n.event} veto within ${Math.round(n.windowSeconds / 3600)}h`;
    case "receipt":
      return n.strategy === "self" ? `After “${doc.actions.find((a) => a.id === n.action)?.label ?? n.action}”` : "After predecessor";
    case "after":
      return "After a time";
    case "always":
      return "Right away";
  }
}

function children(n: PredicateNode): string[] {
  return n.kind === "not" ? [n.child] : n.kind === "and" || n.kind === "or" || n.kind === "atLeast" ? n.children : n.kind === "veto" ? [n.trigger] : [];
}

/**
 * Lane layout: one horizontal lane per allocation, money on the left, steps on
 * the right, conditions between them at their depth, events beside the
 * conditions that read them. Positions the user drags are kept in doc.layout.
 */
export function buildGraph(doc: Strategy, assets: Map<string, AssetInfo>, issues: IssueIndex): { nodes: GNode[]; edges: Edge[] } {
  const nodes: GNode[] = [];
  const edges: Edge[] = [];
  const ROW = 92;
  const COL = 204;
  // node boxes are ≤ 220px wide; events get a wider gap so their titles never run under the leaves
  const EVENT_X = 186;
  const LEAF_X = EVENT_X + 236;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = byId.get(id);
    const v = n ? 1 + Math.max(0, ...children(n).map((c) => d(c, seen))) : 1;
    depth.set(id, v);
    return v;
  };
  doc.nodes.forEach((n) => d(n.id));
  const maxDepth = Math.max(1, ...depth.values());
  const xOf = { alloc: 0, event: EVENT_X, cond: (k: number) => LEAF_X + (k - 1) * COL, step: LEAF_X + maxDepth * COL };
  const pos = (id: string, x: number, y: number) => doc.layout?.[id] ?? { x, y };
  // rows: actions grouped by allocation lane
  const ordered = doc.allocations.flatMap((al) => doc.actions.filter((a) => a.allocation === al.id));
  const actionY = new Map<string, number>();
  let row = 0;
  doc.allocations.forEach((al, li) => {
    const lane = ordered.filter((a) => a.allocation === al.id);
    const start = row;
    lane.forEach((a) => actionY.set(a.id, row++ * ROW));
    const laneMid = ((start + Math.max(start, row - 1)) / 2) * ROW;
    const asset = assets.get(al.mint);
    const id = `al:${al.id}`;
    nodes.push({
      id,
      type: "g",
      position: pos(id, xOf.alloc, laneMid),
      data: { kind: "allocation", title: `${asset ? formatAmount(BigInt(al.amount), asset.decimals, { minFraction: 0, maxFraction: 2 }) : al.amount} ${asset?.symbol ?? ""}`, sub: al.label, sel: { kind: "allocation", id: al.id }, branch: BRANCH_VARS[li % 4], ...(issues.worst("allocation", al.id) ? { issue: issues.worst("allocation", al.id)! } : {}) },
    });
    row += 0.35; // breathing room between lanes
  });
  // condition y = mean of what it feeds (actions or parents), computed top-down from guards
  const condY = new Map<string, number[]>();
  const push = (id: string, y: number) => condY.set(id, [...(condY.get(id) ?? []), y]);
  doc.actions.forEach((a) => push(a.guard, actionY.get(a.id) ?? 0));
  const order = [...doc.nodes].sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0));
  const placed = new Map<string, number>();
  for (const n of order) {
    const ys = condY.get(n.id) ?? [0];
    const y = ys.reduce((s, v) => s + v, 0) / ys.length;
    placed.set(n.id, y);
    const kids = children(n);
    kids.forEach((c, k) => push(c, y + (k - (kids.length - 1) / 2) * ROW * 0.9));
  }
  // de-overlap within each depth column
  const byCol = new Map<number, Array<{ id: string; y: number }>>();
  for (const [id, y] of placed) {
    const c = depth.get(id) ?? 1;
    byCol.set(c, [...(byCol.get(c) ?? []), { id, y }]);
  }
  for (const list of byCol.values()) {
    list.sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i++) if (list[i]!.y - list[i - 1]!.y < ROW * 0.85) list[i]!.y = list[i - 1]!.y + ROW * 0.85;
    list.forEach((e) => placed.set(e.id, e.y));
  }
  doc.nodes.forEach((n) => {
    const id = `n:${n.id}`;
    const c = depth.get(n.id) ?? 1;
    nodes.push({ id, type: "g", position: pos(id, xOf.cond(c), placed.get(n.id) ?? 0), data: { kind: "condition", title: nodeTitle(doc, n), sel: { kind: "node", id: n.id }, ...(issues.worst("node", n.id) ? { issue: issues.worst("node", n.id)! } : {}) } });
    children(n).forEach((ch) => edges.push({ id: `e:${ch}->${n.id}`, source: `n:${ch}`, target: id }));
  });
  // events sit just left of the first leaf that reads them, never on top of each other (titles wrap to 2 lines)
  const eventY = new Map<string, number>();
  doc.events
    .map((e, i) => {
      const ys = doc.nodes.filter((n) => (n.kind === "outcome" || n.kind === "veto") && n.event === e.ref).map((l) => placed.get(l.id) ?? 0);
      return { ref: e.ref, y: ys.length ? Math.min(...ys) : i * ROW };
    })
    .sort((a, b) => a.y - b.y)
    .forEach((e, i, list) => eventY.set(e.ref, i > 0 ? Math.max(e.y, eventY.get(list[i - 1]!.ref)! + ROW * 1.25) : e.y));
  doc.events.forEach((e, i) => {
    const leaves = doc.nodes.filter((n) => (n.kind === "outcome" || n.kind === "veto") && n.event === e.ref);
    const id = `ev:${e.ref}`;
    nodes.push({ id, type: "g", position: pos(id, xOf.event, eventY.get(e.ref) ?? i * ROW), data: { kind: "event", title: `${e.ref} · ${e.title}`, sub: e.adapter === "attestation" ? "Trusted attestation" : "Objective, on-chain", sel: { kind: "event", id: e.ref }, branch: BRANCH_VARS[i % 4], ...(issues.worst("event", e.ref) ? { issue: issues.worst("event", e.ref)! } : {}) } });
    leaves.forEach((l) => edges.push({ id: `e:${e.ref}->${l.id}`, source: id, target: `n:${l.id}`, style: { stroke: "var(--c-line-3)" } }));
  });
  // events and leaves share a column band; shift leaves right of events when they collide
  doc.actions.forEach((a) => {
    const id = `ac:${a.id}`;
    const ai = doc.allocations.findIndex((x) => x.id === a.allocation);
    const inMint = a.kind === "swap" ? a.inputMint : a.mint;
    nodes.push({
      id,
      type: "g",
      position: pos(id, xOf.step, actionY.get(a.id) ?? 0),
      data: {
        kind: "action",
        title: a.label ?? actionVerb(a, (m) => assets.get(m)),
        sub: a.amount.kind === "fixed" ? `${formatAmount(BigInt(a.amount.amount), assets.get(inMint)?.decimals ?? 6, { minFraction: 0, maxFraction: 2 })} ${assets.get(inMint)?.symbol ?? ""}` : a.amount.kind === "bpsOfAllocation" ? `${a.amount.bps / 100}% of allocation` : a.amount.kind === "bpsOfReceived" ? `${a.amount.bps / 100}% of proceeds` : "All held",
        sel: { kind: "action", id: a.id },
        branch: BRANCH_VARS[ai % 4],
        ...(a.delaySeconds ? { delay: `${Math.round(a.delaySeconds / 3600)}h` } : {}),
        ...(issues.worst("action", a.id) ? { issue: issues.worst("action", a.id)! } : {}),
      },
    });
    edges.push({ id: `e:g:${a.guard}->${a.id}`, source: `n:${a.guard}`, target: id, ...(a.delaySeconds ? { label: `waits ${Math.round(a.delaySeconds / 3600)}h`, labelStyle: { fill: "var(--c-text-2)", fontSize: 11 }, labelBgStyle: { fill: "var(--c-s1)" } } : {}) });
    edges.push({ id: `e:al:${a.allocation}->${a.id}`, source: `al:${a.allocation}`, target: id, type: "smoothstep", style: { stroke: BRANCH_VARS[ai % 4], strokeDasharray: "3 5", opacity: 0.55 } });
  });
  const ex = "expiry";
  nodes.push({ id: ex, type: "g", position: pos(ex, xOf.step, row * ROW + ROW * 0.2), data: { kind: "expiry", title: "Unspent returns to available", sub: new Date(doc.expiresAt * 1000).toUTCString().slice(5, 16), sel: { kind: "strategy", id: "strategy" } } });
  return { nodes, edges };
}

export default function GraphView({ doc, assets, issues, selected, onSelect, onOp, readOnly }: { doc: Strategy; assets: Map<string, AssetInfo>; issues: IssueIndex; selected: Sel | null; onSelect: (s: Sel) => void; onOp: (op: Op) => void; readOnly?: boolean }) {
  const built = useMemo(() => buildGraph(doc, assets, issues), [doc, assets, issues]);
  const [nodes, setNodes] = useState<GNode[]>(built.nodes);
  useEffect(() => {
    setNodes(built.nodes.map((n) => ({ ...n, selected: !!n.data.sel && selected?.kind === n.data.sel.kind && selected.id === n.data.sel.id })));
  }, [built, selected]);
  const onNodesChange = useCallback((changes: NodeChange<GNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const wrap = useRef<HTMLDivElement>(null);
  /** Fit the whole plan when it's legible; otherwise keep a readable zoom and start from the money on the left. */
  const onInit = useCallback((rf: ReactFlowInstance<GNode>) => {
    const el = wrap.current;
    if (!el) return;
    const b = getNodesBounds(rf.getNodes());
    const W = el.clientWidth;
    const H = el.clientHeight;
    const fit = Math.min(1, (W * 0.9) / Math.max(1, b.width), (H * 0.9) / Math.max(1, b.height));
    const z = Math.max(fit, 0.72);
    const x = z === fit ? (W - b.width * z) / 2 - b.x * z : 28 - b.x * z;
    const y = b.height * z < H ? (H - b.height * z) / 2 - b.y * z : 28 - b.y * z;
    rf.setViewport({ x, y, zoom: z });
  }, []);
  return (
    <div ref={wrap} className="flow-wrap" aria-label="Graph view. The list view is an equivalent you can use with a keyboard or screen reader." role="region">
      <ReactFlow<GNode>
        nodes={nodes}
        edges={built.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => n.data.sel && onSelect(n.data.sel)}
        onNodeDragStop={(_, n) => !readOnly && onOp({ op: "setLayout", id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })}
        nodesDraggable={!readOnly}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        snapToGrid
        snapGrid={[10, 10]}
        onInit={onInit}
        minZoom={0.3}
        maxZoom={1.6}
        colorMode="dark"
      >
        <Background gap={20} size={1} color="rgb(241 243 236 / 0.06)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeColor="rgb(241 243 236 / 0.25)" maskColor="rgb(12 13 12 / 0.6)" />
      </ReactFlow>
    </div>
  );
}

export { conditionTokens };
