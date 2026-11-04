import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useBackend } from "../data/BackendContext.tsx";
import { useAssetMap, useNow, useRoom, useRooms, useStrategies } from "../data/queries.ts";
import { Banner, Button, Empty, ErrorBlock, LoadingBlock, Pill, SampleTag } from "../components/ui.tsx";
import { Amount } from "../components/Amount.tsx";
import { PageHead } from "../app/Shell.tsx";
import { SentenceView } from "./builder/SentenceView.tsx";
import { indexIssues } from "./builder/model.ts";
import { PathsDiagram } from "../components/PathsDiagram.tsx";
import { PublishDialog } from "./StrategyDetail.tsx";
import { toast } from "../components/Toast.tsx";
import { fmtDate, relTime } from "../lib/time.ts";
import type { Prepared, RoomRecord, StrategyView } from "../data/types.ts";

const RECORD: Record<RoomRecord["record"]["kind"], string> = { live: "Live results", paper: "Paper simulation", backtest: "Backtest", none: "No track record" };

export function Rooms() {
  const q = useRooms();
  const now = useNow(60_000);
  const { data: strategies } = useStrategies();
  const [pick, setPick] = useState<StrategyView | null>(null);
  const navigate = useNavigate();
  const publishable = (strategies ?? []).filter((s) => s.status !== "INVALID");
  return (
    <div className="page">
      <PageHead
        title="Future Rooms"
        sub="Published theses with their exact rules. Copy one into your own vault — you get the rules, never the author's funds, holdings or authority."
        actions={
          publishable.length > 0 && (
            <select className="select" style={{ width: "auto" }} aria-label="Publish one of your futures" value="" onChange={(e) => setPick(publishable.find((s) => s.id === e.target.value) ?? null)}>
              <option value="">Publish a future…</option>
              {publishable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )
        }
      />
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} />
      ) : (q.data ?? []).length === 0 ? (
        <Empty title="No rooms yet">Publish one of your futures to start a room.</Empty>
      ) : (
        <div className="cards">
          {q.data!.map((r) => {
            const v = r.versions[r.versions.length - 1]!;
            return (
              <Link key={r.id} to={`/rooms/${r.slug}`} className="card-link">
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <strong className="grow">{r.title}</strong>
                  {r.sample && <SampleTag />}
                </div>
                <p className="t-small muted" style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {v.thesis}
                </p>
                <div className="row-tight row-wrap t-micro faint">
                  <Pill tone="quiet">{RECORD[r.record.kind]}</Pill>
                  <span>v{v.version}</span>
                  <span>· {r.copies ? `${r.copies} cop${r.copies === 1 ? "y" : "ies"}` : "no copies yet"}</span>
                  <span>· {relTime(v.publishedAt, now)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {pick && <PublishDialog open onOpenChange={(o) => !o && setPick(null)} strategy={pick} onDone={(slug) => navigate(`/rooms/${slug}`)} />}
    </div>
  );
}

export function RoomDetail() {
  const { slug } = useParams();
  const q = useRoom(slug);
  const backend = useBackend();
  const navigate = useNavigate();
  const assets = useAssetMap();
  const [ver, setVer] = useState<number | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const r = q.data;
  const v = r ? (r.versions.find((x) => x.version === ver) ?? r.versions[r.versions.length - 1]!) : null;
  useEffect(() => {
    if (v) void backend.prepare(v.doc).then(setPrep);
  }, [v, backend]);
  if (q.isLoading) return <div className="page"><LoadingBlock /></div>;
  if (!r || !v) return <div className="page"><Banner tone="warn">This room doesn't exist.</Banner></div>;
  const copy = async () => {
    try {
      const s = await backend.cloneRoom(r.slug, v.version);
      toast({ title: "Copied into your futures", detail: "It's an unfunded draft in your own vault. Review and sign it yourself.", tone: "ok" });
      navigate(`/futures/${s.id}/edit`);
    } catch (e) {
      toast({ title: "Couldn't copy", detail: (e as Error).message, tone: "error" });
    }
  };
  const reserved = v.doc.allocations;
  return (
    <div className="page">
      <div className="page-head">
        <div className="stack-tight">
          <div className="row-tight row-wrap t-small muted">
            <span>by {r.author}</span>
            {r.sample && <SampleTag />}
            <span>· published {fmtDate(v.publishedAt, true)}</span>
          </div>
          <h2 className="t-display">{r.title}</h2>
          <p className="t-read measure">{v.thesis}</p>
        </div>
        <div className="row row-wrap">
          <Button variant="primary" icon="copy" onClick={() => void copy()}>
            Copy into my futures
          </Button>
          <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(location.href).then(() => toast({ title: "Link copied", detail: "The link shows rules and thesis only — never holdings." }))}>
            Copy link
          </Button>
        </div>
      </div>
      {r.versions.length > 1 && (
        <div className="segmented" role="tablist" aria-label="Version">
          {r.versions.map((x) => (
            <button key={x.version} role="tab" aria-selected={x.version === v.version} onClick={() => setVer(x.version)}>
              v{x.version}
            </button>
          ))}
        </div>
      )}
      <div className="split">
        <div className="stack-loose" style={{ minWidth: 0 }}>
          <section className="panel" aria-labelledby="rules">
            <h3 id="rules" className="t-head">
              Exact rules · v{v.version}
            </h3>
            <SentenceView doc={v.doc} assets={assets} issues={indexIssues([])} selected={null} onSelect={() => undefined} onOp={() => undefined} readOnly />
            <p className="t-micro faint mono">plan {v.hash.slice(0, 24)}…</p>
          </section>
          {prep?.report && prep.plan && (
            <section className="panel" aria-labelledby="rpaths">
              <h3 id="rpaths" className="t-head">
                Every way it can go
              </h3>
              <PathsDiagram report={prep.report} plan={prep.plan} doc={v.doc} />
            </section>
          )}
        </div>
        <div className="stack-loose">
          <section className="panel">
            <h3 className="t-head">Reserves</h3>
            {reserved.map((a) => (
              <div key={a.id} className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted t-small">{a.label}</span>
                <Amount units={BigInt(a.amount)} mint={a.mint} />
              </div>
            ))}
            <p className="t-micro faint">Your copy starts with these amounts; change them before signing.</p>
          </section>
          <section className="panel">
            <h3 className="t-head">Risks</h3>
            <ul className="stack-tight t-small">
              {v.risk.length ? v.risk.map((x, i) => <li key={i}>{x}</li>) : <li className="muted">The author listed none. Read the paths yourself.</li>}
            </ul>
          </section>
          <section className="panel">
            <div className="row">
              <h3 className="t-head grow">Track record</h3>
              <Pill tone="quiet">{RECORD[r.record.kind]}</Pill>
            </div>
            <p className="t-small muted">{r.record.note}</p>
            <ul className="stack">
              {r.record.outcomes.map((o, i) => (
                <li key={i} className="row" style={{ alignItems: "flex-start" }}>
                  <Pill tone={o.result === "won" ? "live" : o.result === "lost" ? "error" : o.result === "refunded" ? "quiet" : "pending"}>{o.result}</Pill>
                  <span className="t-small">
                    <span className="strong">{o.label}.</span> <span className="muted">{o.detail}</span>
                  </span>
                </li>
              ))}
              {r.record.outcomes.length === 0 && <li className="t-small faint">Nothing recorded.</li>}
            </ul>
            <p className="t-micro faint">Costs and fees are included in any listed results. Open exposure is shown as open.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
