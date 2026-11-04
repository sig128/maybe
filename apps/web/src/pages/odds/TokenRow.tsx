import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { Icon } from "../../components/Icon.tsx";
import { liveEngine, type LiveToken, type Market } from "../../live/engine.ts";
import { linePrice } from "../../live/model.ts";
import { age, cents, count, countdown, monoHue, odds, pct, safeUrl, usdCompact, xUrl } from "../../live/format.ts";
import { useClock, useHeadline, useLiveToken } from "../../live/hooks.ts";
import { toast } from "../../components/Toast.tsx";

export const ROW_H = 112;
/** Phones: the Yes and No buttons get a full-width row of their own, big enough for a thumb. */
export const ROW_H_COMPACT = 152;

export function TokenAvatar({ t, size = 48 }: { t: Pick<LiveToken, "mint" | "symbol" | "image" | "progress" | "stage">; size?: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  const ring = size + 10;
  const r = ring / 2 - 2;
  const c = 2 * Math.PI * r;
  const progress = t.stage === "graduated" ? 1 : Math.max(0, Math.min(1, t.progress ?? 0));
  const showImg = t.image && broken !== t.image;
  return (
    <span className="oavatar" style={{ width: ring, height: ring }} aria-hidden="true">
      <svg width={ring} height={ring} viewBox={`0 0 ${ring} ${ring}`}>
        <circle cx={ring / 2} cy={ring / 2} r={r} className="oavatar-track" />
        <circle cx={ring / 2} cy={ring / 2} r={r} className={`oavatar-arc${t.stage === "graduated" ? " is-done" : progress >= 0.85 ? " is-hot" : ""}`} strokeDasharray={`${c * progress} ${c}`} transform={`rotate(-90 ${ring / 2} ${ring / 2})`} />
      </svg>
      {showImg ? (
        <img src={t.image} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(t.image!)} style={{ width: size, height: size }} />
      ) : (
        <span className="oavatar-mono" style={{ width: size, height: size, background: `hsl(${monoHue(t.mint)} 22% 22%)`, fontSize: size * 0.38 }}>
          {(t.symbol || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?"}
        </span>
      )}
    </span>
  );
}

function Age({ from }: { from: number }) {
  const now = useClock();
  const fresh = now - from < 60_000;
  return <span className={`oage${fresh ? " is-fresh" : ""}`}>{age(from, now)}</span>;
}

export function Countdown({ to }: { to: number }) {
  const now = useClock();
  const left = to - now;
  return <span className={`ocount${left < 60_000 ? " is-soon" : ""}`}>{left > 0 ? countdown(to, now) : "closing"}</span>;
}

export function Links({ t }: { t: Pick<LiveToken, "twitter" | "telegram" | "website" | "symbol"> }) {
  const x = xUrl(t.twitter);
  const tg = safeUrl(t.telegram);
  const web = safeUrl(t.website);
  if (!x && !tg && !web) return null;
  return (
    <span className="olinks">
      {x && (
        <a href={x} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${t.symbol} on X`}>
          <Icon name="x" size={13} />
        </a>
      )}
      {tg && (
        <a href={tg} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${t.symbol} on Telegram`}>
          <Icon name="telegram" size={13} />
        </a>
      )}
      {web && (
        <a href={web} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${t.symbol} website`}>
          <Icon name="globe" size={13} />
        </a>
      )}
    </span>
  );
}

/** The question as a row has room for it; the drawer shows it in full. */
export function rowQuestion(m: Market): string {
  if (m.kind === "grad-1h") return "Graduates within 1h?";
  if (m.kind === "grad-15m") return "Graduates within 15m?";
  return m.strikeUsd ? `Above ${usdCompact(m.strikeUsd)} in 1h?` : m.question;
}

export function placeBet(m: Market, side: "YES" | "NO", stake: number, symbol: string): void {
  const r = liveEngine().buy(m.id, side, stake);
  if (!r.ok) {
    toast({ title: "Couldn't take that side", detail: r.reason, tone: "error" });
    return;
  }
  const p = r.position;
  toast({ title: `${side === "YES" ? "Yes" : "No"} on ${symbol} · ${stake} practice SOL at ${cents(p.price)}`, detail: `Pays ${p.shares.toFixed(2)} if the answer is ${side === "YES" ? "yes" : "no"}. ${m.question}`, tone: "ok" });
}

export function TradeButtons({ m, symbol, stake, compact }: { m: Market; symbol: string; stake: number; compact?: boolean }) {
  const open = m.status === "open";
  const yes = linePrice(m.p, "YES");
  const no = linePrice(m.p, "NO");
  if (!open) {
    return <span className={`oresult is-${m.status}`}>{m.status === "yes" ? "Resolved yes" : m.status === "no" ? "Resolved no" : "Void"}</span>;
  }
  return (
    <span className={`obtns${compact ? " is-compact" : ""}`}>
      <button className="obtn obtn-yes" onClick={() => placeBet(m, "YES", stake, symbol)} aria-label={`Yes on ${symbol}, ${m.question} ${cents(yes)} per share, stake ${stake} practice SOL`}>
        <span>Yes</span>
        <span className="mono">{cents(yes)}</span>
      </button>
      <button className="obtn obtn-no" onClick={() => placeBet(m, "NO", stake, symbol)} aria-label={`No on ${symbol}, ${m.question} ${cents(no)} per share, stake ${stake} practice SOL`}>
        <span>No</span>
        <span className="mono">{cents(no)}</span>
      </button>
    </span>
  );
}

function StatsLine({ t }: { t: LiveToken }) {
  const s = t.stats;
  const parts: Array<[string, string, string?]> = [];
  if (t.stage === "graduated") {
    if (s?.liquidityUsd !== undefined) parts.push(["Liq", usdCompact(s.liquidityUsd)]);
    if (s?.vol5mUsd !== undefined) parts.push(["5m vol", usdCompact(s.vol5mUsd)]);
    if (s?.change5m !== undefined) parts.push(["5m", `${s.change5m >= 0 ? "+" : ""}${s.change5m.toFixed(0)}%`, s.change5m >= 0 ? "up" : "down"]);
  } else {
    if (t.remainingSol !== undefined) parts.push(["To go", `${t.remainingSol.toFixed(t.remainingSol < 10 ? 1 : 0)} SOL`]);
    if (s?.buys5m !== undefined) parts.push(["Trades", `${count(s.buys5m)}/${count(s.sells5m)}`]);
  }
  if (s?.holders !== undefined) parts.push(["Holders", count(s.holders)]);
  if (s?.devPct !== undefined) parts.push(["Dev", pct(s.devPct, s.devPct < 10 ? 1 : 0), s.devPct >= 10 ? "warn" : undefined]);
  else if (t.devBuyPct !== undefined && t.stage === "new") parts.push(["Dev", pct(t.devBuyPct, t.devBuyPct < 10 ? 1 : 0), t.devBuyPct >= 10 ? "warn" : undefined]);
  if (s?.top10Pct !== undefined && t.stage !== "new") parts.push(["Top 10", pct(s.top10Pct), s.top10Pct >= 40 ? "warn" : undefined]);
  return (
    <span className="ostats">
      {parts.slice(0, 4).map(([k, v, tone]) => (
        <span key={k} className={tone ? `is-${tone}` : undefined}>
          <span className="ostats-k">{k}</span> {v}
        </span>
      ))}
    </span>
  );
}

/** The odds, flashing up or down for a moment when the line moves a point or more. */
function OddsValue({ m }: { m: Market }) {
  const prev = useRef(m.p);
  const [move, setMove] = useState<{ dir: "up" | "down"; at: number } | null>(null);
  useEffect(() => {
    const d = m.p - prev.current;
    if (Math.abs(d) >= 0.01) {
      setMove({ dir: d > 0 ? "up" : "down", at: Date.now() });
      prev.current = m.p;
    }
  }, [m.p]);
  const text = m.status === "open" ? odds(m.p) : m.status === "yes" ? "Yes" : m.status === "no" ? "No" : "Void";
  return (
    <span key={move?.at} className={`oodds${move ? ` is-${move.dir}` : ""}`} title="MAYBE's live line: a model estimate, not a market price">
      {text}
    </span>
  );
}

export const TokenRow = memo(function TokenRow({ mint, stake, onOpen }: { mint: string; stake: number; onOpen: (mint: string) => void }) {
  const t = useLiveToken(mint);
  const m = useHeadline(mint);
  if (!t) return <div className="orow is-gone">Left the board</div>;
  const ticking = t.tick && Date.now() - t.tick.at < 900 ? (t.tick.dir > 0 ? "up" : "down") : null;
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a,button")) return;
    onOpen(mint);
  };
  return (
    <article className={`orow${Date.now() - t.seenAt < 1500 && t.source === "launch" ? " is-new" : ""}`} onClick={open} aria-label={`${t.symbol} ${t.name}`}>
      <TokenAvatar t={t} />
      <div className="orow-body">
        <div className="orow-l1">
          <button className="oname" onClick={() => onOpen(mint)}>
            <span className="osym">{t.symbol}</span>
            <span className="onm">{t.name}</span>
          </button>
          <Age from={t.stage === "graduated" ? (t.graduatedAt ?? t.createdAt) : t.createdAt} />
          <Links t={t} />
        </div>
        <div className="orow-l2">
          <span className={`omc${ticking ? ` is-${ticking}` : ""}`} key={t.tick?.at}>
            {usdCompact(t.mcapUsd)}
          </span>
          {t.stage !== "graduated" && t.progress !== undefined && <span className="oprog">{Math.floor(t.progress * 100)}%</span>}
          <StatsLine t={t} />
        </div>
        {m && (
          <div className="orow-q">
            <span className="oq" title={m.question}>
              {rowQuestion(m)}
            </span>
            {m.status === "open" && <Countdown to={m.closesAt} />}
          </div>
        )}
        {m && (
          <span className="obar" aria-hidden="true">
            <i style={{ width: `${Math.round(m.p * 1000) / 10}%` }} />
          </span>
        )}
      </div>
      <div className="orow-side">
        {m ? (
          <>
            <OddsValue m={m} />
            <TradeButtons m={m} symbol={t.symbol} stake={stake} />
          </>
        ) : (
          <span className="oodds is-muted">—</span>
        )}
      </div>
    </article>
  );
});
