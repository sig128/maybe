import { useState } from "react";
import { Link } from "react-router";
import { assetSupport } from "@maybe/core";
import { useAssets, useEnvironment, useNow, useOps } from "../data/queries.ts";
import { Banner, Button, ErrorBlock, KV, LoadingBlock, Pill } from "../components/ui.tsx";
import { PageHead } from "../app/Shell.tsx";
import { fmtDateTime, relTime } from "../lib/time.ts";

export function Ops() {
  const q = useOps();
  const now = useNow(2000);
  if (q.isLoading) return <div className="page"><LoadingBlock /></div>;
  if (q.error || !q.data) return <div className="page"><ErrorBlock error={q.error} /></div>;
  const o = q.data;
  return (
    <div className="page">
      <PageHead title="Operations" sub="Keeper, queued steps, reconciliation between the ledger and actual balances, and service health." />
      <div className="grid-3">
        {o.health.map((h) => (
          <div key={h.name} className="panel">
            <div className="row">
              <strong className="grow">{h.name}</strong>
              <Pill tone={h.ok ? "live" : "error"} icon={h.ok ? "check" : "alert"}>
                {h.ok ? "OK" : "Problem"}
              </Pill>
            </div>
            <p className="t-small muted">{h.detail}</p>
          </div>
        ))}
      </div>
      <section className="panel">
        <div className="row">
          <h3 className="t-head grow">Keeper</h3>
          <Pill tone={o.keeper.running ? "live" : "pending"} icon={o.keeper.running ? "dot" : "pause"}>
            {o.keeper.running ? "Running" : "Stopped"}
          </Pill>
        </div>
        <KV items={[["Last tick", `${relTime(o.keeper.lastTickAt, now)} (${fmtDateTime(o.keeper.lastTickAt)})`], ["Ticks", <span className="num">{o.keeper.ticks}</span>], ["Mode", o.mode]]} />
        <p className="t-small faint">The keeper is a permissionless crank: it can only submit steps the vault program already allows. Re-running a step that already executed fails on-chain.</p>
      </section>
      <section className="panel panel-flush">
        <h3 className="t-head" style={{ padding: "16px 20px 0" }}>
          Background work
        </h3>
        {o.jobs.length === 0 ? (
          <p className="muted t-small" style={{ padding: 20 }}>
            Nothing pending.
          </p>
        ) : (
          <div className="scroll-x" role="region" aria-label="Background work (scrolls sideways)" tabIndex={0}>
            <table className="table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>State</th>
                  <th className="right">Due</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {o.jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="truncate" style={{ maxWidth: 320 }}>
                      {j.kind}
                    </td>
                    <td>
                      <Pill tone={j.state === "queued" || j.state === "running" ? "live" : j.state === "stopped" ? "error" : j.state === "blocked" || j.state === "retrying" || j.state === "waiting" || j.state === "scheduled" ? "pending" : "quiet"}>{j.state}</Pill>
                    </td>
                    <td className="right t-small">{relTime(j.runAt, now)}</td>
                    <td className="t-small muted">{j.lastError ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <h3 className="t-head">Reconciliation</h3>
        <ul className="stack">
          {o.reconciliation.slice(0, 8).map((r, i) => (
            <li key={i} className="row t-small">
              <Pill tone={r.ok ? "live" : "error"} icon={r.ok ? "check" : "alert"}>
                {r.ok ? "Balanced" : "Mismatch"}
              </Pill>
              <span className="grow">{r.detail}</span>
              <span className="faint nowrap">{relTime(r.at, now)}</span>
            </li>
          ))}
          {o.reconciliation.length === 0 && <li className="muted t-small">No checks yet.</li>}
        </ul>
      </section>
    </div>
  );
}

export function Settings() {
  const { data: env } = useEnvironment();
  const { data: assets } = useAssets();
  const [api, setApi] = useState(() => {
    try {
      return localStorage.getItem("maybe.api") ?? "";
    } catch {
      return "";
    }
  });
  if (!env) return <div className="page"><LoadingBlock /></div>;
  return (
    <div className="page">
      <PageHead title="Environment" sub="Where MAYBE is running, what each venue can actually do here, and which tokens a vault accepts." />
      <section className="panel">
        <div className="row">
          <h3 className="t-head grow">{env.label}</h3>
          <Pill tone={env.executionLive ? "live" : "pending"} icon="info">
            {env.executionLive ? "Execution on a chain" : "No real execution"}
          </Pill>
        </div>
        <p className="muted">{env.description}</p>
        <KV items={[["Network", env.network], ...(env.vaultProgram ? ([["Vault program", <span className="mono">{env.vaultProgram}</span>]] as Array<[string, React.ReactNode]>) : [])]} />
      </section>
      <section className="panel panel-flush">
        <h3 className="t-head" style={{ padding: "16px 20px 0" }}>
          Venues
        </h3>
        <div className="scroll-x" role="region" aria-label="Venues (scrolls sideways)" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th>Venue</th>
                <th>Markets</th>
                <th>Quotes</th>
                <th>Trading from a vault</th>
                <th>Settlement</th>
              </tr>
            </thead>
            <tbody>
              {env.venues.map((v) => (
                <tr key={v.id}>
                  <td>
                    <span className="strong">{v.label}</span>
                    <p className="t-micro faint" style={{ maxWidth: 260 }}>
                      {v.note}
                    </p>
                  </td>
                  <td className="t-small">{v.discovery}</td>
                  <td className="t-small">{v.quotes}</td>
                  <td>
                    <Pill tone={v.trading === "enabled" ? "live" : "quiet"}>{v.trading}</Pill>
                  </td>
                  <td className="t-small muted" style={{ maxWidth: 260 }}>
                    {v.settlement}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel panel-flush">
        <h3 className="t-head" style={{ padding: "16px 20px 0" }}>
          Tokens a vault accepts
        </h3>
        <div className="scroll-x" role="region" aria-label="Tokens a vault accepts (scrolls sideways)" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Program</th>
                <th>Extensions</th>
                <th>Accepted</th>
              </tr>
            </thead>
            <tbody>
              {(assets ?? []).map((a) => {
                const s = assetSupport(a);
                return (
                  <tr key={a.mint}>
                    <td>
                      <span className="strong">{a.symbol}</span>
                      <p className="t-micro faint">{a.name}</p>
                    </td>
                    <td className="t-small">{a.tokenProgram === "token-2022" ? "Token-2022" : "SPL Token"}</td>
                    <td className="t-small muted">{a.extensions.length ? a.extensions.join(", ") : "none"}</td>
                    <td className="t-small">
                      <Pill tone={s.supported ? "live" : "error"} icon={s.supported ? "check" : "close"}>
                        {s.supported ? "Yes" : "No"}
                      </Pill>
                      {s.reasons.map((r) => (
                        <p key={r} className="t-micro" style={{ color: "var(--c-red)" }}>
                          {r}
                        </p>
                      ))}
                      {s.warnings.map((w) => (
                        <p key={w} className="t-micro faint">
                          {w}
                        </p>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {import.meta.env.VITE_PUBLIC_SITE !== "1" && (
      <section className="panel">
        <h3 className="t-head">Connect to a MAYBE API</h3>
        <p className="t-small muted">Run the API and workers against a local validator (see README), then enter its URL. Leave empty for the in-browser simulation.</p>
        <div className="row row-wrap">
          <input className="input grow" style={{ minWidth: 240 }} placeholder="http://127.0.0.1:8787" value={api} onChange={(e) => setApi(e.target.value)} aria-label="API URL" />
          <Button
            onClick={() => {
              try {
                if (api.trim()) localStorage.setItem("maybe.api", api.trim());
                else localStorage.removeItem("maybe.api");
              } catch {
                /* ignore */
              }
              location.assign(import.meta.env.BASE_URL);
            }}
          >
            {api.trim() ? "Connect and reload" : "Use simulation"}
          </Button>
        </div>
        <Banner tone="info">Read-only mainnet data never means execution is live. Real funds are never routed through simulated settlement.</Banner>
      </section>
      )}
    </div>
  );
}

export function NotFound() {
  return (
    <div className="page">
      <PageHead title="Nothing here" sub="This page doesn't exist, or the link is from another environment." />
      <Link className="btn btn-primary" to="/" style={{ alignSelf: "flex-start" }}>
        Go to overview
      </Link>
    </div>
  );
}
