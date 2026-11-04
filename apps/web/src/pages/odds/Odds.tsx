import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "../../components/Icon.tsx";
import { Modal } from "../../components/Overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { liveEngine, type Stage } from "../../live/engine.ts";
import { solAmount } from "../../live/format.ts";
import { useClock, useColumn, useLiveStatus, usePractice } from "../../live/hooks.ts";
import type { SourceHealth } from "../../live/sources.ts";
import { PositionsDrawer } from "./Positions.tsx";
import { TokenDrawer } from "./TokenDrawer.tsx";
import { ROW_H, ROW_H_COMPACT, TokenRow } from "./TokenRow.tsx";
import { openHow, openPositions, useOddsUi } from "./uiStore.ts";
import "./odds.css";

const COLUMNS: Array<{ stage: Stage; title: string; hint: string }> = [
  { stage: "new", title: "Just launched", hint: "On the bonding curve" },
  { stage: "stretch", title: "Final stretch", hint: "Curve over 55% full" },
  { stage: "graduated", title: "Graduated", hint: "Trading on PumpSwap" },
];

const STAKES = [0.05, 0.1, 0.5, 1];
/** After a touch, a column holds still this long so a tap lands on the row that was under the finger. */
const TOUCH_HOLD_MS = 2500;

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      // per-visit only
    }
  },
};

function healthTone(h: SourceHealth, now: number, staleMs: number): "live" | "slow" | "down" {
  if (h.state === "offline") return "down";
  if (h.state !== "live" || !h.lastAt) return "slow";
  return now - h.lastAt > staleMs ? "slow" : "live";
}

function Source({ label, value, tone, title }: { label: string; value: string; tone: "live" | "slow" | "down"; title: string }) {
  return (
    <span className={`osrc is-${tone}`} title={title}>
      <i aria-hidden="true" />
      <span className="osrc-k">{label}</span>
      <span className="osrc-v mono">{value}</span>
    </span>
  );
}

export function StatusBar() {
  const s = useLiveStatus();
  const now = useClock();
  const feedTone = healthTone(s.feed, now, 30_000);
  const chainTone = healthTone(s.chain, now, 15_000);
  const statsTone = healthTone(s.stats, now, 20_000);
  const statsAge = s.stats.lastAt ? Math.max(0, Math.round((now - s.stats.lastAt) / 1000)) : null;
  const live = feedTone === "live" && chainTone === "live";
  return (
    <div className="ostatus" role="status" aria-live="off">
      <span className={`olive is-${live ? "live" : "slow"}`}>
        <i aria-hidden="true" />
        {live ? "Live on mainnet" : "Connecting to Solana"}
      </span>
      <Source label="Launches" value={`${s.launchesPerMin}/min`} tone={feedTone} title="New pump.fun launches and graduations, streamed from PumpPortal" />
      <Source label="Slot" value={s.chain.slot ? s.chain.slot.toLocaleString("en-US") : "…"} tone={chainTone} title={`Bonding curves and PumpSwap pools read directly from Solana (${s.chain.subscriptions} live account subscriptions${s.chain.polled ? `, ${s.chain.polled} polled` : ""})`} />
      <Source label="Stats" value={statsAge === null ? "…" : `${statsAge}s`} tone={statsTone} title="Holders, dev and top-holder share, volume and socials from Jupiter's token API" />
      <Source label="SOL" value={s.solUsd ? `$${s.solUsd.toFixed(2)}` : "…"} tone={s.solUsd ? "live" : "slow"} title="SOL price in USD, from Jupiter" />
    </div>
  );
}

/** The practice balance; opens the positions drawer. */
export function BalanceButton() {
  const practice = usePractice();
  const openCount = practice.positions.filter((p) => p.status === "open").length;
  return (
    <button className="obalance" onClick={() => openPositions()} aria-label={`${solAmount(practice.balance)} practice SOL${openCount ? `, ${openCount} open positions` : ""}. Show positions`}>
      <span className="mono">{solAmount(practice.balance)}</span>
      <span className="muted">practice SOL</span>
      {openCount > 0 && <span className="obadge mono">{openCount}</span>}
    </button>
  );
}

export function HowButton() {
  return (
    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => openHow()} aria-label="How Odds works">
      <Icon name="info" size={15} />
    </button>
  );
}

function TabCount({ stage }: { stage: Stage }) {
  const n = useColumn(stage).length;
  return <span className="otab-count mono">{n}</span>;
}

