import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { History, applyOp, type FixtureSet, type Op, type Strategy } from "@maybe/core";
import { useBackend } from "../../data/BackendContext.tsx";
import { useAssetMap, useMarkets, useNow, useStrategy } from "../../data/queries.ts";
import { Banner, Button, ErrorBlock, Kbd, LoadingBlock, Pill, Tip } from "../../components/ui.tsx";
import { Drawer } from "../../components/Overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { STRATEGY_STATUS } from "../../lib/status.ts";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { SentenceView } from "./SentenceView.tsx";
import { ListView } from "./ListView.tsx";
import { AddBranch, Inspector } from "./Inspector.tsx";
import { indexIssues, type Sel } from "./model.ts";
import type { Prepared, StrategyView } from "../../data/types.ts";

const GraphView = lazy(() => import("./GraphView.tsx"));

type View = "sentence" | "graph" | "list";

export function Builder() {
  const { id } = useParams();
  const q = useStrategy(id);
  const backend = useBackend();
  const navigate = useNavigate();
  const [fx, setFx] = useState<FixtureSet | null>(null);
  useEffect(() => {
    void backend.fixtures().then(setFx);
  }, [backend]);
  if (q.isLoading || !fx) return <div className="page"><LoadingBlock lines={6} /></div>;
  if (q.error) return <div className="page"><ErrorBlock error={q.error} /></div>;
  if (!q.data) return <div className="page"><Banner tone="warn">This future doesn't exist. <Link className="link" to="/futures">Back to futures</Link></Banner></div>;
  const authorized = !!q.data.runtime;
  if (authorized) {
    return (
      <Editor
        key={q.data.id}
        view={q.data}
        fx={fx}
        readOnly
        onNewVersion={async () => {
          const v = await backend.newVersionOf(q.data!.id);
          navigate(`/futures/${v.id}/edit`);
        }}
      />
    );
  }
  return <Editor key={q.data.id} view={q.data} fx={fx} />;
}

