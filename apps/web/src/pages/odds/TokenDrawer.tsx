import { useMemo, useState } from "react";
import { Drawer } from "../../components/Overlay.tsx";
import { Icon } from "../../components/Icon.tsx";
import { toast } from "../../components/Toast.tsx";
import { liveEngine, type LiveToken, type Market } from "../../live/engine.ts";
import { linePrice } from "../../live/model.ts";
import { age, cents, count, odds, pct, shortAddr, solAmount, usdCompact } from "../../live/format.ts";
import { useClock, useHistoryVersion, useLiveStatus, useLiveToken, useMarket, useMarketIds, usePractice } from "../../live/hooks.ts";
import { Countdown, Links, placeBet, TokenAvatar } from "./TokenRow.tsx";

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast({ title: `${what} copied`, tone: "ok" }),
    () => toast({ title: `Couldn't copy the ${what.toLowerCase()}`, tone: "error" }),
  );
}

function Chart({ mint, solUsd }: { mint: string; solUsd: number | null }) {
  useHistoryVersion(mint);
  const h = liveEngine().historyFor(mint);
  const W = 560;
  const H = 150;
  const pts = h.slice(-300);
  if (pts.length < 2) return <div className="ochart-empty">Market cap appears here as trades arrive.</div>;
  const t0 = pts[0]![0];
  const t1 = pts[pts.length - 1]![0];
  const vals = pts.map((p) => p[1] * (solUsd ?? 1));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  // the axis spans at least 10% of the value, so a 1% wiggle doesn't draw like a crash
  const span = Math.max(hi - lo, ((hi + lo) / 2) * 0.1) || 1;
  const base = (hi + lo) / 2 - span / 2;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - 8 - ((v - base) / span) * (H - 16);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(vals[i]!).toFixed(1)}`).join("");
  const up = vals[vals.length - 1]! >= vals[0]!;
  return (
    <figure className="ochart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Market cap from ${usdCompact(vals[0])} to ${usdCompact(vals[vals.length - 1])} since this page started watching`}>
        <path d={`${line}L${W},${H}L0,${H}Z`} className={`ochart-fill${up ? "" : " is-down"}`} />
        <path d={line} className={`ochart-line${up ? "" : " is-down"}`} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="ochart-cap">
        <span>{usdCompact(hi)} high</span>
        <span>{usdCompact(lo)} low</span>
        <span>since this page started watching</span>
      </figcaption>
    </figure>
  );
}

