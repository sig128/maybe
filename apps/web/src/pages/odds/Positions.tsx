import { Drawer } from "../../components/Overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { liveEngine, type Position } from "../../live/engine.ts";
import { cents, solAmount } from "../../live/format.ts";
import { usePractice, useMarket } from "../../live/hooks.ts";
import { Countdown } from "./TokenRow.tsx";

function OpenRow({ p }: { p: Position }) {
  const m = useMarket(p.marketId);
  const value = liveEngine().value(p);
  const pnl = value !== null ? value - p.stake : null;
  return (
    <li className="opos">
      <span className={`oside is-${p.side.toLowerCase()}`}>{p.side === "YES" ? "Yes" : "No"}</span>
      <div className="grow stack-tight" style={{ minWidth: 0 }}>
        <strong className="t-small truncate">
          {p.symbol} · {p.question}
        </strong>
        <span className="t-micro muted">
          {solAmount(p.stake)} SOL at {cents(p.price)} · pays {solAmount(p.shares)} if right · {m && m.status === "open" ? <Countdown to={p.closesAt} /> : "settling"}
        </span>
      </div>
      <div className="stack-tight" style={{ alignItems: "flex-end" }}>
        <span className={`mono t-small${pnl === null ? "" : pnl >= 0 ? " is-up" : " is-down"}`}>{value === null ? "—" : `${solAmount(value)} SOL`}</span>
        <button
          className="btn btn-ghost btn-sm"
          disabled={value === null}
          onClick={() => {
            const v = liveEngine().sell(p.id);
            if (v !== null) toast({ title: `Sold ${p.symbol} ${p.side === "YES" ? "yes" : "no"} for ${solAmount(v)} practice SOL`, tone: "ok" });
          }}
        >
          Sell
        </button>
      </div>
    </li>
  );
}

export function PositionsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const practice = usePractice();
  const live = practice.positions.filter((p) => p.status === "open");
  const done = practice.positions.filter((p) => p.status !== "open");
  const staked = live.reduce((n, p) => n + p.stake, 0);
  const settledPnl = done.reduce((n, p) => n + ((p.payout ?? 0) - p.stake), 0);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Practice positions" subtitle="Settled by what actually happens on Solana mainnet">
      <div className="stack-loose">
        <div className="ostats-grid is-3">
          <div className="ostat">
            <span className="ostat-k">Balance</span>
            <span className="ostat-v mono">{solAmount(practice.balance)} SOL</span>
          </div>
          <div className="ostat">
            <span className="ostat-k">In open positions</span>
            <span className="ostat-v mono">{solAmount(staked)} SOL</span>
          </div>
          <div className="ostat">
            <span className="ostat-k">Settled result</span>
            <span className={`ostat-v mono${settledPnl >= 0 ? " is-up" : " is-down"}`}>
              {settledPnl >= 0 ? "+" : ""}
              {solAmount(settledPnl)} SOL
            </span>
          </div>
        </div>
        <section className="stack" aria-label="Open positions">
          <h3 className="t-head">Open</h3>
          {live.length ? (
            <ul className="olist">
              {live.map((p) => (
                <OpenRow key={p.id} p={p} />
              ))}
            </ul>
          ) : (
            <p className="muted t-small">No open positions. Tap Yes or No on any row to take a side with practice SOL.</p>
          )}
        </section>
        {done.length > 0 && (
          <section className="stack" aria-label="Settled positions">
            <h3 className="t-head">Settled</h3>
            <ul className="olist">
              {done.slice(0, 60).map((p) => (
                <li key={p.id} className="opos">
                  <span className={`oside is-${p.side.toLowerCase()}`}>{p.side === "YES" ? "Yes" : "No"}</span>
                  <div className="grow stack-tight" style={{ minWidth: 0 }}>
                    <strong className="t-small truncate">
                      {p.symbol} · {p.question}
                    </strong>
                    <span className="t-micro muted">{solAmount(p.stake)} SOL at {cents(p.price)}</span>
                  </div>
                  <span className={`oresult is-${p.status === "won" ? "yes" : p.status === "lost" ? "no" : "void"}`}>
                    {p.status === "won" ? `Won ${solAmount(p.payout ?? 0)}` : p.status === "lost" ? "Lost" : p.status === "closed" ? `Sold ${solAmount(p.payout ?? 0)}` : "Returned"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="t-micro muted">Practice SOL isn't real money and can't be withdrawn. Real-money questions need an audited on-chain market and a license first.</p>
        <button
          className="btn btn-outline btn-sm"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            liveEngine().resetPractice();
            toast({ title: "Practice balance reset to 10 SOL", tone: "ok" });
          }}
        >
          Reset practice balance
        </button>
      </div>
    </Drawer>
  );
}
