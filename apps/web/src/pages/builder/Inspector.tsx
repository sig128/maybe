import { useEffect, useState } from "react";
import { cpQuote, formatAmount, isAddress, parseAmount, uniqueId, nextEventRef, eventRefFor, type Action, type AssetInfo, type FixtureSet, type Op, type Strategy, type Issue, type PredicateNode } from "@maybe/core";
import { Banner, Button, Pill } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Amount } from "../../components/Amount.tsx";
import type { MarketSummary } from "../../data/types.ts";
import { fmtDate } from "../../lib/time.ts";
import type { IssueIndex, Sel } from "./model.ts";
import { selFromIssue } from "./model.ts";

const DAY = 86_400;

interface Ctx {
  doc: Strategy;
  fx: FixtureSet;
  assets: Map<string, AssetInfo>;
  markets: MarketSummary[];
  issues: IssueIndex;
  now: number;
  onOp: (op: Op | Op[]) => void;
  onSelect: (s: Sel | null) => void;
  readOnly?: boolean;
}

export function Inspector(props: Ctx & { selected: Sel | null }) {
  const { selected } = props;
  if (!selected || selected.kind === "strategy") return <StrategyPanel {...props} />;
  if (selected.kind === "node") return <NodePanel {...props} id={selected.id} />;
  if (selected.kind === "allocation") return <AllocationPanel {...props} id={selected.id} />;
  if (selected.kind === "action") return <ActionPanel {...props} id={selected.id} />;
  if (selected.kind === "event") return <EventPanel {...props} refId={selected.id} />;
  return null;
}

function Head({ title, onBack, kind }: { title: string; kind: string; onBack?: () => void }) {
  return (
    <div className="stack-tight">
      {onBack && (
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", marginLeft: -10 }} onClick={onBack}>
          <Icon name="chevronLeft" size={16} /> Summary
        </button>
      )}
      <span className="t-micro faint">{kind}</span>
      <h3 className="t-head">{title}</h3>
    </div>
  );
}

function IssuesFor({ issues, kind, id }: { issues: IssueIndex; kind: Sel["kind"]; id: string }) {
  const all = [...issues.errors, ...issues.warnings, ...issues.infos].filter((i) => i.target.kind === kind && (i.target.id ?? "strategy") === id);
  if (!all.length) return null;
  return (
    <div className="stack">
      {all.map((i, k) => (
        <Banner key={k} tone={i.severity === "error" ? "error" : i.severity === "warning" ? "warn" : "info"}>
          {i.message}
        </Banner>
      ))}
    </div>
  );
}