function Question({ id, symbol, stake }: { id: string; symbol: string; stake: number }) {
  const m = useMarket(id);
  const [amount, setAmount] = useState(String(stake));
  if (!m) return null;
  const s = Number(amount);
  const valid = Number.isFinite(s) && s > 0;
  return (
    <div className={`oqcard is-${m.status}`}>
      <div className="oqcard-head">
        <strong>{m.question}</strong>
        {m.status === "open" ? <Countdown to={m.closesAt} /> : <span className={`oresult is-${m.status}`}>{m.status === "yes" ? "Resolved yes" : m.status === "no" ? "Resolved no" : "Void"}</span>}
      </div>
      <div className="oqcard-line">
        <span className="oqcard-odds">{m.status === "open" ? odds(m.p) : m.status === "yes" ? "100%" : m.status === "no" ? "0%" : "—"}</span>
        <span className="obar is-wide" aria-hidden="true">
          <i style={{ width: `${Math.round(m.p * 1000) / 10}%` }} />
        </span>
      </div>
      {m.note && <p className="t-small muted">{m.note}</p>}
      {m.status === "open" && (
        <div className="oqcard-trade">
          <label className="oqcard-stake">
            <span className="sr-only">Stake in practice SOL</span>
            <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} aria-label="Stake in practice SOL" />
            <span className="muted t-small">SOL</span>
          </label>
          <button className="obtn obtn-yes is-big" disabled={!valid} onClick={() => placeBet(m, "YES", s, symbol)}>
            <span>Yes</span>
            <span className="mono">{cents(linePrice(m.p, "YES"))}</span>
          </button>
          <button className="obtn obtn-no is-big" disabled={!valid} onClick={() => placeBet(m, "NO", s, symbol)}>
            <span>No</span>
            <span className="mono">{cents(linePrice(m.p, "NO"))}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: "warn" | "ok" }) {
  return (
    <div className={`ostat${tone ? ` is-${tone}` : ""}`}>
      <span className="ostat-k">{k}</span>
      <span className="ostat-v mono">{v}</span>
    </div>
  );
}

function Body({ t, stake }: { t: LiveToken; stake: number }) {
  const status = useLiveStatus();
  const now = useClock();
  const ids = useMarketIds(t.mint);
  const practice = usePractice();
  const mine = practice.positions.filter((p) => p.mint === t.mint);
  const s = t.stats;
  const markets = useMemo(() => (ids ? ids.split("|") : []), [ids]);
  const links: Array<[string, string]> = [
    ["pump.fun", `https://pump.fun/coin/${t.mint}`],
    ["Solscan", `https://solscan.io/token/${t.mint}`],
    ["DexScreener", `https://dexscreener.com/solana/${t.mint}`],
  ];
  return (
    <div className="stack-loose otoken">
      <div className="otoken-head">
        <TokenAvatar t={t} size={64} />
        <div className="stack-tight grow" style={{ minWidth: 0 }}>
          <div className="row-tight" style={{ flexWrap: "wrap" }}>
            <strong className="t-title">{t.symbol}</strong>
            <Links t={t} />
          </div>
          <span className="muted truncate">{t.name}</span>
          <span className="t-small muted">
            {t.stage === "graduated" ? `Graduated ${t.graduatedAt ? `${age(t.graduatedAt, now)} ago` : ""}` : `Launched ${age(t.createdAt, now)} ago · ${Math.floor((t.progress ?? 0) * 100)}% of the curve filled`}
          </span>
        </div>
        <div className="otoken-mc">
          <span className="mono t-title">{usdCompact(t.mcapUsd)}</span>
          <span className="t-small muted">market cap</span>
        </div>
      </div>
      {t.description && <p className="t-small muted otoken-desc">{t.description}</p>}

      <Chart mint={t.mint} solUsd={status.solUsd} />

      {t.stage !== "graduated" && (
        <div className="ocurve">
          <div className="row t-small" style={{ justifyContent: "space-between" }}>
            <span>Bonding curve</span>
            <span className="mono muted">
              {t.realSol !== undefined ? `${solAmount(t.realSol, 1)} SOL in` : ""}
              {t.remainingSol !== undefined ? ` · ${solAmount(t.remainingSol, 1)} SOL to graduate` : ""}
            </span>
          </div>
          <span className="obar is-wide is-curve" aria-hidden="true">
            <i style={{ width: `${Math.round((t.progress ?? 0) * 1000) / 10}%` }} />
          </span>
        </div>
      )}

      <section className="stack" aria-label="Questions">
        <h3 className="t-head">Questions</h3>
        {markets.length ? markets.map((id) => <Question key={id} id={id} symbol={t.symbol} stake={stake} />) : <p className="muted t-small">No open questions for this token right now.</p>}
        <p className="t-micro muted">Odds are MAYBE's live line: a model of the curve's SOL flow and the token's price path, updated every second. They aren't a market price yet. Positions use practice SOL and settle on what actually happens on-chain.</p>
      </section>

      {mine.length > 0 && (
        <section className="stack" aria-label="Your positions on this token">
          <h3 className="t-head">Your positions</h3>
          <ul className="olist">
            {mine.map((p) => (
              <li key={p.id} className="row t-small">
                <span className={`oside is-${p.side.toLowerCase()}`}>{p.side === "YES" ? "Yes" : "No"}</span>
                <span className="grow truncate">{p.question}</span>
                <span className="mono">{solAmount(p.stake)} SOL</span>
                <span className={`oresult is-${p.status === "won" ? "yes" : p.status === "lost" ? "no" : p.status === "open" ? "open" : "void"}`}>{p.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ostats-grid" aria-label="Token data">
        <Stat k="Holders" v={count(s?.holders)} />
        <Stat k="Top 10 hold" v={pct(s?.top10Pct)} {...(s?.top10Pct !== undefined && s.top10Pct >= 40 ? { tone: "warn" as const } : {})} />
        <Stat k="Dev holds" v={s?.devPct !== undefined ? pct(s.devPct, 1) : t.devBuyPct !== undefined ? `${pct(t.devBuyPct, 1)} at launch` : "—"} {...((s?.devPct ?? t.devBuyPct ?? 0) >= 10 ? { tone: "warn" as const } : {})} />
        <Stat k="Liquidity" v={usdCompact(s?.liquidityUsd)} />
        <Stat k="5m volume" v={usdCompact(s?.vol5mUsd)} />
        <Stat k="5m buys / sells" v={s?.buys5m !== undefined ? `${count(s.buys5m)} / ${count(s.sells5m)}` : "—"} />
        <Stat k="5m traders" v={count(s?.traders5m)} />
        <Stat k="1h volume" v={usdCompact(s?.vol1hUsd)} />
        <Stat k="Mint authority" v={s?.mintRevoked === undefined ? "—" : s.mintRevoked ? "Revoked" : "Active"} {...(s?.mintRevoked === false ? { tone: "warn" as const } : {})} />
        <Stat k="Freeze authority" v={s?.freezeRevoked === undefined ? "—" : s.freezeRevoked ? "Revoked" : "Active"} {...(s?.freezeRevoked === false ? { tone: "warn" as const } : {})} />
        <Stat k="Dev launches" v={count(s?.devLaunches)} />
        <Stat k="Dev graduations" v={count(s?.devGraduations)} />
      </section>

      <section className="stack-tight t-small">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">Mint</span>
          <button className="ocopy mono" onClick={() => copy(t.mint, "Mint address")}>
            {shortAddr(t.mint)} <Icon name="copy" size={13} />
          </button>
        </div>
        {t.creator && (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">Creator</span>
            <button className="ocopy mono" onClick={() => copy(t.creator!, "Creator address")}>
              {shortAddr(t.creator)} <Icon name="copy" size={13} />
            </button>
          </div>
        )}
        <div className="row olinks-row">
          {links.map(([label, href]) => (
            <a key={label} className="btn btn-outline btn-sm" href={href} target="_blank" rel="noopener noreferrer">
              {label} <Icon name="external" size={13} />
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

export function TokenDrawer({ mint, stake, onClose }: { mint: string | null; stake: number; onClose: () => void }) {
  const t = useLiveToken(mint ?? "");
  return (
    <Drawer open={!!mint} onOpenChange={(o) => !o && onClose()} title={t ? `${t.symbol} · ${t.name}` : "Token"} subtitle={t ? (t.stage === "graduated" ? "Trading on PumpSwap" : t.stage === "stretch" ? "Final stretch on the bonding curve" : "On the bonding curve") : undefined}>
      {t ? <Body t={t} stake={stake} /> : <p className="muted">This token left the board.</p>}
    </Drawer>
  );
}

export type { Market };