function Column({ stage, title, hint, stake, query, rowH, onOpen, onVisible, paused }: { stage: Stage; title: string; hint: string; stake: number; query: string; rowH: number; onOpen: (m: string) => void; onVisible: (stage: Stage, mints: string[]) => void; paused: boolean }) {
  const live = useColumn(stage);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const engine = liveEngine();
  // the list holds still while someone is pointing at it, touching it, or reading further down
  const hold = useRef({ hover: false, focus: false, touchedAt: 0, scrolled: false });
  const liveRef = useRef(live);
  liveRef.current = live;
  const settle = useCallback(() => {
    const h = hold.current;
    const holding = h.hover || h.focus || h.scrolled || Date.now() - h.touchedAt < TOUCH_HOLD_MS;
    setFrozen((f) => (holding ? (f ?? liveRef.current) : null));
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      if (hold.current.touchedAt && Date.now() - hold.current.touchedAt >= TOUCH_HOLD_MS) settle();
    }, 500);
    return () => clearInterval(t);
  }, [settle]);
  const shown = useMemo(() => {
    const base = frozen ?? live;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((m) => {
      const t = engine.getToken(m);
      return !!t && (t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || m.toLowerCase().startsWith(q));
    });
  }, [frozen, live, query, engine]);
  const waiting = frozen ? live.filter((m) => !frozen.includes(m)).length : 0;
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: 6, getItemKey: (i) => shown[i] ?? i });
  useEffect(() => v.measure(), [rowH, v]);
  const items = v.getVirtualItems();
  const visibleKey = items.map((i) => shown[i.index]).join(",");
  useEffect(() => {
    onVisible(stage, visibleKey ? visibleKey.split(",") : []);
  }, [visibleKey, stage, onVisible]);
  const set = (patch: Partial<typeof hold.current>) => {
    Object.assign(hold.current, patch);
    if (!paused) settle();
  };
  const jumpToTop = () => {
    hold.current = { hover: hold.current.hover, focus: false, touchedAt: 0, scrolled: false };
    setFrozen(null);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  return (
    <section
      className="ocol"
      aria-label={title}
      onMouseEnter={() => set({ hover: true })}
      onMouseLeave={() => set({ hover: false })}
      onFocus={(e) => set({ focus: (e.target as HTMLElement).matches?.(":focus-visible") ?? true })}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && set({ focus: false })}
      onTouchStart={() => set({ touchedAt: Date.now() })}
    >
      <header className="ocol-head">
        <div className="stack-tight" style={{ minWidth: 0 }}>
          <h2 className="ocol-title">
            {title} <span className="ocol-count mono">{live.length}</span>
          </h2>
          <span className="t-micro muted">{hint}</span>
        </div>
        {(frozen || paused) && (
          <button className="ocol-hold" onClick={jumpToTop}>
            <Icon name="pause" size={12} /> {paused ? "Paused" : "Held"}
            {waiting > 0 && <span className="mono"> · {waiting} new</span>}
          </button>
        )}
      </header>
      <div className="ocol-list" ref={scrollRef} tabIndex={-1} onScroll={(e) => (e.currentTarget.scrollTop > 8) !== hold.current.scrolled && set({ scrolled: e.currentTarget.scrollTop > 8 })}>
        {shown.length === 0 ? (
          <div className="ocol-empty">
            <span className="oskel" aria-hidden="true" />
            <span className="oskel" aria-hidden="true" />
            <span className="t-small muted">{query ? "Nothing matches that search." : stage === "new" ? "Waiting for the next pump.fun launch…" : stage === "stretch" ? "Nothing is past 55% of its curve right now." : "Graduations appear here the moment a curve fills."}</span>
          </div>
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {items.map((it) => (
              <div key={it.key} className="ocol-item" style={{ transform: `translateY(${it.start}px)`, height: rowH }}>
                <TokenRow mint={shown[it.index]!} stake={stake} onOpen={onOpen} />
              </div>
            ))}
          </div>
        )}
      </div>
      {frozen && waiting > 0 && (
        <button className="ocol-new" onClick={jumpToTop}>
          {waiting} new · back to the top
        </button>
      )}
    </section>
  );
}

function HowItWorks() {
  const open = useOddsUi((s) => s.howOpen);
  return (
    <Modal open={open} onOpenChange={(o) => openHow(o)} title="How Odds works">
      <div className="stack t-small ohow">
        <p>
          <strong>Everything on the board is live.</strong> New pump.fun launches stream in as they happen; each token's bonding curve and, after it graduates, its PumpSwap pool are read straight from Solana mainnet in your browser.
        </p>
        <p>
          <strong>Every token gets questions.</strong> At launch: will it graduate within an hour? Past 55% of its curve: will it graduate in the next 15 minutes? After graduating: will its market cap be higher an hour later?
        </p>
        <p>
          <strong>The odds are MAYBE's live line, not a market yet.</strong> Graduation odds come from the SOL flowing into the curve, how steady that flow is, and the SOL still needed; price odds come from how the token has been moving. They update every second.
        </p>
        <p>
          <strong>Positions use practice SOL.</strong> You start with 10. Yes pays 1 per share if it happens, No pays 1 if it doesn't, and you can sell back at the line before the close. Questions settle on what the chain shows: the curve filling, or the market cap at the close.
        </p>
        <p className="muted">Real-money questions need an audited on-chain market and a license, so they aren't switched on. Nothing on this page signs a transaction or touches a wallet.</p>
      </div>
    </Modal>
  );
}

