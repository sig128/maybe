import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { bytesToHex, type ScenarioValue } from "@maybe/core";
import { useBackend } from "../data/BackendContext.tsx";
import { useEnvironment, usePolicies, useStrategy } from "../data/queries.ts";
import { PathsDiagram } from "../components/PathsDiagram.tsx";
import { Banner, Button, ErrorBlock, KV, LoadingBlock, Pill } from "../components/ui.tsx";
import { Modal } from "../components/Overlay.tsx";
import { Icon } from "../components/Icon.tsx";
import { toast } from "../components/Toast.tsx";
import { TxSteps } from "../components/TxSteps.tsx";
import { Amount } from "../components/Amount.tsx";
import type { Prepared } from "../data/types.ts";

export function Review() {
  const { id } = useParams();
  const q = useStrategy(id);
  const backend = useBackend();
  const navigate = useNavigate();
  const { data: env } = useEnvironment();
  const { data: policies } = usePolicies();
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [checks, setChecks] = useState({ worst: false, final: false });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [showBytes, setShowBytes] = useState(false);
  const s = q.data;
  useEffect(() => {
    if (!s) return;
    let live = true;
    void backend.prepare(s.doc).then((p) => live && setPrep(p));
    return () => {
      live = false;
    };
  }, [s?.doc, backend]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (s?.status === "ACTIVE" && busy) {
      setBusy(false);
      toast({ title: "Authorized", detail: "Funds are reserved and the vault program now enforces this plan.", tone: "ok" });
      navigate(`/futures/${s.id}`, { replace: true });
    }
    if (s?.status === "ACTIVATION_FAILED" && busy) setBusy(false);
  }, [s?.status, busy, navigate, s?.id]);
  const activePolicy = (policies ?? []).find((p) => !p.revoked);

  if (q.isLoading || (s && !prep)) return <div className="page"><LoadingBlock lines={8} label="Preparing the authorization" /></div>;
  if (q.error) return <div className="page"><ErrorBlock error={q.error} /></div>;
  if (!s) return <div className="page"><Banner tone="warn">Unknown future.</Banner></div>;
  if (s.runtime && !busy)
    return (
      <div className="page">
        <Banner tone="info" action={<Link className="btn btn-sm" to={`/futures/${s.id}`}>Open</Link>}>
          This future is already authorized.
        </Banner>
      </div>
    );
  const a = prep!.authorization;
  const errors = prep!.issues.filter((i) => i.severity === "error");
  const funding = errors.find((i) => i.code === "INSUFFICIENT_AVAILABLE");
  const planErrors = errors.filter((i) => i.code !== "INSUFFICIENT_AVAILABLE");
  const signReason = planErrors.length
    ? `Fix ${planErrors.length} problem${planErrors.length === 1 ? "" : "s"} in the builder first`
    : funding
      ? "Not enough available funds"
      : !checks.worst || !checks.final
        ? "Confirm both statements above"
        : busy
          ? "Submitting…"
          : null;

  if (!a || !prep!.report || !prep!.plan) {
    return (
      <div className="page">
        <Banner tone="error" action={<Link className="btn btn-sm" to={`/futures/${s.id}/edit`}>Open builder</Link>}>
          This future can't be compiled yet: {errors[0]?.message ?? "unknown problem"}
        </Banner>
      </div>
    );
  }
  const report = prep!.report!;
  const path = selected !== null ? report.paths[selected] : null;

  const sign = async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      await backend.authorize(s.id, prep!.hash!);
    } catch (e) {
      setBusy(false);
      toast({ title: "Not submitted", detail: (e as Error).message, tone: "error" });
    }
  };
  const fundWithPolicy = async () => {
    if (!activePolicy) return;
    setBusy(true);
    try {
      await backend.fundWithPolicy(s.id, activePolicy.address);
    } catch (e) {
      setBusy(false);
      toast({ title: "Outside the policy", detail: (e as Error).message, tone: "error" });
    }
  };

  return (
    <div className="page">
      <div className="stack-tight">
        <Link to={`/futures/${s.id}/edit`} className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", marginLeft: -10 }}>
          <Icon name="chevronLeft" size={16} /> Back to builder
        </Link>
        <h2 className="t-display">{s.title}</h2>
        <p className="t-read muted">{a.headline}. Read it once — this is exactly what the vault program will enforce.</p>
      </div>
      <div className="review">
        <div className="stack-loose" style={{ minWidth: 0 }}>
          <section className="panel" aria-labelledby="paths-h">
            <div className="panel-head">
              <h3 id="paths-h" className="t-head">
                Every way this can go
              </h3>
              <span className="t-small faint">tap a path for details</span>
            </div>
            <PathsDiagram report={report} plan={prep!.plan!} doc={s.doc} selected={selected} onSelect={setSelected} />
            {path && (
              <div className="panel panel-raised" aria-live="polite">
                <strong className="t-small">{path.description}</strong>
                <ul className="stack-tight t-small">
                  {path.representative.executed.length === 0 && <li className="muted">No step executes on this path.</li>}
                  {path.representative.executed.map((e) => (
                    <li key={e.action}>
                      {s.doc.actions[e.action]?.label ?? `Step ${e.action + 1}`}
                      {e.runs > 1 ? ` × ${e.runs}` : ""} — uses <Amount units={e.spent} mint={prep!.plan!.mints[prep!.plan!.actions[e.action]!.inMint]!} />
                      {e.fees > 0n && (
                        <span className="muted">
                          {" "}
                          (fee <Amount units={e.fees} mint={prep!.plan!.mints[prep!.plan!.actions[e.action]!.inMint]!} />)
                        </span>
                      )}
                    </li>
                  ))}
                  {Object.entries(path.representative.refunded)
                    .filter(([, v]) => v > 0n)
                    .map(([m, v]) => (
                      <li key={m} className="muted">
                        Returned to available {path.representative.end === "EXPIRED" ? "at expiry" : "when complete"}: <Amount units={v} mint={m} />
                      </li>
                    ))}
                </ul>
                <p className="t-micro faint">Amounts received are the guaranteed minimums. The simulation assumes events become final one after another; real timing only matters for delays, schedules and vetoes.</p>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="steps-h">
            <h3 id="steps-h" className="t-head">
              What you're authorizing
            </h3>
            <div>
              {a.steps.map((st) => (
                <div key={st.index} className="statement">
                  <span className="statement-index">{st.index + 1}</span>
                  <div className="stack-tight">
                    <p>
                      <span className="muted">When </span>
                      {st.when}
                      <span className="muted">, </span>
                      <strong>{st.does.charAt(0).toLowerCase() + st.does.slice(1)}</strong>.
                    </p>
                    <p className="t-small faint">From {st.allocation}</p>
                    <ul className="stack-tight t-small muted" style={{ marginTop: 4 }}>
                      {st.limits.map((l, i) => (
                        <li key={i} className="row-tight" style={{ alignItems: "flex-start" }}>
                          <Icon name="lock" size={13} style={{ marginTop: 3, flex: "none" }} />
                          <span>{l}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel" aria-labelledby="events-h">
            <h3 id="events-h" className="t-head">
              Events and their rules
            </h3>
            {a.events.length === 0 && <p className="muted t-small">No events — this future depends only on receipts or time.</p>}
            {a.events.map((e) => (
              <div key={e.key} className="stack-tight" style={{ paddingTop: 8 }}>
                <p>
                  <span className="tok-ref" style={{ background: "var(--c-s4)", color: "var(--c-text)", marginRight: 8 }}>
                    {e.label}
                  </span>
                  {e.title}
                </p>
                <KV
                  items={[
                    ["Resolved by", e.trust],
                    ["Venue", e.venue],
                    ["Rules version", <span className="mono">{e.ruleHash ? `${e.ruleHash.slice(0, 20)}…` : "unknown"}</span>],
                    ["Event account", <span className="mono">{e.key.slice(0, 8)}…{e.key.slice(-6)}</span>],
                  ]}
                />
              </div>
            ))}
            <ul className="stack-tight t-small muted">
              {a.outcomes.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          </section>

          <div className="grid-2">
            <section className="panel" aria-labelledby="cancel-h">
              <h3 id="cancel-h" className="t-head">
                Cancelling
              </h3>
              <ul className="stack-tight t-small muted">
                {a.cancellation.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
            <section className="panel" aria-labelledby="fail-h">
              <h3 id="fail-h" className="t-head">
                If something fails
              </h3>
              <ul className="stack-tight t-small muted">
                {a.failure.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          </div>

          <section className="panel" aria-labelledby="enf-h">
            <h3 id="enf-h" className="t-head">
              How it's enforced
            </h3>
            <ul className="stack-tight t-small muted">
              {a.enforcement.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <KV
              items={[
                ["Plan hash", <span className="mono" style={{ wordBreak: "break-all" }}>{a.planHash}</span>],
                ["Size", `${a.sizeBytes} bytes (${Math.ceil(a.sizeBytes / 800)} upload part${a.sizeBytes > 800 ? "s" : ""})`],
                ["Dependencies", <ul className="stack-tight">{a.dependencies.map((d) => <li key={d} className="t-small">{d}</li>)}</ul>],
              ]}
            />
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} aria-expanded={showBytes} onClick={() => setShowBytes((x) => !x)}>
              {showBytes ? "Hide the bytes" : "Show the exact bytes you sign"}
            </button>
            {showBytes && prep!.bytes && (
              <pre className="mono t-micro" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--c-s2)", padding: 12, borderRadius: 8, maxHeight: 220, overflow: "auto" }}>
                {bytesToHex(prep!.bytes).replace(/(.{64})/g, "$1\n")}
              </pre>
            )}
          </section>
        </div>

        <aside className="review-aside" aria-label="Authorize">
          <div className="panel panel-raised">
            <h3 className="t-head">Authorize</h3>
            <KV
              items={[
                ["Reserves", <span className="stack-tight">{a.reserved.map((r) => <span key={r.label} className="num">{r.value}</span>)}</span>],
                ["Worst case", <span className="stack-tight">{a.worstCaseSpend.length ? a.worstCaseSpend.map((r) => <span key={r.label} className="num">{r.value} can leave</span>) : <span>Nothing can leave</span>}</span>],
                ["Max fees", <span className="stack-tight">{a.maxFees.length ? a.maxFees.map((r) => <span key={r.label} className="num">{r.value}</span>) : "None"}</span>],
                ...(a.maxToRecipients.length ? ([["Paid to others", <span className="stack-tight">{a.maxToRecipients.map((r, i) => <span key={i} className="num">{r.value} → {r.label}</span>)}</span>]] as Array<[string, React.ReactNode]>) : []),
                ["Expires", a.expiresText],
                ["Environment", env?.label ?? ""],
              ]}
            />
            {a.warnings.map((w, i) => (
              <Banner key={i} tone="warn">
                {w}
              </Banner>
            ))}
            {planErrors.length > 0 && (
              <Banner tone="error" action={<Link className="btn btn-sm" to={`/futures/${s.id}/edit`}>Fix</Link>}>
                {planErrors[0]!.message}
              </Banner>
            )}
            {funding && (
              <Banner tone="warn" action={<Link className="btn btn-sm" to="/money?action=deposit">Deposit</Link>}>
                {funding.message}
              </Banner>
            )}
            <label className="check-row">
              <input type="checkbox" checked={checks.worst} onChange={(e) => setChecks((c) => ({ ...c, worst: e.target.checked }))} />
              <span>I understand that in the worst case {a.worstCaseSpend.map((r) => r.value).join(" + ") || "nothing"} can leave my vault, and assets it buys can lose value.</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={checks.final} onChange={(e) => setChecks((c) => ({ ...c, final: e.target.checked }))} />
              <span>I understand executed steps can't be reversed and fees aren't refunded. Edits need a new signature.</span>
            </label>
            <Button variant="primary" size="lg" block disabledReason={signReason} onClick={() => setConfirmOpen(true)}>
              Sign and reserve
            </Button>
            {activePolicy && (
              <Button variant="outline" size="sm" block disabledReason={signReason} onClick={fundWithPolicy}>
                Fund with agent session under “{activePolicy.label}”
              </Button>
            )}
            {s.pendingTx && <TxSteps txs={s.pendingTx} />}
            {s.status === "ACTIVATION_FAILED" && s.lastError && (
              <Banner tone="error">
                {s.lastError} You can sign again.
              </Banner>
            )}
          </div>
          <p className="t-micro faint">
            Plan {a.planHash.slice(0, 12)}… · {report.combos} outcome combinations checked
          </p>
        </aside>
      </div>

      <Modal open={confirmOpen} onOpenChange={setConfirmOpen} title={env?.mode === "simulation" ? "Simulated wallet signature" : "Confirm in your wallet"} description={env?.mode === "simulation" ? "No keys exist in simulation. This stands in for your wallet's approval screen." : "Your wallet will show the transactions. Check the plan hash matches."}>
        <KV
          items={[
            ["Plan hash", <span className="mono" style={{ wordBreak: "break-all" }}>{a.planHash}</span>],
            ["Reserves", a.reserved.map((r) => r.value).join(" + ")],
            ["Transactions", `Upload plan (${Math.ceil(a.sizeBytes / 800)} part${a.sizeBytes > 800 ? "s" : ""}), then activate and reserve`],
          ]}
        />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={sign}>
            Sign
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export type { ScenarioValue };
export { Pill };
