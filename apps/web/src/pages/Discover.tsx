import { memo, useDeferredValue, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEnvironment, useMarkets, useNow } from "../data/queries.ts";
import { Banner, Empty, ErrorBlock, LoadingBlock, Pill } from "../components/ui.tsx";
import { Icon } from "../components/Icon.tsx";
import { PageHead } from "../app/Shell.tsx";
import { MarketPanel } from "./MarketPanel.tsx";
import { eventDisplay } from "../lib/status.ts";
import { fmtDate, quoteAge, relTime } from "../lib/time.ts";
import type { MarketSummary } from "../data/types.ts";

const CATEGORIES = ["All", "Governance", "Crypto", "Sports", "Civic", "Tech", "Culture"] as const;
const CLOSING = [
  ["any", "Any time"],
  ["7", "Within 7 days"],
  ["30", "Within 30 days"],
  ["later", "Later"],
] as const;
const DEPTH = [
  ["any", "Any depth"],
  ["10000", "$10K+ depth"],
  ["50000", "$50K+ depth"],
] as const;

export function Discover() {
  const [params, setParams] = useSearchParams();
  const q = useMarkets();
  const { data: env } = useEnvironment();
  const now = useNow(1000);
  const search = params.get("q") ?? "";
  const deferred = useDeferredValue(search);
  const category = params.get("cat") ?? "All";
  const venue = params.get("venue") ?? "all";
  const closing = params.get("closes") ?? "any";
  const depth = params.get("depth") ?? "any";
  const compat = params.get("compat") === "1";
  const sort = params.get("sort") ?? "closing";
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null || v === "" || v === "any" || v === "All" || v === "all") next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };
  const list = useMemo(() => {
    const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);
    let ms = (q.data ?? []).filter((m) => {
      if (words.length && !words.every((w) => `${m.title} ${m.category} ${m.venueMarketId}`.toLowerCase().includes(w))) return false;
      if (category !== "All" && m.category !== category) return false;
      if (venue !== "all" && m.venue !== venue) return false;
      if (closing === "7" && m.closesAt - now > 7 * 86_400) return false;
      if (closing === "30" && m.closesAt - now > 30 * 86_400) return false;
      if (closing === "later" && m.closesAt - now <= 30 * 86_400) return false;
      if (depth !== "any" && m.depthUsd < Number(depth)) return false;
      if (compat && !m.compatible.ok) return false;
      return true;
    });
    const rank = (m: MarketSummary) => (m.status === "open" ? 0 : m.status === "closed" || m.status === "disputed" ? 1 : 2);
    ms = [...ms].sort((a, b) =>
      rank(a) - rank(b) ||
      (sort === "depth" ? b.depthUsd - a.depthUsd : sort === "uncertain" ? Math.abs(5000 - (a.quote?.yesBps ?? 0)) - Math.abs(5000 - (b.quote?.yesBps ?? 0)) : a.closesAt - b.closesAt),
    );
    return ms;
  }, [q.data, deferred, category, venue, closing, depth, compat, sort, now]);

  const selected = params.get("market");
  return (
    <div className="page">
      <PageHead title="Discover" sub="Markets you can build futures on. Prices are what traders pay, not the chance something happens." />
      <div className="stack">
        <label className="row" style={{ background: "var(--c-s2)", borderRadius: 10, padding: "0 12px", height: 44 }}>
          <Icon name="search" style={{ color: "var(--c-text-3)" }} />
          <span className="sr-only">Search markets</span>
          <input className="grow" style={{ background: "transparent", border: 0, height: 42, fontSize: 15 }} placeholder="Search markets" value={search} onChange={(e) => set("q", e.target.value)} />
        </label>
        <div className="filters" role="group" aria-label="Filters">
          <div className="segmented" role="group" aria-label="Category">
            {CATEGORIES.map((c) => (
              <button key={c} aria-pressed={category === c} onClick={() => set("cat", c)}>
                {c}
              </button>
            ))}
          </div>
          <select className="select" style={{ width: "auto", height: 36 }} aria-label="Venue" value={venue} onChange={(e) => set("venue", e.target.value)}>
            <option value="all">All venues</option>
            <option value="maybe-local">MAYBE local settlement</option>
            <option value="solana">Solana on-chain</option>
          </select>
          <select className="select" style={{ width: "auto", height: 36 }} aria-label="Closing date" value={closing} onChange={(e) => set("closes", e.target.value)}>
            {CLOSING.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select className="select" style={{ width: "auto", height: 36 }} aria-label="Liquidity" value={depth} onChange={(e) => set("depth", e.target.value)}>
            {DEPTH.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <button className="chip" aria-pressed={compat} onClick={() => set("compat", compat ? null : "1")}>
            <Icon name="check" size={14} /> Can trigger futures
          </button>
          <span className="grow" />
          <select className="select" style={{ width: "auto", height: 36 }} aria-label="Sort" value={sort} onChange={(e) => set("sort", e.target.value === "closing" ? null : e.target.value)}>
            <option value="closing">Closing soonest</option>
            <option value="depth">Most depth</option>
            <option value="uncertain">Most uncertain</option>
          </select>
        </div>
      </div>
      {q.isLoading ? (
        <LoadingBlock lines={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : list.length === 0 ? (
        <Empty title="No markets match" action={<button className="btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</button>}>
          Try fewer filters or a different keyword.
        </Empty>
      ) : (
        <MarketList markets={list} now={now} selected={selected} onOpen={(k) => set("market", k)} />
      )}
      <section className="section" aria-labelledby="venues">
        <h2 id="venues" className="t-head">
          Other venues
        </h2>
        <div className="grid-2">
          {(env?.venues ?? [])
            .filter((v) => v.id === "polymarket" || v.id === "kalshi")
            .map((v) => (
              <div key={v.id} className="panel panel-outline">
                <div className="row">
                  <strong className="grow">{v.label}</strong>
                  <Pill tone="quiet" icon="lock">
                    {v.trading === "read-only" ? "Read-only" : "Unavailable"}
                  </Pill>
                </div>
                <p className="t-small muted">{v.note}</p>
                <p className="t-micro faint">Settlement: {v.settlement}</p>
              </div>
            ))}
        </div>
      </section>
      {env?.mode === "simulation" && <Banner tone="info">Every market here is fictional sample data for the simulation. Quotes are deterministic samples, refreshed every few seconds.</Banner>}
    </div>
  );
}

function MarketList({ markets, now, selected, onOpen }: { markets: MarketSummary[]; now: number; selected: string | null; onOpen: (k: string) => void }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: markets.length, getScrollElement: () => parentRef.current, estimateSize: () => 72, overscan: 6 });
  return (
    <div className="panel panel-flush">
      <div className="market-row hide-mobile" style={{ minHeight: 36, borderTop: 0, cursor: "default" }} aria-hidden="true">
        <span className="t-micro faint">Market</span>
        <span className="t-micro faint col-odds">YES / NO</span>
        <span className="t-micro faint">Quote</span>
        <span className="t-micro faint col-closes">Closes</span>
      </div>
      <div ref={parentRef} style={{ maxHeight: "min(70vh, 760px)", overflowY: "auto" }} role="list" aria-label={`${markets.length} markets`}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((item) => {
            const m = markets[item.index]!;
            return (
              <div key={m.key} role="listitem" style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }} ref={v.measureElement} data-index={item.index}>
                <MarketRow m={m} now={now} current={selected === m.key} onOpen={onOpen} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Memoized: a quote tick re-renders only the rows whose data changed (structural sharing). */
const MarketRow = memo(function MarketRow({ m, now, current, onOpen }: { m: MarketSummary; now: number; current: boolean; onOpen: (k: string) => void }) {
  const ev = eventDisplay(m.resolution, now);
  const age = m.quote ? quoteAge(m.quote.asOf, now) : null;
  return (
    <button className="market-row" aria-current={current || undefined} onClick={() => onOpen(m.key)}>
      <span className="stack-tight" style={{ minWidth: 0 }}>
        <span className="truncate strong">{m.title}</span>
        <span className="row-tight t-small muted" style={{ flexWrap: "wrap" }}>
          <span>{m.venue === "maybe-local" ? "Local settlement" : "On-chain"}</span>
          <span aria-hidden="true">·</span>
          <span>{m.category}</span>
          {m.status !== "open" ? (
            <Pill tone={ev.tone} icon={ev.icon}>
              {ev.label}
            </Pill>
          ) : !m.compatible.ok ? (
            <Pill tone="quiet" icon="lock">
              {m.kind === "multi" ? "Multi-outcome" : m.kind === "scalar" ? "Scalar" : "Not a trigger"}
            </Pill>
          ) : null}
        </span>
      </span>
      <span className="stack-tight col-odds">
        {m.quote ? (
          <>
            <span className="row t-small" style={{ justifyContent: "space-between" }}>
              <span className="num">YES {(m.quote.yesBps / 100).toFixed(0)}¢</span>
              <span className="num muted">NO {(m.quote.noBps / 100).toFixed(0)}¢</span>
            </span>
            <span className="odds" aria-hidden="true">
              <span style={{ width: `${m.quote.yesBps / 100}%` }} />
            </span>
          </>
        ) : (
          <span className="t-small faint">{m.adapter === "balance-threshold" ? "No price — objective" : m.kind !== "binary" ? `${m.outcomes.length} outcomes` : "No quote"}</span>
        )}
      </span>
      <span className="stack-tight t-small">
        {m.quote ? (
          <>
            <span className="muted">
              spread <span className="num">{(m.quote.spreadBps / 100).toFixed(1)}¢</span>
            </span>
            <span className={`t-micro ${age?.stale ? "" : "faint"}`} style={age?.stale ? { color: "var(--c-amber)" } : undefined}>
              {age?.label}
            </span>
          </>
        ) : (
          <span className="faint">—</span>
        )}
      </span>
      <span className="stack-tight t-small col-closes">
        <span>{fmtDate(m.closesAt)}</span>
        <span className="t-micro faint">{relTime(m.closesAt, now)}</span>
      </span>
    </button>
  );
});

export function MarketPage() {
  const { key } = useParams();
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <MarketPanel marketKey={key!} />
    </div>
  );
}