function Positions() {
  const open = useOddsUi((s) => s.positionsOpen);
  return <PositionsDrawer open={open} onOpenChange={(o) => openPositions(o)} />;
}

export default function Odds() {
  const engine = liveEngine();
  const practice = usePractice();
  const narrow = useMediaQuery("(max-width: 900px)");
  const compact = useMediaQuery("(max-width: 600px)");
  const [tab, setTab] = useState<Stage>("new");
  const [openMint, setOpenMint] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [stake, setStakeState] = useState(() => {
    const v = Number(store.get("maybe.odds.stake"));
    return STAKES.includes(v) ? v : 0.1;
  });
  const [noticeHidden, setNoticeHidden] = useState(() => store.get("maybe.odds.notice") === "hidden");
  const visible = useRef(new Map<Stage, string[]>());

  useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, [engine]);

  const onVisible = useCallback(
    (stage: Stage, mints: string[]) => {
      visible.current.set(stage, mints);
      engine.setVisible([...visible.current.values()].flat());
    },
    [engine],
  );

  // tell people when a practice position settles
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const prev = seen.current;
    const next = new Map(practice.positions.map((p) => [p.id, p.status]));
    if (prev) {
      for (const p of practice.positions) {
        const before = prev.get(p.id);
        if (before === "open" && p.status !== "open" && p.status !== "closed") {
          toast({
            title: p.status === "won" ? `Won ${solAmount(p.payout ?? 0)} practice SOL on ${p.symbol}` : p.status === "lost" ? `Lost ${solAmount(p.stake)} practice SOL on ${p.symbol}` : `Stake returned on ${p.symbol}`,
            detail: p.question,
            tone: p.status === "won" ? "ok" : "info",
          });
        }
      }
    }
    seen.current = next;
  }, [practice.positions]);

  const setStake = (v: number) => {
    setStakeState(v);
    store.set("maybe.odds.stake", String(v));
  };
  const togglePause = () => {
    engine.setPaused(!paused);
    setPaused(!paused);
  };
  const cols = narrow ? COLUMNS.filter((c) => c.stage === tab) : COLUMNS;

  return (
    <div className={`odds${narrow ? " is-narrow" : ""}`}>
      <div className="obar-top">
        <StatusBar />
        <div className="ocontrols">
          <label className="osearch">
            <Icon name="search" size={15} />
            <input type="search" placeholder="Ticker, name or mint" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter tokens by ticker, name or mint" />
          </label>
          <div className="segmented ostake" role="group" aria-label="Stake per tap, in practice SOL">
            {STAKES.map((v) => (
              <button key={v} aria-pressed={stake === v} onClick={() => setStake(v)}>
                {v}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={togglePause} aria-pressed={paused} aria-label={paused ? "Resume the board" : "Pause the board"}>
            <Icon name={paused ? "play" : "pause"} size={15} />
            <span className="hide-mobile">{paused ? "Resume" : "Pause"}</span>
          </button>
          <span className="ocontrols-end">
            <HowButton />
            <BalanceButton />
          </span>
        </div>
      </div>

      {!noticeHidden && (
        <div className="onotice">
          <Icon name="bolt" size={15} />
          <p className="grow t-small">
            Live from Solana mainnet. Odds are MAYBE's live line, a model of on-chain flow, not a market. Positions use practice SOL and settle on what actually happens.{" "}
            <button className="olink" onClick={() => openHow()}>
              How it works
            </button>
          </p>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Hide this note"
            onClick={() => {
              setNoticeHidden(true);
              store.set("maybe.odds.notice", "hidden");
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {narrow && (
        <div className="segmented otabs" role="tablist" aria-label="Board">
          {COLUMNS.map((c) => (
            <button key={c.stage} role="tab" aria-selected={tab === c.stage} onClick={() => setTab(c.stage)}>
              {c.title} <TabCount stage={c.stage} />
            </button>
          ))}
        </div>
      )}

      <div className={`ocols${narrow ? " is-single" : ""}`}>
        {cols.map((c) => (
          <Column key={c.stage} {...c} stake={stake} query={query} rowH={compact ? ROW_H_COMPACT : ROW_H} onOpen={setOpenMint} onVisible={onVisible} paused={paused} />
        ))}
      </div>

      <TokenDrawer mint={openMint} stake={stake} onClose={() => setOpenMint(null)} />
      <Positions />
      <HowItWorks />
    </div>
  );
}
