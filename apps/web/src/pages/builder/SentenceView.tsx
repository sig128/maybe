import { toSentence, type AssetInfo, type SentenceToken, type Strategy, type Op } from "@maybe/core";
import { BRANCH_VARS } from "../../components/PathsDiagram.tsx";
import type { IssueIndex, Sel } from "./model.ts";

export function SentenceView({
  doc,
  assets,
  issues,
  selected,
  onSelect,
  onOp,
  readOnly,
}: {
  doc: Strategy;
  assets: Map<string, AssetInfo>;
  issues: IssueIndex;
  selected: Sel | null;
  onSelect: (s: Sel) => void;
  onOp: (op: Op) => void;
  readOnly?: boolean;
}) {
  const model = toSentence(doc, (m) => assets.get(m));
  const refColor = (ref: string) => BRANCH_VARS[doc.events.findIndex((e) => e.ref === ref) % BRANCH_VARS.length] ?? "var(--c-s4)";
  const isSel = (kind: Sel["kind"], id?: string) => !!id && selected?.kind === kind && selected.id === id;
  const tokenIssue = (t: SentenceToken): "error" | "warning" | undefined => {
    switch (t.t) {
      case "event":
      case "outcome":
      case "condition":
        return issues.worst("node", t.nodeId);
      case "amount":
        return issues.worst("allocation", t.allocationId) ?? (t.actionId ? issues.worst("action", t.actionId) : undefined);
      case "action":
        return issues.worst("action", t.actionId);
      case "fallback":
        return t.actionId ? issues.worst("action", t.actionId) : undefined;
      case "deadline":
        return issues.worst("strategy", "strategy");
      default:
        return undefined;
    }
  };
  const render = (t: SentenceToken, i: number) => {
    const issue = tokenIssue(t);
    const common = { "data-issue": issue, disabled: readOnly && t.t !== "event" } as const;
    switch (t.t) {
      case "kw":
        return (
          <span key={i} className="tok-kw">
            {t.text}
          </span>
        );
      case "text":
        return (
          <span key={i} className="tok-text">
            {t.text}
          </span>
        );
      case "event":
        return (
          <button key={i} type="button" className="tok tok-event" data-selected={isSel("node", t.nodeId)} {...common} onClick={() => onSelect({ kind: "node", id: t.nodeId })} aria-label={`Event ${t.ref}: ${t.title}. Change event`}>
            <span className="tok-ref" style={{ ["--branch" as string]: refColor(t.ref) }}>
              {t.ref}
            </span>
            <span>{t.title}</span>
          </button>
        );
      case "outcome":
        return (
          <button
            key={i}
            type="button"
            className="tok tok-outcome"
            {...common}
            aria-label={`Outcome ${t.outcome}. Switch to ${t.outcome === "YES" ? "NO" : "YES"}`}
            onClick={() => !readOnly && onOp({ op: "setOutcome", nodeId: t.nodeId, outcome: t.outcome === "YES" ? "NO" : "YES" })}
          >
            {t.outcome}
          </button>
        );
      case "amount":
        return (
          <button key={i} type="button" className="tok tok-amount" data-selected={isSel("allocation", t.allocationId) || isSel("action", t.actionId)} {...common} onClick={() => onSelect(t.actionId ? { kind: "action", id: t.actionId } : { kind: "allocation", id: t.allocationId })} aria-label={`Amount ${t.text}. Edit`}>
            {t.text}
          </button>
        );
      case "action":
        return (
          <button key={i} type="button" className="tok" data-selected={isSel("action", t.actionId)} {...common} onClick={() => onSelect({ kind: "action", id: t.actionId })} aria-label={`Action: ${t.text}. Edit`}>
            {t.text}
          </button>
        );
      case "condition":
        return (
          <button key={i} type="button" className="tok" data-selected={isSel("node", t.nodeId)} {...common} onClick={() => onSelect({ kind: "node", id: t.nodeId })}>
            {t.text}
          </button>
        );
      case "fallback":
        return (
          <button key={i} type="button" className="tok" data-selected={isSel("action", t.actionId)} {...common} onClick={() => onSelect(t.actionId ? { kind: "action", id: t.actionId } : { kind: "strategy", id: "strategy" })}>
            {t.text}
          </button>
        );
      case "deadline":
        return (
          <button key={i} type="button" className="tok" data-selected={isSel("strategy", "strategy")} {...common} onClick={() => onSelect({ kind: "strategy", id: "strategy" })} aria-label={`Deadline ${t.text}. Edit expiry`}>
            {t.text}
          </button>
        );
    }
  };
  return (
    <div className="stack-loose">
      {model.clauses.map((c, ci) => {
        const ai = doc.allocations.findIndex((a) => a.id === c.allocationId);
        const al = doc.allocations[ai];
        return (
          <div key={`${c.allocationId}-${c.guardId}`} className="clause" style={{ ["--branch" as string]: BRANCH_VARS[ai % BRANCH_VARS.length] }}>
            {!model.simple && al && (
              <p className="t-small muted" style={{ marginBottom: 4 }}>
                {al.label}
              </p>
            )}
            <p className={`sentence ${model.clauses.length > 2 ? "sentence-small" : ""}`}>{c.tokens.map(render)}</p>
            {ci === model.clauses.length - 1 && model.footer.length > 0 && <p className="sentence sentence-small" style={{ marginTop: 6 }}>{model.footer.map(render)}</p>}
          </div>
        );
      })}
      {model.clauses.length === 0 && <p className="muted">This future has no steps yet. Add one from the panel.</p>}
    </div>
  );
}
