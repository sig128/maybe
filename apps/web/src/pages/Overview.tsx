import { useMemo } from "react";
import { Link } from "react-router";
import type { AssetInfo } from "@maybe/core";
import { useActivity, useAssetMap, useMarkets, useNow, usePortfolio } from "../data/queries.ts";
import { Amount, formatUsd, usdOf } from "../components/Amount.tsx";
import { Banner, Button, Empty, ErrorBlock, LoadingBlock, Pill, SampleTag } from "../components/ui.tsx";
import { BRANCH_VARS } from "../components/PathsDiagram.tsx";
import { readinessDisplay, STRATEGY_STATUS } from "../lib/status.ts";
import { quoteAge, relTime } from "../lib/time.ts";
import { ActivityRow } from "./Activity.tsx";
import type { Portfolio, StrategyView } from "../data/types.ts";

interface Segment {
  key: string;
  label: string;
  usd: bigint;
  color: string;
  hatched?: boolean;
  lines: Array<{ mint: string; units: bigint }>;
  hint: string;
  to?: string;
}

function segments(p: Portfolio, assets: Map<string, AssetInfo>): Segment[] {
  const est = p.estimates;
  const sum = (lines: Array<{ mint: string; units: bigint }>) => lines.reduce((s, l) => s + usdOf(l.units, l.mint, assets, est), 0n);
  const wallet = Object.entries(p.wallet)
    .filter(([, u]) => u > 0n)
    .map(([mint, units]) => ({ mint, units }));
  const available = Object.entries(p.vault.balances)
    .filter(([, b]) => b.available > 0n)
    .map(([mint, b]) => ({ mint, units: b.available }));
  const segs: Segment[] = [
    { key: "wallet", label: "In your wallet", usd: sum(wallet), color: "var(--c-s4)", lines: wallet, hint: "Not in your vault yet", to: "/money" },
    { key: "available", label: "Available in vault", usd: sum(available), color: "var(--c-text)", lines: available, hint: "Uncommitted · withdrawable", to: "/money" },
  ];
  p.strategies
    .filter((s) => s.runtime && (s.status === "ACTIVE" || s.status === "PAUSED"))
    .forEach((s, i) => {
      const lines: Array<{ mint: string; units: bigint }> = [];
      s.runtime!.holdings.forEach((row) =>
        row.forEach((u, mi) => {
          if (u <= 0n) return;
          const mint = s.runtime!.plan.mints[mi]!;
          const ex = lines.find((l) => l.mint === mint);
          if (ex) ex.units += u;
          else lines.push({ mint, units: u });
        }),
      );
      segs.push({ key: s.id, label: s.title, usd: sum(lines), color: BRANCH_VARS[i % BRANCH_VARS.length]!, lines, hint: s.status === "PAUSED" ? "Reserved · paused" : "Reserved in this future", to: `/futures/${s.id}` });
    });
  const pend = p.pendingReservations.map((r) => ({ mint: r.mint, units: r.units }));
  if (pend.length) segs.push({ key: "pending", label: "Being reserved", usd: 0n, color: "var(--c-amber)", hatched: true, lines: pend, hint: "Still available until confirmed" });
  return segs;
}

