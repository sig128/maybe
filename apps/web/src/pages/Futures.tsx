import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { TEMPLATES, applyOp, eventRefFor, type Strategy, type TemplateInfo } from "@maybe/core";
import { useBackend } from "../data/BackendContext.tsx";
import { useMarkets, useNow, useStrategies } from "../data/queries.ts";
import { Amount } from "../components/Amount.tsx";
import { Banner, Button, Empty, ErrorBlock, LoadingBlock, Pill, SampleTag } from "../components/ui.tsx";
import { PageHead } from "../app/Shell.tsx";
import { STRATEGY_STATUS, readinessDisplay } from "../lib/status.ts";
import { relTime } from "../lib/time.ts";
import { toast } from "../components/Toast.tsx";
import type { StrategyView } from "../data/types.ts";

type Tab = "active" | "drafts" | "closed";
const TAB_STATES: Record<Tab, string[]> = {
  active: ["ACTIVE", "PAUSED", "ACTIVATING", "UPLOADING", "AWAITING_SIGNATURE"],
  drafts: ["DRAFT", "INVALID", "READY", "ACTIVATION_FAILED"],
  closed: ["COMPLETED", "EXPIRED", "CANCELLED", "SUPERSEDED"],
};

export function Futures() {
  const q = useStrategies();
  const now = useNow(10_000);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "active";
  const list = useMemo(() => (q.data ?? []).filter((s) => TAB_STATES[tab].includes(s.status)), [q.data, tab]);
  const counts = useMemo(() => Object.fromEntries((Object.keys(TAB_STATES) as Tab[]).map((t) => [t, (q.data ?? []).filter((s) => TAB_STATES[t].includes(s.status)).length])), [q.data]);
  return (
    <div className="page">
      <PageHead
        title="Futures"
        sub="Each future reserves money for what might happen, with exact rules for every outcome."
        actions={
          <Link className="btn btn-primary" to="/futures/new">
            New future
          </Link>
        }
      />
      <div className="segmented" role="tablist" aria-label="Futures">
        {(["active", "drafts", "closed"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === "active" ? {} : { tab: t }, { replace: true })}>
            {t === "active" ? "Active" : t === "drafts" ? "Drafts" : "Closed"} <span className="num faint">{counts[t] ?? 0}</span>
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} />
      ) : list.length === 0 ? (
        <Empty title={tab === "active" ? "No active futures" : tab === "drafts" ? "No drafts" : "Nothing closed yet"} action={<Link className="btn btn-primary" to="/futures/new">Start a future</Link>}>
          {tab === "active" ? "Authorized futures appear here with what each one is waiting for." : tab === "drafts" ? "Drafts are free to edit; nothing is reserved until you sign." : "Completed, expired and cancelled futures keep their receipts here."}
        </Empty>
      ) : (
        <div className="cards">
          {list.map((s) => (
            <FutureCard key={s.id} s={s} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function FutureCard({ s, now }: { s: StrategyView; now: number }) {
  const st = STRATEGY_STATUS[s.status];
  const reserved = s.doc.allocations;
  const next = s.readiness.findIndex((r) => r.state !== "done");
  const to = s.runtime ? `/futures/${s.id}` : `/futures/${s.id}/edit`;
  return (
    <Link to={to} className="card-link">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="grow strong" style={{ lineHeight: "20px" }}>
          {s.title}
        </span>
        <Pill tone={st.tone} icon={st.icon}>
          {st.label}
        </Pill>
      </div>
      <div className="row-tight row-wrap t-small">
        {reserved.map((a) => (
          <span key={a.id} className="muted">
            <Amount units={BigInt(a.amount)} mint={a.mint} />
          </span>
        ))}
        <span className="faint">· {s.doc.events.length} event{s.doc.events.length === 1 ? "" : "s"}</span>
        {s.sample && <SampleTag />}
      </div>
      <p className="t-small muted truncate">
        {s.runtime ? (next >= 0 ? `${s.doc.actions[next]?.label ?? "Next step"}: ${readinessDisplay(s.readiness[next], now).label.toLowerCase()}` : "No more steps") : s.status === "INVALID" ? "Has problems to fix" : "Not authorized — nothing reserved"}
      </p>
      <span className="t-micro faint">{s.runtime ? `Ends ${relTime(s.runtime.plan.expiresAt, now)}` : `Edited ${relTime(s.updatedAt, now)}`}</span>
    </Link>
  );
}

/** /futures/new — templates, or start from a market (?market=), or a template directly (?template=). */
export function NewFuture() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const backend = useBackend();
  const { data: markets } = useMarkets();
  const market = params.get("market");
  const template = params.get("template");
  const started = useRef(false);
  const [category, setCategory] = useState<string>("All");
  const m = markets?.find((x) => x.key === market);

  const create = async (t: TemplateInfo) => {
    try {
      const fx = await backend.fixtures();
      let doc: Strategy = t.build({ now: backend.now(), fixtures: fx, nonce: () => String(Math.floor(Math.random() * 2 ** 40)) });
      if (m && doc.events[0]) {
        const fm = fx.markets.find((x) => x.key === m.key);
        if (fm) doc = applyOp(doc, { op: "replaceEvent", ref: doc.events[0].ref, event: eventRefFor(fm, doc.events[0].ref) });
        doc = { ...doc, title: `${m.title.replace(/\?$/, "")} → ${doc.title.split("→").pop()?.trim() ?? "future"}`.slice(0, 120) };
      }
      const v = await backend.saveDraft(doc);
      navigate(`/futures/${v.id}/edit`, { replace: !!template });
    } catch (e) {
      toast({ title: "Couldn't create the draft", detail: (e as Error).message, tone: "error" });
    }
  };

  useEffect(() => {
    if (template && !started.current) {
      const t = TEMPLATES.find((x) => x.id === template);
      if (t) {
        started.current = true;
        void create(t);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  const cats = ["All", ...new Set(TEMPLATES.map((t) => t.category))];
  const shown = TEMPLATES.filter((t) => (category === "All" || t.category === category) && (!m || t.events === 1));
  return (
    <div className="page">
      <PageHead title="New future" sub={m ? `Start from “${m.title}”. Pick what should happen; you can change everything in the builder.` : "Start from a template. Every template is an ordinary future you can edit."} />
      {m && !m.compatible.ok && <Banner tone="warn">{m.compatible.reason}. Pick another market to build on.</Banner>}
      <div className="segmented" role="group" aria-label="Template category">
        {cats.map((c) => (
          <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="cards">
        <Link to="/agents?role=builder" className="card-link" style={{ boxShadow: "inset 0 0 0 1px var(--c-line-2)", background: "transparent" }}>
          <strong>Describe it instead</strong>
          <p className="t-small muted">Tell the Strategy Builder what you want in plain words. It asks only what's ambiguous and drafts a future you review.</p>
        </Link>
        {shown.map((t) => (
          <button key={t.id} className="card-link" style={{ textAlign: "left" }} onClick={() => void create(t)}>
            <span className="row">
              <strong className="grow">{t.title}</strong>
              <span className="t-micro faint">{t.category}</span>
            </span>
            <span className="t-small muted">{t.summary}</span>
            <span className="t-micro faint">
              {t.events} event{t.events === 1 ? "" : "s"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export { Button };