function Editor({ view, fx, readOnly, onNewVersion }: { view: StrategyView; fx: FixtureSet; readOnly?: boolean; onNewVersion?: () => void }) {
  const backend = useBackend();
  const navigate = useNavigate();
  const assets = useAssetMap();
  const { data: markets } = useMarkets();
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const v = (params.get("view") as View) ?? "sentence";
  const setView = (nv: View) => {
    const next = new URLSearchParams(params);
    if (nv === "sentence") next.delete("view");
    else next.set("view", nv);
    setParams(next, { replace: true });
  };
  const hist = useRef(new History<Strategy>(view.doc));
  const [doc, setDoc] = useState<Strategy>(view.doc);
  const [, force] = useState(0);
  const [sel, setSel] = useState<Sel | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const narrow = useMediaQuery("(max-width: 760px)");

  const apply = useCallback(
    (op: Op | Op[]) => {
      if (readOnly) return;
      const ops = Array.isArray(op) ? op : [op];
      let next = hist.current.present;
      for (const o of ops) next = applyOp(next, o);
      hist.current.push(next);
      setDoc(next);
      force((x) => x + 1);
    },
    [readOnly],
  );
  const undo = useCallback(() => {
    if (hist.current.undo()) {
      setDoc(hist.current.present);
      force((x) => x + 1);
    }
  }, []);
  const redo = useCallback(() => {
    if (hist.current.redo()) {
      setDoc(hist.current.present);
      force((x) => x + 1);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // validate continuously; save drafts after a short pause
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const p = await backend.prepare(doc);
        if (!cancelled) setPrep(p);
        if (!readOnly && doc !== view.doc) {
          setSaveState("saving");
          await backend.saveDraft(doc);
          if (!cancelled) setSaveState("saved");
        }
      } catch (e) {
        if (!cancelled) {
          setSaveState("error");
          toast({ title: "Couldn't save the draft", detail: (e as Error).message, tone: "error" });
        }
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [doc, backend, readOnly, view.doc]);

  const issues = useMemo(() => indexIssues((prep?.issues ?? []).filter((i) => i.code !== "INSUFFICIENT_AVAILABLE" || true)), [prep]);
  const blocking = issues.errors.filter((i) => i.code !== "INSUFFICIENT_AVAILABLE");
  const st = STRATEGY_STATUS[view.status];
  const reviewReason = readOnly ? null : !prep ? "Checking…" : blocking.length ? `Fix ${blocking.length} problem${blocking.length === 1 ? "" : "s"} first` : null;
  const ctx = { doc, fx, assets, markets: markets ?? [], issues, now, onOp: apply, onSelect: setSel, readOnly };

  const inspector = (
    <>
      <Inspector {...ctx} selected={sel} />
      {!readOnly && !sel && <AddBranch {...ctx} />}
    </>
  );

  return (
    <div className="builder">
      <div className="builder-main">
        <div className="builder-bar">
          <div className="grow row" style={{ minWidth: 0 }}>
            <h2 className="t-head truncate">{doc.title}</h2>
            <Pill tone={st.tone} icon={st.icon}>
              {readOnly ? "Authorized · read only" : st.label}
            </Pill>
            {!readOnly && (
              <span className="t-micro faint nowrap" aria-live="polite">
                {saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}
              </span>
            )}
          </div>
          <div className="segmented" role="tablist" aria-label="View">
            {(["sentence", "graph", "list"] as View[]).map((x) => (
              <button key={x} role="tab" aria-selected={v === x} onClick={() => setView(x)}>
                {x === "sentence" ? "Sentence" : x === "graph" ? "Graph" : "List"}
              </button>
            ))}
          </div>
          {!readOnly && (
            <div className="row-tight">
              <Tip content={<span>Undo <Kbd>⌘Z</Kbd></span>}>
                <Button size="sm" variant="ghost" iconOnly icon="undo" aria-label="Undo" disabled={!hist.current.canUndo} onClick={undo} />
              </Tip>
              <Tip content={<span>Redo <Kbd>⇧⌘Z</Kbd></span>}>
                <Button size="sm" variant="ghost" iconOnly icon="redo" aria-label="Redo" disabled={!hist.current.canRedo} onClick={redo} />
              </Tip>
            </div>
          )}
          {readOnly ? (
            <Button size="sm" onClick={onNewVersion}>
              Edit as new version
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabledReason={reviewReason} onClick={() => navigate(`/futures/${view.id}/review`)}>
              Review
            </Button>
          )}
        </div>
        <div className="builder-canvas">
          {readOnly && (
            <Banner tone="info">
              This version is authorized and can't change. Editing creates version {doc.version + 1}, which needs a new signature; until you sign it, this one keeps running.
            </Banner>
          )}
          {doc.meta?.supersedes && !readOnly && <Banner tone="info">This is a new version. Authorizing it cancels the previous version and reserves funds for this one in the same step.</Banner>}
          {v === "sentence" && <SentenceView doc={doc} assets={assets} issues={issues} selected={sel} onSelect={setSel} onOp={apply} readOnly={readOnly} />}
          {v === "graph" && (
            <Suspense fallback={<LoadingBlock label="Loading graph" />}>
              <GraphView doc={doc} assets={assets} issues={issues} selected={sel} onSelect={setSel} onOp={apply} readOnly={readOnly} />
            </Suspense>
          )}
          {v === "list" && <ListView doc={doc} assets={assets} issues={issues} selected={sel} onSelect={setSel} />}
          {narrow && !sel && <div className="stack-loose">{inspector}</div>}
        </div>
      </div>
      {!narrow && <aside className="builder-side" aria-label="Inspector">{inspector}</aside>}
      {narrow && (
        <Drawer open={!!sel} onOpenChange={(o) => !o && setSel(null)} title="Edit">
          <Inspector {...ctx} selected={sel} />
        </Drawer>
      )}
    </div>
  );
}