function StrategyPanel({ doc, issues, onOp, onSelect, now, assets, readOnly }: Ctx) {
  const days = Math.max(1, Math.round((doc.expiresAt - now) / DAY));
  const reserved = new Map<string, bigint>();
  doc.allocations.forEach((a) => reserved.set(a.mint, (reserved.get(a.mint) ?? 0n) + BigInt(a.amount)));
  const list: Issue[] = [...issues.errors, ...issues.warnings, ...issues.infos];
  return (
    <div className="stack-loose">
      <Head kind="Future" title="Summary" />
      <div className="stack">
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={doc.title} disabled={readOnly} onChange={(e) => onOp({ op: "setTitle", title: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">Thesis (optional)</span>
          <textarea className="textarea" value={doc.thesis ?? ""} disabled={readOnly} onChange={(e) => onOp({ op: "setThesis", thesis: e.target.value })} placeholder="Why this future, in a sentence or two" />
        </label>
        <label className="field">
          <span className="label">Expires</span>
          <select className="select" value={[7, 14, 30, 45, 60, 90, 180].includes(days) ? days : "custom"} disabled={readOnly} onChange={(e) => onOp({ op: "setExpiry", expiresAt: Math.floor(now / 3600) * 3600 + Number(e.target.value) * DAY })}>
            {[7, 14, 30, 45, 60, 90, 180].map((d) => (
              <option key={d} value={d}>
                In {d} days
              </option>
            ))}
            {![7, 14, 30, 45, 60, 90, 180].includes(days) && <option value="custom">{fmtDate(doc.expiresAt, true)} (in {days} days)</option>}
          </select>
          <span className="hint">At expiry everything unspent returns to your available balance.</span>
        </label>
        <div className="grid-2">
          <label className="field">
            <span className="label">Max fee</span>
            <select className="select" value={doc.maxFeeBps} disabled={readOnly} onChange={(e) => onOp({ op: "setMaxFee", maxFeeBps: Number(e.target.value) })}>
              {[0, 10, 30, 50, 100].map((b) => (
                <option key={b} value={b}>
                  {(b / 100).toFixed(2)}%
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Cancelling</span>
            <select className="select" value={doc.cancelPolicy} disabled={readOnly} onChange={(e) => onOp({ op: "setCancelPolicy", cancelPolicy: e.target.value as Strategy["cancelPolicy"] })}>
              <option value="anytime">Anytime</option>
              <option value="locked-until-expiry">Locked until expiry</option>
            </select>
          </label>
        </div>
      </div>
      <div className="stack">
        <h4 className="t-small muted">Reserves when authorized</h4>
        {[...reserved.entries()].map(([m, v]) => (
          <span key={m} className="t-title">
            <Amount units={v} mint={m} />
          </span>
        ))}
        <span className="t-small faint">
          {doc.allocations.length} allocation{doc.allocations.length === 1 ? "" : "s"} · {doc.actions.length} step{doc.actions.length === 1 ? "" : "s"} · {doc.events.length} event{doc.events.length === 1 ? "" : "s"}
        </span>
        {assets.size === 0 && null}
      </div>
      <div className="stack">
        <h4 className="t-small muted">Checks</h4>
        {list.length === 0 ? (
          <p className="row-tight t-small">
            <Icon name="check" size={16} style={{ color: "var(--c-accent)" }} /> No problems found
          </p>
        ) : (
          <ul className="issue-list">
            {list.map((i, k) => {
              const s = selFromIssue(i);
              return (
                <li key={k}>
                  <Icon name={i.severity === "info" ? "info" : "alert"} size={16} style={{ color: i.severity === "error" ? "var(--c-red)" : i.severity === "warning" ? "var(--c-amber)" : "var(--c-text-3)", marginTop: 2, flex: "none" }} />
                  <span className="grow t-small">{i.message}</span>
                  {s && s.kind !== "strategy" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => onSelect(s)}>
                      Show
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function EventPanel({ doc, refId, markets, onOp, onSelect, issues, fx, readOnly }: Ctx & { refId: string }) {
  const ev = doc.events.find((e) => e.ref === refId);
  if (!ev) return null;
  return (
    <div className="stack-loose">
      <Head kind={`Event ${ev.ref}`} title={ev.title} onBack={() => onSelect(null)} />
      <IssuesFor issues={issues} kind="event" id={refId} />
      <MarketPicker value={ev.eventKey} markets={markets} disabled={readOnly} onPick={(m) => {
        const fm = fx.markets.find((x) => x.key === m.key);
        if (fm) onOp({ op: "replaceEvent", ref: ev.ref, event: eventRefFor(fm, ev.ref) });
      }} />
      <p className="t-small muted">Changing the market updates every condition that uses {ev.ref}. Rules version {ev.ruleHash.slice(0, 12)}… is frozen when you authorize.</p>
    </div>
  );
}

function MarketPicker({ value, markets, onPick, disabled }: { value: string; markets: MarketSummary[]; onPick: (m: MarketSummary) => void; disabled?: boolean }) {
  return (
    <label className="field">
      <span className="label">Market</span>
      <select
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const m = markets.find((x) => x.eventKey === e.target.value);
          if (m) onPick(m);
        }}
      >
        {markets.map((m) => (
          <option key={m.key} value={m.eventKey} disabled={!m.compatible.ok}>
            {m.title}
            {!m.compatible.ok ? " — not a trigger" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function NodePanel({ doc, id, markets, onOp, onSelect, issues, fx, readOnly }: Ctx & { id: string }) {
  const n = doc.nodes.find((x) => x.id === id);
  if (!n) return null;
  const users = doc.actions.filter((a) => a.guard === id);
  const replace = (node: PredicateNode) => onOp({ op: "replaceNode", node });
  return (
    <div className="stack-loose">
      <Head kind="Condition" title={n.kind === "outcome" ? `${n.event} resolves ${n.outcome}` : n.kind === "atLeast" ? `At least ${n.k} of ${n.children.length}` : n.kind === "and" ? "All of these" : n.kind === "or" ? "Any of these" : n.kind === "not" ? "Settled the other way" : n.kind === "veto" ? "Unless vetoed in time" : n.kind === "receipt" ? "After a receipt" : n.kind === "after" ? "After a time" : "Right away"} onBack={() => onSelect(null)} />
      <IssuesFor issues={issues} kind="node" id={id} />
      {n.kind === "outcome" && (
        <>
          <div className="field">
            <span className="label">Event</span>
            <select className="select" value={n.event} disabled={readOnly} onChange={(e) => onOp({ op: "setNodeEvent", nodeId: n.id, ref: e.target.value })}>
              {doc.events.map((e) => (
                <option key={e.ref} value={e.ref}>
                  {e.ref} · {e.title}
                </option>
              ))}
            </select>
          </div>
          {(() => {
            const ev = doc.events.find((e) => e.ref === n.event);
            return ev ? <MarketPicker value={ev.eventKey} markets={markets} disabled={readOnly} onPick={(m) => {
              const fm = fx.markets.find((x) => x.key === m.key);
              if (fm) onOp({ op: "replaceEvent", ref: ev.ref, event: eventRefFor(fm, ev.ref) });
            }} /> : null;
          })()}
          <div className="field">
            <span className="label">Outcome</span>
            <div className="segmented" role="group" aria-label="Outcome">
              {(["YES", "NO"] as const).map((o) => (
                <button key={o} aria-pressed={n.outcome === o} disabled={readOnly} onClick={() => onOp({ op: "setOutcome", nodeId: n.id, outcome: o })}>
                  {o}
                </button>
              ))}
            </div>
            <span className="hint">Only a final outcome counts. Voided markets make this condition false; unresolved at expiry means it never became true.</span>
          </div>
        </>
      )}
      {(n.kind === "and" || n.kind === "or") && (
        <div className="field">
          <span className="label">Needs</span>
          <div className="segmented" role="group">
            <button aria-pressed={n.kind === "and"} disabled={readOnly} onClick={() => replace({ id: n.id, kind: "and", children: n.children })}>
              All of them
            </button>
            <button aria-pressed={n.kind === "or"} disabled={readOnly} onClick={() => replace({ id: n.id, kind: "or", children: n.children })}>
              Any of them
            </button>
          </div>
        </div>
      )}
      {n.kind === "atLeast" && (
        <label className="field">
          <span className="label">How many must happen</span>
          <input className="input" type="number" min={1} max={n.children.length} value={n.k} disabled={readOnly} onChange={(e) => onOp({ op: "setThreshold", nodeId: n.id, k: Math.max(1, Math.min(n.children.length, Number(e.target.value) || 1)) })} />
          <span className="hint">
            Out of {n.children.length}. It becomes impossible — and the release step can run — once fewer than {n.k} can still happen.
          </span>
        </label>
      )}
      {n.kind === "veto" && (
        <label className="field">
          <span className="label">Veto window (hours after the trigger is final)</span>
          <input className="input" type="number" min={0} max={720} value={Math.round(n.windowSeconds / 3600)} disabled={readOnly} onChange={(e) => onOp({ op: "setVetoWindow", nodeId: n.id, windowSeconds: Math.max(0, Number(e.target.value) || 0) * 3600 })} />
          <span className="hint">Evaluated with recorded finalization times, so it doesn't matter when the keeper looks. A veto final exactly at the end of the window still counts.</span>
        </label>
      )}
      {n.kind === "not" && <p className="t-small muted">True once it is settled that the inner condition won't happen. While anything it depends on is unresolved, this is unresolved too.</p>}
      {n.kind === "receipt" && <p className="t-small muted">True after the referenced step has a successful execution receipt on-chain.</p>}
      {users.length > 0 && (
        <div className="stack-tight">
          <span className="label">Used by</span>
          {users.map((a) => (
            <button key={a.id} className="btn btn-ghost btn-sm" style={{ justifyContent: "flex-start" }} onClick={() => onSelect({ kind: "action", id: a.id })}>
              {a.label ?? a.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AllocationPanel({ doc, id, assets, onOp, onSelect, issues, readOnly }: Ctx & { id: string }) {
  const al = doc.allocations.find((a) => a.id === id);
  const asset = al ? assets.get(al.mint) : undefined;
  const [text, setText] = useState(al && asset ? formatAmount(BigInt(al.amount), asset.decimals, { grouping: false, minFraction: 0 }) : "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (al && asset) setText(formatAmount(BigInt(al.amount), asset.decimals, { grouping: false, minFraction: 0 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!al || !asset) return null;
  return (
    <div className="stack-loose">
      <Head kind="Allocation" title={al.label} onBack={() => onSelect(null)} />
      <IssuesFor issues={issues} kind="allocation" id={id} />
      <label className="field">
        <span className="label">Amount to reserve ({asset.symbol})</span>
        <input
          className="input num"
          inputMode="decimal"
          value={text}
          disabled={readOnly}
          aria-invalid={!!err || undefined}
          onChange={(e) => {
            setText(e.target.value);
            try {
              const u = parseAmount(e.target.value || "0", asset.decimals);
              setErr(u === 0n ? "Must be more than zero" : null);
              if (u > 0n) onOp({ op: "setAllocationAmount", allocationId: id, amount: u.toString() });
            } catch {
              setErr(`Up to ${asset.decimals} decimal places`);
            }
          }}
        />
        {err && <span className="error-text">{err}</span>}
        <span className="hint">Reserved from your available balance when you authorize. Only steps in this allocation can spend it.</span>
      </label>
      <label className="field">
        <span className="label">Label</span>
        <input className="input" value={al.label} disabled={readOnly} onChange={(e) => onOp({ op: "setAllocationLabel", allocationId: id, label: e.target.value.slice(0, 60) || "Allocation" })} />
      </label>
      {!readOnly && doc.allocations.length > 1 && (
        <Button variant="danger" size="sm" icon="trash" onClick={() => (onOp({ op: "removeAllocation", allocationId: id }), onSelect(null))}>
          Remove allocation and its steps
        </Button>
      )}
    </div>
  );
}

function ActionPanel({ doc, id, fx, assets, onOp, onSelect, issues, now, readOnly }: Ctx & { id: string }) {
  const a = doc.actions.find((x) => x.id === id);
  if (!a) return null;
  const replace = (next: Action) => onOp({ op: "replaceAction", action: next });
  const al = doc.allocations.find((x) => x.id === a.allocation);
  const inMint = a.kind === "swap" ? a.inputMint : a.mint;
  const inAsset = assets.get(inMint);
  return (
    <div className="stack-loose">
      <Head kind={a.kind === "swap" ? "Swap step" : a.kind === "transfer" ? "Payment step" : "Release step"} title={a.label ?? a.id} onBack={() => onSelect(null)} />
      <IssuesFor issues={issues} kind="action" id={id} />
      <label className="field">
        <span className="label">Name</span>
        <input className="input" value={a.label ?? ""} disabled={readOnly} onChange={(e) => onOp({ op: "setActionLabel", actionId: id, label: e.target.value.slice(0, 80) })} />
      </label>
      {a.kind === "swap" && <SwapFields a={a} fx={fx} assets={assets} replace={replace} readOnly={readOnly} />}
      {a.kind !== "swap" && (
        <div className="field">
          <span className="label">Amount</span>
          <div className="segmented" role="group">
            <button aria-pressed={a.amount.kind === "bpsOfAllocation"} disabled={readOnly} onClick={() => replace({ ...a, amount: { kind: "bpsOfAllocation", bps: 10_000 } })}>
              Whole allocation
            </button>
            <button aria-pressed={a.amount.kind === "fixed"} disabled={readOnly} onClick={() => replace({ ...a, amount: { kind: "fixed", amount: al?.amount ?? "1" } })}>
              Fixed amount
            </button>
          </div>
          {a.amount.kind === "fixed" && inAsset && <span className="hint">Fixed at <Amount units={BigInt(a.amount.amount)} mint={inMint} /></span>}
        </div>
      )}
      {a.kind === "transfer" && <RecipientField value={a.recipient} disabled={readOnly} onChange={(r) => replace({ ...a, recipient: r })} />}
      <div className="grid-2">
        <label className="field">
          <span className="label">Wait after condition</span>
          <select className="select" value={a.delaySeconds ?? 0} disabled={readOnly} onChange={(e) => onOp({ op: "setActionDelay", actionId: id, delaySeconds: Number(e.target.value) })}>
            {[0, 3600, 6 * 3600, DAY, 2 * DAY, 3 * DAY, 7 * DAY].map((s) => (
              <option key={s} value={s}>
                {s === 0 ? "No wait" : s < DAY ? `${s / 3600} hours` : `${s / DAY} day${s === DAY ? "" : "s"}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Must run before</span>
          <select
            className="select"
            value={a.deadline ? "custom" : "expiry"}
            disabled={readOnly}
            onChange={(e) => onOp({ op: "setActionDeadline", actionId: id, ...(e.target.value === "expiry" ? {} : { deadline: Math.min(doc.expiresAt, Math.floor(now / 3600) * 3600 + Number(e.target.value) * DAY) }) })}
          >
            <option value="expiry">The future's expiry</option>
            {a.deadline && <option value="custom">{fmtDate(a.deadline, true)}</option>}
            {[3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                In {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      {a.schedule && (
        <p className="t-small muted">
          Repeats {a.schedule.runs} times, every {Math.round(a.schedule.intervalSeconds / DAY)} days. {a.schedule.missed === "skip" ? "A run missed past the next run time is skipped." : "Missed runs may still execute late, one at a time."}
        </p>
      )}
      {a.branch && (
        <Pill tone="quiet" icon="branch">
          Exclusive branch “{a.branch.branch}” of “{a.branch.group}”
        </Pill>
      )}
      {!readOnly && doc.actions.length > 1 && (
        <Button variant="danger" size="sm" icon="trash" onClick={() => (onOp({ op: "removeAction", actionId: id }), onSelect(null))}>
          Remove step
        </Button>
      )}
    </div>
  );
}

function RecipientField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value);
  const ok = isAddress(text);
  return (
    <label className="field">
      <span className="label">Recipient wallet</span>
      <input
        className="input mono"
        value={text}
        disabled={disabled}
        aria-invalid={!ok || undefined}
        onChange={(e) => {
          setText(e.target.value.trim());
          if (isAddress(e.target.value.trim())) onChange(e.target.value.trim());
        }}
      />
      {!ok ? <span className="error-text">Enter a Solana address (base58, 32 bytes).</span> : <span className="hint">Funds can only ever go to this wallet's token account. It's fixed when you authorize.</span>}
    </label>
  );
}

function SwapFields({ a, fx, assets, replace, readOnly }: { a: Extract<Action, { kind: "swap" }>; fx: FixtureSet; assets: Map<string, AssetInfo>; replace: (a: Action) => void; readOnly?: boolean }) {
  const pools = fx.pools.filter((p) => p.mintA === a.inputMint || p.mintB === a.inputMint);
  const outputs = pools.map((p) => (p.mintA === a.inputMint ? p.mintB : p.mintA));
  const [slip, setSlip] = useState(100);
  const recompute = (next: Extract<Action, { kind: "swap" }>, slippage = slip): Action => {
    const pool = fx.pools.find((p) => p.address === next.route.pool);
    if (!pool) return next;
    const inA = assets.get(next.inputMint);
    if (next.amount.kind === "fixed") {
      const afterFee = (BigInt(next.amount.amount) * BigInt(10_000 - (next.feeBps ?? 0))) / 10_000n;
      const q = cpQuote(pool, next.inputMint, afterFee);
      return { ...next, minOut: { kind: "absolute", amount: (((q * BigInt(10_000 - slippage)) / 10_000n) || 1n).toString() } };
    }
    const probe = 10n ** BigInt(inA?.decimals ?? 6);
    const q = cpQuote(pool, next.inputMint, probe);
    return { ...next, minOut: { kind: "rate", outPerInE9: (((q * 1_000_000_000n * BigInt(10_000 - slippage)) / (probe * 10_000n)) || 1n).toString() } };
  };
  const outAsset = assets.get(a.outputMint);
  const inAsset = assets.get(a.inputMint);
  return (
    <>
      <label className="field">
        <span className="label">Buy</span>
        <select
          className="select"
          value={a.outputMint}
          disabled={readOnly}
          onChange={(e) => {
            const pool = pools.find((p) => p.mintA === e.target.value || p.mintB === e.target.value);
            if (pool) replace(recompute({ ...a, outputMint: e.target.value, route: { kind: "cp-swap", pool: pool.address }, label: `Buy ${assets.get(e.target.value)?.symbol ?? ""}` }));
          }}
        >
          {outputs.map((m) => (
            <option key={m} value={m}>
              {assets.get(m)?.symbol} — {assets.get(m)?.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="label">Spend</span>
        <div className="segmented" role="group">
          <button aria-pressed={a.amount.kind === "fixed"} disabled={readOnly} onClick={() => replace(recompute({ ...a, amount: { kind: "fixed", amount: a.amount.kind === "fixed" ? a.amount.amount : "100000000" } }))}>
            Fixed
          </button>
          <button aria-pressed={a.amount.kind === "bpsOfAllocation"} disabled={readOnly} onClick={() => replace(recompute({ ...a, amount: { kind: "bpsOfAllocation", bps: a.amount.kind === "bpsOfAllocation" ? a.amount.bps : 10_000 } }))}>
            % of allocation
          </button>
        </div>
        {a.amount.kind === "fixed" && inAsset && (
          <input
            className="input num"
            inputMode="decimal"
            aria-label={`Amount in ${inAsset.symbol}`}
            defaultValue={formatAmount(BigInt(a.amount.amount), inAsset.decimals, { grouping: false, minFraction: 0 })}
            disabled={readOnly}
            onChange={(e) => {
              try {
                const u = parseAmount(e.target.value || "0", inAsset.decimals);
                if (u > 0n) replace(recompute({ ...a, amount: { kind: "fixed", amount: u.toString() } }));
              } catch {
                /* invalid input stays local until fixed */
              }
            }}
          />
        )}
        {a.amount.kind === "bpsOfAllocation" && (
          <input className="input num" type="number" min={1} max={100} aria-label="Percent of allocation" value={a.amount.bps / 100} disabled={readOnly} onChange={(e) => replace({ ...a, amount: { kind: "bpsOfAllocation", bps: Math.max(1, Math.min(100, Number(e.target.value) || 1)) * 100 } })} />
        )}
        {(a.amount.kind === "bpsOfReceived" || a.amount.kind === "allOfHolding") && <span className="hint">{a.amount.kind === "bpsOfReceived" ? `${a.amount.bps / 100}% of what an earlier step actually received` : "Everything this allocation holds in that token"}</span>}
      </div>
      <div className="field">
        <span className="label">Price protection</span>
        <div className="segmented" role="group" aria-label="Slippage tolerance">
          {[50, 100, 200].map((s) => (
            <button key={s} aria-pressed={slip === s} disabled={readOnly} onClick={() => (setSlip(s), replace(recompute(a, s)))}>
              {(s / 100).toFixed(1)}%
            </button>
          ))}
        </div>
        <span className="hint">
          {a.minOut.kind === "absolute" ? (
            <>
              Receives at least <Amount units={BigInt(a.minOut.amount)} mint={a.outputMint} /> or nothing happens.
            </>
          ) : (
            <>
              Limit price: 1 {inAsset?.symbol} buys at least {outAsset ? formatAmount((BigInt(a.minOut.outPerInE9) * 10n ** BigInt(inAsset?.decimals ?? 6)) / 1_000_000_000n, outAsset.decimals, { minFraction: 0, maxFraction: 4 }) : "?"} {outAsset?.symbol}.
            </>
          )}{" "}
          A route that can't meet this fails, and nothing is spent.
        </span>
      </div>
    </>
  );
}

/** Tap-to-add: a new allocation with its own condition and buy step — no dragging needed. */
export function AddBranch({ doc, fx, markets, onOp, onSelect, now }: Ctx) {
  const [marketKey, setMarketKey] = useState(markets.find((m) => m.compatible.ok)?.key ?? "");
  const usdc = fx.assetByKey.USDC!;
  const maybe = fx.assetByKey.MAYBE!;
  const add = () => {
    const m = fx.markets.find((x) => x.key === marketKey);
    if (!m) return;
    let ref = doc.events.find((e) => e.eventKey === m.eventKey)?.ref;
    const ops: Op[] = [];
    if (!ref) {
      ref = nextEventRef(doc);
      ops.push({ op: "addEvent", event: eventRefFor(m, ref) });
    }
    const allocId = uniqueId(doc, "alloc");
    const nodeId = uniqueId(doc, "cond");
    const actId = uniqueId(doc, "step");
    const pool = fx.poolByKey["USDC-MAYBE"]!;
    const amount = 100_000_000n;
    const q = cpQuote(pool, usdc.mint, (amount * 9970n) / 10_000n);
    ops.push({ op: "addAllocation", allocation: { id: allocId, label: `If ${ref} resolves YES`, mint: usdc.mint, amount: amount.toString() } });
    ops.push({ op: "addNode", node: { id: nodeId, kind: "outcome", event: ref, outcome: "YES" } });
    ops.push({ op: "addAction", action: { kind: "swap", id: actId, label: "Buy MAYBE", allocation: allocId, guard: nodeId, inputMint: usdc.mint, outputMint: maybe.mint, amount: { kind: "fixed", amount: amount.toString() }, minOut: { kind: "absolute", amount: ((q * 9900n) / 10_000n).toString() }, route: { kind: "cp-swap", pool: pool.address }, feeBps: Math.min(30, doc.maxFeeBps), delaySeconds: 0 } });
    onOp(ops);
    onSelect({ kind: "action", id: actId });
  };
  void now;
  return (
    <div className="stack panel panel-outline">
      <strong>Add a branch</strong>
      <p className="t-small muted">A separate reservation with its own condition. You can change every part after adding it.</p>
      <MarketPicker value={fx.markets.find((m) => m.key === marketKey)?.eventKey ?? ""} markets={markets} onPick={(m) => setMarketKey(m.key)} />
      <Button size="sm" icon="plus" onClick={add} disabledReason={doc.allocations.length >= 4 ? "A future can have at most 4 allocations" : doc.actions.length >= 12 ? "A future can have at most 12 steps" : null}>
        Add branch
      </Button>
    </div>
  );
}
