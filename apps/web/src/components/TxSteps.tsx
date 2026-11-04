import type { TxState } from "@maybe/core";
import type { TxRecord } from "../data/types.ts";
import { TX_STATUS } from "../lib/status.ts";

const ORDER: TxState[] = ["SIGNED", "SUBMITTED", "PROCESSED", "CONFIRMED", "FINALIZED"];

/** Transaction lifecycle, as the chain reports it. Balances change only at Confirmed. */
export function TxSteps({ txs }: { txs: TxRecord[] }) {
  return (
    <div className="stack" aria-live="polite">
      {txs.map((tx) => {
        const failed = tx.state === "FAILED" || tx.state === "EXPIRED";
        const at = ORDER.indexOf(tx.state);
        return (
          <div key={tx.id} className="stack-tight">
            <span className="t-small strong">{tx.label}</span>
            <div className="tx-steps">
              {ORDER.slice(1).map((s, i) => {
                const idx = i + 1;
                const reached = failed ? 1 : at;
                const state = failed ? (idx <= reached ? "done" : idx === reached + 1 ? "error" : "idle") : at >= idx ? "done" : at + 1 === idx ? "active" : "idle";
                return (
                  <div key={s} className="tx-step">
                    <span className="tx-dot" data-state={state} />
                    <span className={state === "idle" ? "faint" : ""}>{TX_STATUS[s].label}</span>
                    <span className="t-micro faint">{s === "CONFIRMED" ? "balances update" : s === "FINALIZED" ? "can't roll back" : ""}</span>
                  </div>
                );
              })}
            </div>
            {failed && <p className="error-text">{tx.error ?? `${TX_STATUS[tx.state].label}. Nothing changed.`}</p>}
            {tx.simulated && <span className="t-micro faint">Simulated transaction</span>}
          </div>
        );
      })}
    </div>
  );
}
