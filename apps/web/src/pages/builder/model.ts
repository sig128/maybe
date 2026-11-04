import type { Issue, Strategy } from "@maybe/core";

export type Sel = { kind: "node" | "action" | "allocation" | "event" | "strategy"; id: string };

/** Which allocation a node or action belongs to — used for branch identity colors. */
export function allocationIndexFor(doc: Strategy, sel: Sel): number {
  if (sel.kind === "allocation") return doc.allocations.findIndex((a) => a.id === sel.id);
  if (sel.kind === "action") {
    const a = doc.actions.find((x) => x.id === sel.id);
    return a ? doc.allocations.findIndex((al) => al.id === a.allocation) : -1;
  }
  if (sel.kind === "node") {
    const user = doc.actions.find((a) => a.guard === sel.id);
    return user ? doc.allocations.findIndex((al) => al.id === user.allocation) : -1;
  }
  return -1;
}

export interface IssueIndex {
  forTarget(kind: Sel["kind"], id: string): Issue | undefined;
  worst(kind: Sel["kind"], id: string): "error" | "warning" | undefined;
  errors: Issue[];
  warnings: Issue[];
  infos: Issue[];
}

export function indexIssues(issues: Issue[]): IssueIndex {
  const by = new Map<string, Issue[]>();
  for (const i of issues) {
    const k = `${i.target.kind}:${i.target.id ?? ""}`;
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  const get = (kind: string, id: string) => by.get(`${kind}:${id}`) ?? [];
  return {
    forTarget: (kind, id) => get(kind, id).sort((a, b) => sev(a) - sev(b))[0],
    worst: (kind, id) => {
      const l = get(kind, id);
      if (l.some((i) => i.severity === "error")) return "error";
      if (l.some((i) => i.severity === "warning")) return "warning";
      return undefined;
    },
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
    infos: issues.filter((i) => i.severity === "info"),
  };
}

function sev(i: Issue) {
  return i.severity === "error" ? 0 : i.severity === "warning" ? 1 : 2;
}

export function selFromIssue(i: Issue): Sel | null {
  if (!i.target.id && i.target.kind !== "strategy") return null;
  return { kind: i.target.kind, id: i.target.id ?? "strategy" };
}
