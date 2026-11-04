import { conditionTokens, actionVerb, type AssetInfo, type Strategy } from "@maybe/core";
import { Amount } from "../../components/Amount.tsx";
import { Icon } from "../../components/Icon.tsx";
import type { IssueIndex, Sel } from "./model.ts";

function condText(doc: Strategy, nodeId: string): string {
  return conditionTokens(doc, nodeId)
    .map((t) => ("text" in t ? t.text : t.t === "event" ? t.ref : t.t === "outcome" ? t.outcome : ""))
    .join(" ")
    .replace(/\s+([,:])/g, "$1");
}

/** Fully keyboard-accessible equivalent of the graph: every element is a row you can select and edit. */
export function ListView({ doc, assets, issues, selected, onSelect }: { doc: Strategy; assets: Map<string, AssetInfo>; issues: IssueIndex; selected: Sel | null; onSelect: (s: Sel) => void }) {
  const mark = (kind: Sel["kind"], id: string) => {
    const w = issues.worst(kind, id);
    return w ? <Icon name="alert" size={14} style={{ color: w === "error" ? "var(--c-red)" : "var(--c-amber)" }} aria-label={w === "error" ? "Has an error" : "Has a warning"} /> : null;
  };
  const row = (kind: Sel["kind"], id: string) => ({
    "aria-pressed": selected?.kind === kind && selected.id === id,
    onClick: () => onSelect({ kind, id }),
    className: "list-item",
    style: selected?.kind === kind && selected.id === id ? { background: "var(--c-s2)" } : undefined,
  });
  return (
    <div className="stack-loose">
      <section className="stack" aria-label="Steps">
        <h3 className="t-head">Steps</h3>
        <div className="panel panel-flush">
          <div className="list">
            {doc.actions.map((a, i) => {
              const mint = a.kind === "swap" ? a.inputMint : a.mint;
              return (
                <button key={a.id} type="button" {...row("action", a.id)}>
                  <span className="num faint" style={{ width: 20 }}>
                    {i + 1}
                  </span>
                  <span className="grow stack-tight" style={{ minWidth: 0 }}>
                    <span className="row-tight">
                      <span className="strong truncate">{a.label ?? actionVerb(a, (m) => assets.get(m))}</span>
                      {mark("action", a.id)}
                    </span>
                    <span className="t-small muted truncate">When {condText(doc, a.guard)}</span>
                  </span>
                  <span className="t-small nowrap" style={{ textAlign: "right" }}>
                    {a.amount.kind === "fixed" ? <Amount units={BigInt(a.amount.amount)} mint={mint} /> : a.amount.kind === "bpsOfAllocation" ? `${a.amount.bps / 100}% of allocation` : a.amount.kind === "bpsOfReceived" ? `${a.amount.bps / 100}% of proceeds` : "All held"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>
      <section className="stack" aria-label="Conditions">
        <h3 className="t-head">Conditions</h3>
        <div className="panel panel-flush">
          <div className="list">
            {doc.nodes.map((n) => (
              <button key={n.id} type="button" {...row("node", n.id)}>
                <span className="mono faint" style={{ minWidth: 64 }}>
                  {n.kind}
                </span>
                <span className="grow truncate">{condText(doc, n.id)}</span>
                {mark("node", n.id)}
              </button>
            ))}
          </div>
        </div>
      </section>
      <div className="grid-2">
        <section className="stack" aria-label="Allocations">
          <h3 className="t-head">Allocations</h3>
          <div className="panel panel-flush">
            <div className="list">
              {doc.allocations.map((a) => (
                <button key={a.id} type="button" {...row("allocation", a.id)}>
                  <span className="grow truncate">{a.label}</span>
                  {mark("allocation", a.id)}
                  <Amount units={BigInt(a.amount)} mint={a.mint} />
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="stack" aria-label="Events">
          <h3 className="t-head">Events</h3>
          <div className="panel panel-flush">
            <div className="list">
              {doc.events.map((e) => (
                <div key={e.ref} className="list-item">
                  <span className="tok-ref" style={{ background: "var(--c-s4)", color: "var(--c-text)" }}>
                    {e.ref}
                  </span>
                  <span className="grow truncate">{e.title}</span>
                  {mark("event", e.ref)}
                </div>
              ))}
              {doc.events.length === 0 && <p className="muted t-small" style={{ padding: 16 }}>No events — this future depends on receipts or time only.</p>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
