import type { TxState } from "@maybe/core";
import type { TxRecord } from "../data/types.ts";
import { TX_STATUS } from "../lib/status.ts";
import { Pill } from "./ui.tsx";

const ORDER: TxState[] = ["SIGNED", "SUBMITTED", "PROCESSED", "CONFIRMED", "FINALIZED"];
const SETTLED: TxState[] = ["CONFIRMED", "FINALIZED"];
const FAILED: TxState[] = ["FAILED", "EXPIRED"];

/** One transaction's lifecycle, as the chain reports it. Balances change only at Confirmed. */
function Lifecycle({ tx }: { tx: TxRecord }) {
  const failed = FAILED.includes(tx.state);
  const at = ORDER.indexOf(tx.state);
  return (
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
  );
}

/**
 * A single transaction shows its full lifecycle. A sequence (sent strictly in
 * order) shows one line per transaction and the lifecycle of the one in flight.
 */
export function TxSteps({ txs }: { txs: TxRecord[] }) {
  if (txs.length === 1) {
    const tx = txs[0]!;
    return (
      <div className="stack-tight" aria-live="polite">
        <span className="t-small strong">{tx.label}</span>
        <Lifecycle tx={tx} />
        {FAILED.includes(tx.state) && <p className="error-text">{tx.error ?? `${TX_STATUS[tx.state].label}. Nothing changed.`}</p>}
        {tx.simulated && <span className="t-micro faint">Simulated transaction</span>}
      </div>
    );
  }
  const current = txs.findIndex((t) => !SETTLED.includes(t.state));
  const failedAt = txs.findIndex((t) => FAILED.includes(t.state));
  return (
    <ol className="tx-seq" aria-live="polite">
      {txs.map((tx, i) => {
        const waiting = !FAILED.includes(tx.state) && failedAt < 0 && current >= 0 && i > current && tx.state === "SIGNED";
        const s = TX_STATUS[tx.state];
        return (
          <li key={tx.id} className="stack-tight">
            <div className="row">
              <span className="tx-seq-n num">{i + 1}</span>
              <span className="t-small grow">{tx.label}</span>
              {waiting ? (
                <Pill tone="quiet">Waiting</Pill>
              ) : (
                <Pill tone={s.tone} icon={s.icon}>
                  {s.label}
                </Pill>
              )}
            </div>
            {i === current && failedAt < 0 && <Lifecycle tx={tx} />}
            {FAILED.includes(tx.state) && <p className="error-text">{tx.error ?? `${s.label}. Nothing changed.`}</p>}
          </li>
        );
      })}
      {txs.some((t) => t.simulated) && <li className="t-micro faint">Simulated transactions</li>}
    </ol>
  );
}