export function Overview() {
  const q = usePortfolio();
  const assets = useAssetMap();
  const now = useNow(5000);
  const { data: activity } = useActivity();
  const { data: markets } = useMarkets();
  const segs = useMemo(() => (q.data ? segments(q.data, assets) : []), [q.data, assets]);
  if (q.isLoading) return <div className="page"><LoadingBlock lines={5} /></div>;
  if (q.error || !q.data) return <div className="page"><ErrorBlock error={q.error} retry={() => void q.refetch()} /></div>;
  const p = q.data;
  const total = segs.filter((s) => !s.hatched).reduce((a, s) => a + s.usd, 0n);
  const priceAges = Object.values(p.estimates).map((e) => e.asOf);
  const oldest = priceAges.length ? Math.min(...priceAges) : now;
  const active = p.strategies.filter((s) => s.status === "ACTIVE" || s.status === "PAUSED");
  const attention = attentionItems(p.strategies, markets ?? [], now);
  const recent = (activity ?? []).slice(0, 6);
  const walletEmpty = Object.keys(p.wallet).length === 0;

  return (
    <div className="page">
      <section className="stack-loose" aria-labelledby="where">
        <div className="row row-wrap" style={{ alignItems: "flex-end" }}>
          <div className="stack-tight" style={{ flex: "1 1 320px", minWidth: 0 }}>
            <h2 id="where" className="t-head muted" style={{ fontWeight: 520 }}>
              Where your money is
            </h2>
            <p className="t-hero num">{formatUsd(total)}</p>
            <p className="t-small faint">
              Estimated value of confirmed balances. Prices are sample pool quotes, {quoteAge(oldest, now).label}. Reservations are part of your vault, not added on top.
            </p>
          </div>
          <div className="row">
            <Link className="btn btn-primary" to="/futures/new">
              New future
            </Link>
            <Link className="btn" to="/money?action=deposit">
              Deposit
            </Link>
          </div>
        </div>
        {walletEmpty && <Banner tone="info">Your wallet is disconnected, so wallet balances aren't counted.</Banner>}
        <div className="stack">
          <div className="strip" role="img" aria-label={segs.map((s) => `${s.label}: ${formatUsd(s.usd)}`).join("; ")}>
            {segs
              .filter((s) => s.usd > 0n || s.hatched)
              .map((s) => (
                <span
                  key={s.key}
                  className={s.hatched ? "swatch-hatched" : undefined}
                  style={{ flexGrow: Number(s.hatched ? (total > 0n ? total / 50n : 1n) : s.usd) || 1, background: s.hatched ? undefined : s.color }}
                />
              ))}
          </div>
          <div className="strip-legend">
            {segs.map((s) => (
              <Link key={s.key} to={s.to ?? "#"} className="strip-key">
                <span className="row-tight t-small muted">
                  <span className={`swatch ${s.hatched ? "swatch-hatched" : ""}`} style={{ background: s.hatched ? undefined : s.color }} />
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="num t-head">{s.hatched ? "pending" : formatUsd(s.usd)}</span>
                <span className="t-micro faint stack-tight">
                  {s.lines.length ? s.lines.map((l) => <Amount key={l.mint} units={l.units} mint={l.mint} />) : <span>Nothing here</span>}
                </span>
                <span className="t-micro faint">{s.hint}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <div className="split">
        <section className="section" aria-labelledby="waiting">
          <div className="section-head">
            <h2 id="waiting" className="t-title">
              What's waiting
            </h2>
            <Link className="btn btn-ghost btn-sm" to="/futures">
              All futures
            </Link>
          </div>
          {active.length === 0 ? (
            <Empty title="No active futures" action={<Link className="btn btn-primary" to="/futures/new">Create your first future</Link>}>
              A future reserves money for something that might happen. Start from a market or a template.
            </Empty>
          ) : (
            <div className="panel panel-flush">
              <div className="list">
                {active.map((s, i) => (
                  <WaitingRow key={s.id} s={s} color={BRANCH_VARS[i % BRANCH_VARS.length]!} now={now} />
                ))}
              </div>
            </div>
          )}
        </section>
        <section className="section" aria-labelledby="attention">
          <h2 id="attention" className="t-title">
            Needs attention
          </h2>
          {attention.length === 0 ? (
            <p className="muted">Nothing needs you right now.</p>
          ) : (
            <ul className="stack">
              {attention.map((a, i) => (
                <li key={i}>
                  <Banner tone={a.tone} action={a.to ? <Link className="btn btn-sm" to={a.to}>{a.cta ?? "Open"}</Link> : undefined}>
                    <strong>{a.title}</strong> {a.detail}
                  </Banner>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="section" aria-labelledby="changed">
        <div className="section-head">
          <h2 id="changed" className="t-title">
            What changed
          </h2>
          <Link className="btn btn-ghost btn-sm" to="/activity">
            All activity
          </Link>
        </div>
        <div className="panel panel-flush">
          <div className="list">
            {recent.length === 0 ? <p className="muted" style={{ padding: 16 }}>No activity yet.</p> : recent.map((a) => <ActivityRow key={a.id} item={a} now={now} />)}
          </div>
        </div>
      </section>
    </div>
  );
}

function WaitingRow({ s, color, now }: { s: StrategyView; color: string; now: number }) {
  const st = STRATEGY_STATUS[s.status];
  const next = s.readiness.map((r, i) => ({ r, i })).filter(({ r }) => r.state !== "done");
  const first = next[0];
  const label = first ? `${s.doc.actions[first.i]?.label ?? `Step ${first.i + 1}`}: ${readinessDisplay(first.r, now).label.toLowerCase()}` : "No more steps; closes at expiry";
  return (
    <Link to={`/futures/${s.id}`} className="list-item" style={{ borderLeft: `3px solid ${color}` }}>
      <span className="grow stack-tight">
        <span className="row-tight">
          <span className="truncate strong">{s.title}</span>
          {s.sample && <SampleTag />}
        </span>
        <span className="t-small muted truncate">{label}</span>
      </span>
      <span className="stack-tight" style={{ alignItems: "flex-end" }}>
        <Pill tone={st.tone} icon={st.icon}>
          {st.label}
        </Pill>
        <span className="t-micro faint nowrap">ends {relTime(s.runtime!.plan.expiresAt, now)}</span>
      </span>
    </Link>
  );
}

function attentionItems(strategies: StrategyView[], markets: Array<{ eventKey: string; title: string; status: string }>, now: number) {
  const out: Array<{ tone: "warn" | "error" | "info"; title: string; detail: string; to?: string; cta?: string }> = [];
  for (const s of strategies) {
    if (s.status === "INVALID") out.push({ tone: "warn", title: `“${s.title}” has problems.`, detail: "Fix them before it can be reviewed.", to: `/futures/${s.id}/edit`, cta: "Fix" });
    if (s.status === "ACTIVATION_FAILED") out.push({ tone: "error", title: `“${s.title}” wasn't activated.`, detail: s.lastError ?? "No funds were reserved.", to: `/futures/${s.id}/review`, cta: "Review again" });
    if (s.lastError && (s.status === "ACTIVE" || s.status === "PAUSED")) out.push({ tone: "warn", title: `A step in “${s.title}” didn't execute.`, detail: `${s.lastError}. Nothing was spent.`, to: `/futures/${s.id}` });
    if (s.runtime && s.status === "ACTIVE" && s.runtime.plan.expiresAt - now < 3 * 86_400 && s.runtime.plan.expiresAt > now)
      out.push({ tone: "info", title: `“${s.title}” expires ${relTime(s.runtime.plan.expiresAt, now)}.`, detail: "Anything unspent returns to available then.", to: `/futures/${s.id}` });
    if (s.status === "READY" && !s.runtime) out.push({ tone: "info", title: `“${s.title}” is ready to review.`, detail: "Nothing is reserved until you sign.", to: `/futures/${s.id}/review`, cta: "Review" });
  }
  for (const m of markets) {
    if (m.status !== "disputed") continue;
    const hit = strategies.find((s) => s.doc.events.some((e) => e.eventKey === m.eventKey) && (s.status === "ACTIVE" || s.status === "PAUSED"));
    if (hit) out.push({ tone: "warn", title: `${m.title} is disputed.`, detail: `“${hit.title}” waits until it's final, or refunds at expiry.`, to: `/futures/${hit.id}` });
  }
  return out.slice(0, 6);
}
