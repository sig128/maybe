import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { parseAmount } from "@maybe/core";
import { useBackend } from "../data/BackendContext.tsx";
import { useMarket, useNow } from "../data/queries.ts";
import { ProbabilityChart } from "../components/ProbabilityChart.tsx";
import { Banner, Button, ErrorBlock, KV, LoadingBlock, Pill, SampleTag } from "../components/ui.tsx";
import { Icon } from "../components/Icon.tsx";
import { toast } from "../components/Toast.tsx";
import { eventDisplay, STRATEGY_STATUS } from "../lib/status.ts";
import { fmtDateTime, quoteAge, relTime } from "../lib/time.ts";
import { Amount } from "../components/Amount.tsx";

export function MarketPanel({ marketKey, compact }: { marketKey: string; compact?: boolean }) {
  const q = useMarket(marketKey);
  const now = useNow(1000);
  const navigate = useNavigate();
  const backend = useBackend();
  const [hover, setHover] = useState<{ t: number; bps: number } | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [observe, setObserve] = useState("");
  if (q.isLoading) return <LoadingBlock lines={6} />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const m = q.data;
  if (!m) return <Banner tone="warn">This market isn't in this environment's registry.</Banner>;
  const ev = eventDisplay(m.resolution, now);
  const age = m.quote ? quoteAge(m.quote.asOf, now) : null;
  const shownBps = hover?.bps ?? m.quote?.yesBps ?? null;
  const sim = backend.sim;
  const run = async (f: () => Promise<void>, ok: string) => {
    try {
      await f();
      toast({ title: ok, tone: "ok" });
    } catch (e) {
      toast({ title: "Couldn't do that", detail: (e as Error).message, tone: "error" });
    }
  };
  return (
    <div className="stack-loose">
      {!compact && (
        <div className="stack-tight">
          <div className="row row-wrap t-small muted">
            <span>{m.venue === "maybe-local" ? "MAYBE local settlement" : m.venue === "solana" ? "Solana on-chain" : m.venue}</span>
            <span aria-hidden="true">·</span>
            <span>{m.category}</span>
            <SampleTag />
          </div>
          <h2 className="t-display">{m.title}</h2>
        </div>
      )}
      <div className="row row-wrap">
        <Pill tone={ev.tone} icon={ev.icon}>
          {ev.label}
        </Pill>
        {m.kind !== "binary" && <Pill tone="quiet">{m.kind === "multi" ? `${m.outcomes.length} outcomes` : "Scalar"}</Pill>}
        <Pill tone={m.compatible.ok ? "quiet" : "error"} icon={m.compatible.ok ? "check" : "lock"}>
          {m.compatible.ok ? "Can trigger futures" : "Can't trigger futures"}
        </Pill>
        {compact && <SampleTag />}
      </div>
      {ev.detail && <p className="t-small muted">{ev.detail}</p>}
      {!m.compatible.ok && m.compatible.reason && <Banner tone="info">{m.compatible.reason}.</Banner>}

      {m.kind === "binary" && (
        <section className="stack" aria-label="Price">
          <div className="row" style={{ alignItems: "flex-end", gap: 24 }}>
            <div className="stack-tight">
              <span className="t-small muted">{hover ? "YES at that time" : "YES price"}</span>
              <span className="t-display num">{shownBps !== null ? `${(shownBps / 100).toFixed(0)}¢` : "—"}</span>
            </div>
            <div className="stack-tight">
              <span className="t-small muted">NO price</span>
              <span className="t-title num muted">{shownBps !== null ? `${((10_000 - shownBps) / 100).toFixed(0)}¢` : "—"}</span>
            </div>
            <div className="grow" />
            {m.quote && (
              <div className="stack-tight" style={{ textAlign: "right" }}>
                <span className="t-small muted">
                  Spread <span className="num">{(m.quote.spreadBps / 100).toFixed(1)}¢</span>
                </span>
                <span className={`t-micro ${age?.stale ? "" : "faint"}`} style={age?.stale ? { color: "var(--c-amber)" } : undefined}>
                  {age?.stale ? "Stale quote · " : ""}updated {age?.label}
                </span>
              </div>
            )}
          </div>
          <p className="t-small faint">A price is what traders pay right now, not the chance it happens. {m.quote?.sample && "This is a deterministic sample quote."}</p>
          <ProbabilityChart points={m.history} label={`${m.title} YES price`} onHover={setHover} height={compact ? 150 : 200} />
        </section>
      )}

      <div className="row row-wrap">
        <Button variant="primary" icon="plus" disabledReason={m.compatible.ok ? null : (m.compatible.reason ?? "Not supported as a trigger")} onClick={() => navigate(`/futures/new?market=${m.key}`)}>
          Create future
        </Button>
        {compact && (
          <Link className="btn btn-outline" to={`/markets/${m.key}`}>
            Open full page
          </Link>
        )}
      </div>

      <section className="stack" aria-label="Resolution">
        <h3 className="t-head">How it resolves</h3>
        <ol className="stack" style={{ gap: 0 }}>
          {[
            { label: "Trading closes", at: m.closesAt },
            { label: m.adapter === "balance-threshold" ? "Observation deadline" : "Outcome proposed by attestors", at: m.adapter === "balance-threshold" ? m.resolvesBy : null },
            { label: m.adapter === "balance-threshold" ? "Final: YES on first qualifying observation, otherwise NO" : "Final after a challenge window, unless disputed", at: m.resolvesBy },
          ].map((s, i) => (
            <li key={i} className="row" style={{ alignItems: "flex-start", padding: "6px 0" }}>
              <span className="num faint" style={{ width: 18 }}>
                {i + 1}
              </span>
              <span className="grow">{s.label}</span>
              {s.at && (
                <span className="t-small muted nowrap" title={fmtDateTime(s.at)}>
                  {fmtDateTime(s.at)} · {relTime(s.at, now)}
                </span>
              )}
            </li>
          ))}
        </ol>
        <KV
          items={[
            ["Settlement", m.trust],
            ["Source", m.resolutionSource],
            ["Venue market ID", <span className="mono">{m.venueMarketId}</span>],
            ["Rules version", <span className="mono" title={m.ruleHash}>{m.ruleHash.slice(0, 16)}…</span>],
            ...(m.balance ? ([["Threshold", <Amount units={m.balance.threshold} mint={m.balance.mint} />]] as Array<[string, React.ReactNode]>) : []),
          ]}
        />
        <div className="stack-tight">
          <p className={`t-small ${rulesOpen ? "" : "truncate"}`} style={{ whiteSpace: rulesOpen ? "normal" : undefined }}>
            {m.rules}
          </p>
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setRulesOpen((o) => !o)} aria-expanded={rulesOpen}>
            {rulesOpen ? "Show less" : "Show full rules"}
          </button>
        </div>
        <p className="t-small faint">Futures freeze this rules version when you authorize them. Similar titles on other venues are different markets.</p>
      </section>

      <section className="stack" aria-label="Your exposure">
        <h3 className="t-head">Your futures on this market</h3>
        {m.exposure.length === 0 ? (
          <p className="muted t-small">None yet.</p>
        ) : (
          <div className="panel panel-flush panel-raised">
            <div className="list">
              {m.exposure.map((x) => (
                <Link key={x.strategyId} to={`/futures/${x.strategyId}`} className="list-item">
                  <span className="grow stack-tight">
                    <span className="truncate">{x.title}</span>
                    <span className="t-small muted truncate">{x.steps.length ? x.steps.join(", ") : "Referenced in conditions"}</span>
                  </span>
                  <Pill tone={STRATEGY_STATUS[x.status].tone} icon={STRATEGY_STATUS[x.status].icon}>
                    {STRATEGY_STATUS[x.status].label}
                  </Pill>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {sim && m.kind === "binary" && (
        <section className="panel panel-outline" aria-label="Simulation controls">
          <div className="row">
            <Icon name="info" size={16} style={{ color: "var(--c-amber)" }} />
            <strong className="grow">Simulate the outcome</strong>
          </div>
          {m.adapter === "attestation" ? (
            <>
              <p className="t-small muted">Proposes an outcome as if 2 of 3 development attestors signed it. It becomes final after a 10-minute challenge window (move time forward from the mode badge).</p>
              <div className="row row-wrap">
                {(["YES", "NO", "VOID"] as const).map((o) => (
                  <Button key={o} size="sm" onClick={() => run(() => sim.resolveEvent(m.eventKey, o), `Proposed ${o}`)} disabledReason={m.resolution.status === "FINAL" ? "Already final" : null}>
                    Propose {o}
                  </Button>
                ))}
                <Button size="sm" variant="outline" onClick={() => run(() => sim.disputeEvent(m.eventKey), "Disputed")} disabledReason={m.resolution.status !== "PENDING" ? "Only a proposed outcome can be disputed" : null}>
                  Dispute
                </Button>
              </div>
            </>
          ) : (
            <form
              className="row row-wrap"
              onSubmit={(e) => {
                e.preventDefault();
                let u: bigint;
                try {
                  u = parseAmount(observe || "0", 6);
                } catch {
                  toast({ title: "Enter a USDC amount", tone: "error" });
                  return;
                }
                void run(() => sim.observeBalance(m.eventKey, u), "Observation submitted");
              }}
            >
              <label className="field grow">
                <span className="label">Observed escrow balance (USDC)</span>
                <input className="input" inputMode="decimal" value={observe} onChange={(e) => setObserve(e.target.value)} placeholder="50000" />
              </label>
              <Button size="sm" type="submit" style={{ alignSelf: "flex-end" }}>
                Observe
              </Button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
