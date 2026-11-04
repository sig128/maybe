import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { actionVerb, conditionTokens, effectiveEvent, type ScenarioValue } from "@maybe/core";
import { useBackend } from "../data/BackendContext.tsx";
import { useAssetMap, useMarkets, useNow, useStrategy } from "../data/queries.ts";
import { PathsDiagram } from "../components/PathsDiagram.tsx";
import { Amount } from "../components/Amount.tsx";
import { Banner, Button, ErrorBlock, KV, LoadingBlock, Pill, SampleTag } from "../components/ui.tsx";
import { Modal } from "../components/Overlay.tsx";
import { toast } from "../components/Toast.tsx";
import { TxSteps } from "../components/TxSteps.tsx";
import { eventDisplay, readinessDisplay, STRATEGY_STATUS } from "../lib/status.ts";
import { fmtDateTime, relTime } from "../lib/time.ts";
import type { Prepared, StrategyView } from "../data/types.ts";

function condText(s: StrategyView, nodeId: string) {
  return conditionTokens(s.doc, nodeId)
    .map((t) => ("text" in t ? t.text : t.t === "event" ? t.ref : t.t === "outcome" ? t.outcome : ""))
    .join(" ")
    .replace(/\s+([,:])/g, "$1");
}

export function StrategyDetail() {
  const { id } = useParams();
  const q = useStrategy(id);
  const backend = useBackend();
  const navigate = useNavigate();
  const now = useNow(1000);
  const assets = useAssetMap();
  const { data: markets } = useMarkets();
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = q.data;
  useEffect(() => {
    if (s?.runtime) void backend.prepare(s.doc).then(setPrep);
  }, [s?.doc, s?.runtime, backend]); // eslint-disable-line react-hooks/exhaustive-deps
  const known = useMemo(() => {
    if (!s) return [] as Array<ScenarioValue | null>;
    return s.doc.events.map((e) => {
      const m = markets?.find((x) => x.eventKey === e.eventKey);
      const eff = effectiveEvent(m?.resolution, now);
      return eff.final ? ((eff.outcome === "VOID" ? "VOID" : eff.outcome) as ScenarioValue) : null;
    });
  }, [s, markets, now]);
  if (q.isLoading) return <div className="page"><LoadingBlock lines={6} /></div>;
  if (q.error) return <div className="page"><ErrorBlock error={q.error} /></div>;
  if (!s) return <div className="page"><Banner tone="warn">Unknown future. <Link className="link" to="/futures">All futures</Link></Banner></div>;
  if (!s.runtime && !s.pendingTx) return <Navigate to={`/futures/${s.id}/edit`} replace />;
  const st = STRATEGY_STATUS[s.status];
  const rt = s.runtime;
  const open = s.status === "ACTIVE" || s.status === "PAUSED";
  const holdings = new Map<string, bigint>();
  rt?.holdings.forEach((row) => row.forEach((u, mi) => u > 0n && holdings.set(rt.plan.mints[mi]!, (holdings.get(rt.plan.mints[mi]!) ?? 0n) + u)));
  // paths consistent with what is already final
  const consistent = prep?.report?.paths.map((p) => p.boxes.some((box) => box.every((vals, i) => known[i] === null || known[i] === undefined || vals === null || vals.includes(known[i]!)))) ?? [];
  const liveIdx = consistent.filter(Boolean).length === 1 ? consistent.indexOf(true) : null;
  const act = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await f();
      toast({ title: ok, tone: "ok" });
    } catch (e) {
      toast({ title: "Couldn't do that", detail: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="page-head">
        <div className="stack-tight">
          <div className="row-tight">
            <Pill tone={st.tone} icon={st.icon}>
              {st.label}
            </Pill>
            {s.sample && <SampleTag />}
            {rt && <span className="t-small muted">{open ? `ends ${relTime(rt.plan.expiresAt, now)}` : `closed ${rt.closedAt ? relTime(rt.closedAt, now) : ""}`}</span>}
          </div>
          <h2 className="t-display">{s.title}</h2>
          {s.doc.thesis && <p className="muted measure">{s.doc.thesis}</p>}
        </div>
        <div className="row row-wrap">
          {open && (
            <Button variant="outline" icon={s.status === "PAUSED" ? "play" : "pause"} disabledReason={busy ? "Working…" : null} onClick={() => act(() => backend.pause(s.id, s.status !== "PAUSED"), s.status === "PAUSED" ? "Resuming" : "Pausing")}>
              {s.status === "PAUSED" ? "Resume" : "Pause"}
            </Button>
          )}
          {open && (
            <Button variant="danger" icon="close" disabledReason={s.doc.cancelPolicy === "locked-until-expiry" && rt && now < rt.plan.expiresAt ? "This plan locks cancellation until expiry" : busy ? "Working…" : null} onClick={() => setCancelOpen(true)}>
              Cancel
            </Button>
          )}
          <Link className="btn" to={`/futures/${s.id}/edit`}>
            {open ? "View rules" : "Rules"}
          </Link>
          <Button variant="ghost" icon="rooms" onClick={() => setPublishOpen(true)}>
            Publish
          </Button>
        </div>
      </div>
      {s.pendingTx && (
        <div className="panel">
          <TxSteps txs={s.pendingTx} />
        </div>
      )}
      {s.lastError && open && <Banner tone="warn">{s.lastError}. Nothing was spent; the keeper retries until the step's deadline.</Banner>}
      {s.status === "PAUSED" && <Banner tone="warn">Paused: no new steps run. Funds stay reserved. Cancelling releases them.</Banner>}

      <div className="split">
        <div className="stack-loose" style={{ minWidth: 0 }}>
          <section className="panel" aria-labelledby="steps">
            <h3 id="steps" className="t-head">
              Steps
            </h3>
            <div className="timeline">
              {s.doc.actions.map((a, i) => {
                const r = s.readiness[i];
                const runs = rt?.actions[i];
                // once the future closes every step reads "closed"; say what actually happened instead
                const d =
                  r?.state === "done" && r.reason === "STRATEGY_CLOSED"
                    ? runs && runs.executedRuns > 0
                      ? { tone: "neutral" as const, icon: "check" as const, label: "Done" }
                      : { tone: "neutral" as const, icon: "close" as const, label: "Didn't run" }
                    : readinessDisplay(r, now);
                const marker = runs && runs.executedRuns > 0 && r?.state === "done" ? "done" : r?.state === "executable" ? "live" : r?.state === "scheduled" || r?.state === "blocked" ? "pending" : r?.state === "done" ? "skip" : "idle";
                const receipts = s.receipts.filter((x) => x.action === i);
                return (
                  <div key={a.id} className="step-row">
                    <span className="step-marker" data-state={marker} aria-hidden="true" />
                    <div className="stack-tight" style={{ minWidth: 0 }}>
                      <span className="strong">{a.label ?? actionVerb(a, (m) => assets.get(m))}</span>
                      <span className="t-small muted">When {condText(s, a.guard)}</span>
                      {receipts.map((rc) => (
                        <span key={`${rc.execNonce}`} className="t-small">
                          Run {rc.run + 1}: used <Amount units={rc.amount} mint={rc.inMint} />
                          {rc.outMint ? (
                            <>
                              {" "}
                              → got <Amount units={rc.amountOut} mint={rc.outMint} />
                            </>
                          ) : null}
                          {rc.fee > 0n && (
                            <span className="faint">
                              {" "}
                              · fee <Amount units={rc.fee} mint={rc.inMint} />
                            </span>
                          )}
                          <span className="faint"> · {fmtDateTime(rc.at)}</span>
                        </span>
                      ))}
                      {runs && rt && rt.plan.actions[i]!.runs > 1 && (
                        <span className="t-micro faint">
                          {runs.executedRuns} of {rt.plan.actions[i]!.runs} runs executed{runs.runsDone > runs.executedRuns ? `, ${runs.runsDone - runs.executedRuns} skipped` : ""}
                        </span>
                      )}
                    </div>
                    <Pill tone={d.tone} icon={d.icon}>
                      {d.label}
                    </Pill>
                  </div>
                );
              })}
            </div>
          </section>
          {prep?.report && prep.plan && (
            <section className="panel" aria-labelledby="paths">
              <div className="panel-head">
                <h3 id="paths" className="t-head">
                  Paths still possible
                </h3>
                <span className="t-small faint">{consistent.filter(Boolean).length} of {prep.report.paths.length}</span>
              </div>
              <PathsDiagram report={{ ...prep.report, paths: prep.report.paths.filter((_, i) => consistent[i]) }} plan={prep.plan} doc={s.doc} live={liveIdx !== null ? consistent.slice(0, liveIdx).filter(Boolean).length : null} />
            </section>
          )}
        </div>
        <div className="stack-loose">
          <section className="panel" aria-labelledby="held">
            <h3 id="held" className="t-head">
              Held by this future
            </h3>
            {holdings.size === 0 ? (
              <p className="muted t-small">Nothing — everything has been spent or returned.</p>
            ) : (
              <ul className="stack">
                {[...holdings.entries()].map(([m, u]) => (
                  <li key={m} className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">{assets.get(m)?.symbol}</span>
                    <Amount units={u} mint={m} />
                  </li>
                ))}
              </ul>
            )}
            <p className="t-micro faint">Part of your vault's reserved balance. Returns to available when released, cancelled or at expiry.</p>
          </section>
          <section className="panel" aria-labelledby="events">
            <h3 id="events" className="t-head">
              Events
            </h3>
            <ul className="stack">
              {s.doc.events.map((e) => {
                const m = markets?.find((x) => x.eventKey === e.eventKey);
                const d = eventDisplay(m?.resolution, now);
                return (
                  <li key={e.ref}>
                    <Link to={`/discover?market=${m?.key ?? ""}`} className="row" style={{ alignItems: "flex-start" }}>
                      <span className="tok-ref" style={{ background: "var(--c-s4)", color: "var(--c-text)" }}>
                        {e.ref}
                      </span>
                      <span className="grow t-small">{e.title}</span>
                      <Pill tone={d.tone} icon={d.icon}>
                        {d.label}
                      </Pill>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
          {s.authorization && (
            <section className="panel" aria-labelledby="auth">
              <h3 id="auth" className="t-head">
                Authorization
              </h3>
              <KV
                items={[
                  ["Plan hash", <span className="mono">{s.authorization.hash.slice(0, 18)}…</span>],
                  ["Signed", s.authorization.signedAt ? fmtDateTime(s.authorization.signedAt) : "—"],
                  ["Created by", rt?.createdBy.kind === "policy" ? "Agent session under a policy" : "You"],
                  ["Size", `${s.authorization.size} bytes`],
                ]}
              />
            </section>
          )}
        </div>
      </div>

      <Modal open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel this future?" description="Everything not yet spent returns to your available balance.">
        <ul className="stack-tight">
          {[...holdings.entries()].map(([m, u]) => (
            <li key={m} className="row" style={{ justifyContent: "space-between" }}>
              <span className="muted">Returns</span>
              <Amount units={u} mint={m} />
            </li>
          ))}
        </ul>
        <p className="t-small muted">Completed trades are not reversed and fees are not refunded. To stop new steps without releasing funds, pause instead.</p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setCancelOpen(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setCancelOpen(false);
              void act(() => backend.cancel(s.id), "Cancelling — funds return when it confirms");
            }}
          >
            Cancel and release
          </Button>
        </div>
      </Modal>
      <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} strategy={s} onDone={(slug) => navigate(`/rooms/${slug}`)} />
    </div>
  );
}

export function PublishDialog({ open, onOpenChange, strategy, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; strategy: StrategyView; onDone: (slug: string) => void }) {
  const backend = useBackend();
  const [thesis, setThesis] = useState(strategy.doc.thesis ?? "");
  const [risk, setRisk] = useState("");
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Publish to Future Rooms" description="People can copy these rules into their own vaults. They never get your funds, holdings or spending authority.">
      <label className="field">
        <span className="label">Thesis</span>
        <textarea className="textarea" value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="Why you'd run this future" />
      </label>
      <label className="field">
        <span className="label">Risks, one per line</span>
        <textarea className="textarea" value={risk} onChange={(e) => setRisk(e.target.value)} placeholder={"Depends on trusted attestation\nBuys a volatile token"} />
      </label>
      <p className="t-small muted">Publishing creates an immutable version. Later edits publish a new version; existing copies keep the version they took.</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button
          variant="primary"
          disabledReason={thesis.trim().length < 10 ? "Write a thesis of at least 10 characters" : null}
          onClick={async () => {
            try {
              const r = await backend.publishRoom(strategy.id, thesis.trim(), risk.split("\n").map((x) => x.trim()).filter(Boolean));
              onOpenChange(false);
              toast({ title: "Published", tone: "ok" });
              onDone(r.slug);
            } catch (e) {
              toast({ title: "Couldn't publish", detail: (e as Error).message, tone: "error" });
            }
          }}
        >
          Publish version
        </Button>
      </div>
    </Modal>
  );
}
