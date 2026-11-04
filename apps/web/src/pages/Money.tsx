import { useMemo, useState, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { formatAmount, parseAmount, type AssetInfo } from "@maybe/core";
import { useBackend } from "../data/BackendContext.tsx";
import { useActivity, useAssetMap, useAssets, useNow, usePortfolio, useStrategies } from "../data/queries.ts";
import { Amount, AssetDot, UsdEstimate } from "../components/Amount.tsx";
import { AmountTicket } from "../components/AmountTicket.tsx";
import { Banner, Button, ErrorBlock, LoadingBlock, Pill } from "../components/ui.tsx";
import { Modal } from "../components/Overlay.tsx";
import { PageHead } from "../app/Shell.tsx";
import { toast } from "../components/Toast.tsx";
import { ActivityRow } from "./Activity.tsx";
import { TX_STATUS } from "../lib/status.ts";
import type { Portfolio, StrategyView, TxRecord } from "../data/types.ts";

type Action = "deposit" | "withdraw" | "allocate";

export function Money() {
  const q = usePortfolio();
  const { data: assetList } = useAssets();
  const assets = useAssetMap();
  const [params, setParams] = useSearchParams();
  const action = (params.get("action") as Action) ?? "deposit";
  const setAction = (a: Action) => setParams(a === "deposit" ? {} : { action: a }, { replace: true });
  const { data: activity } = useActivity();
  const now = useNow(10_000);
  if (q.isLoading) return <div className="page"><LoadingBlock lines={6} /></div>;
  if (q.error || !q.data) return <div className="page"><ErrorBlock error={q.error} /></div>;
  const p = q.data;
  const rows = (assetList ?? []).filter((a) => (p.wallet[a.mint] ?? 0n) > 0n || (p.vault.balances[a.mint]?.available ?? 0n) > 0n || (p.vault.balances[a.mint]?.reserved ?? 0n) > 0n);
  const moneyActivity = (activity ?? []).filter((a) => ["deposit", "withdraw", "refund", "release", "cancel", "activate"].includes(a.kind)).slice(0, 8);
  return (
    <div className="page">
      <PageHead title="Money" sub="Your wallet, your vault, and exactly which part of the vault is committed. Only available funds can be withdrawn." />
      <section className="panel panel-flush" aria-labelledby="bal">
        <h3 id="bal" className="sr-only">
          Balances
        </h3>
        <ul className="list only-mobile" aria-label="Balances">
          {rows.map((a) => {
            const w = p.wallet[a.mint] ?? 0n;
            const b = p.vault.balances[a.mint] ?? { available: 0n, reserved: 0n };
            return (
              <li key={a.mint} className="list-item" style={{ alignItems: "flex-start" }}>
                <AssetDot asset={a} />
                <div className="grow stack-tight">
                  <span className="row" style={{ justifyContent: "space-between" }}>
                    <span className="strong">{a.symbol}</span>
                    <UsdEstimate units={w + b.available + b.reserved} mint={a.mint} prefix="" />
                  </span>
                  <span className="row t-small" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Wallet</span>
                    <Amount units={w} mint={a.mint} showSymbol={false} />
                  </span>
                  <span className="row t-small" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Available</span>
                    <Amount units={b.available} mint={a.mint} showSymbol={false} />
                  </span>
                  <span className="row t-small" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Reserved</span>
                    <Amount units={b.reserved} mint={a.mint} showSymbol={false} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="hide-mobile scroll-x" role="region" aria-label="Balances (scrolls sideways)" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="right">Wallet</th>
                <th className="right">Available in vault</th>
                <th className="right">Reserved in futures</th>
                <th className="right hide-mobile">Estimated value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const w = p.wallet[a.mint] ?? 0n;
                const b = p.vault.balances[a.mint] ?? { available: 0n, reserved: 0n };
                return (
                  <tr key={a.mint}>
                    <td>
                      <span className="row-tight">
                        <AssetDot asset={a} />
                        <span className="stack-tight">
                          <span className="strong">{a.symbol}</span>
                          <span className="t-micro faint">{a.name}</span>
                        </span>
                      </span>
                    </td>
                    <td className="right">
                      <Amount units={w} mint={a.mint} showSymbol={false} />
                    </td>
                    <td className="right">
                      <Amount units={b.available} mint={a.mint} showSymbol={false} />
                    </td>
                    <td className="right">
                      <span className={b.reserved > 0n ? "" : "faint"}>
                        <Amount units={b.reserved} mint={a.mint} showSymbol={false} />
                      </span>
                    </td>
                    <td className="right hide-mobile">
                      <UsdEstimate units={w + b.available + b.reserved} mint={a.mint} prefix="" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="t-micro faint" style={{ padding: "10px 16px" }}>
          Quantities are confirmed balances. Values are estimates from sample prices. The vault holds available + reserved; nothing is counted twice.
        </p>
      </section>

      {(p.pendingTransfers.length > 0 || p.pendingReservations.length > 0) && (
        <section className="panel" aria-labelledby="pending">
          <h3 id="pending" className="t-head">
            In flight
          </h3>
          <ul className="stack">
            {p.pendingTransfers.map((t, i) => (
              <li key={i} className="row">
                <span className="grow">
                  {t.kind === "deposit" ? "Deposit" : "Withdrawal"} of <Amount units={t.units} mint={t.mint} />
                </span>
                <Pill tone={TX_STATUS[t.state].tone} icon={TX_STATUS[t.state].icon}>
                  {TX_STATUS[t.state].label}
                </Pill>
              </li>
            ))}
            {p.pendingReservations.map((r, i) => (
              <li key={`r${i}`} className="row">
                <span className="grow">
                  Reserving <Amount units={r.units} mint={r.mint} /> <span className="muted">— still available until confirmed</span>
                </span>
                <Pill tone={TX_STATUS[r.state].tone} icon={TX_STATUS[r.state].icon}>
                  {TX_STATUS[r.state].label}
                </Pill>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="split">
        <section className="panel" aria-labelledby="move">
          <div className="segmented" role="tablist" aria-label="Move money">
            {(
              [
                ["deposit", "Deposit"],
                ["withdraw", "Withdraw"],
                ["allocate", "Assign to a future"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={action === k} onClick={() => setAction(k)}>
                {l}
              </button>
            ))}
          </div>
          <h3 id="move" className="sr-only">
            {action}
          </h3>
          {action === "deposit" && <TransferForm kind="deposit" p={p} assets={assetList ?? []} />}
          {action === "withdraw" && <TransferForm kind="withdraw" p={p} assets={assetList ?? []} />}
          {action === "allocate" && <AllocateForm p={p} assets={assets} />}
        </section>
        <section className="stack-loose" aria-label="How money moves">
          <ReleaseHelp p={p} />
        </section>
      </div>

      <section className="section" aria-labelledby="hist">
        <div className="section-head">
          <h3 id="hist" className="t-title">
            History
          </h3>
          <Link className="btn btn-ghost btn-sm" to="/activity">
            All activity
          </Link>
        </div>
        <div className="panel panel-flush">
          <div className="list">{moneyActivity.length ? moneyActivity.map((a) => <ActivityRow key={a.id} item={a} now={now} />) : <p className="muted" style={{ padding: 16 }}>No money movements yet.</p>}</div>
        </div>
      </section>
    </div>
  );
}

function TransferForm({ kind, p, assets }: { kind: "deposit" | "withdraw"; p: Portfolio; assets: AssetInfo[] }) {
  const backend = useBackend();
  const usable = assets.filter((a) => a.kind !== "outcome-token" && a.symbol !== "TAXD");
  const [mint, setMint] = useState(usable[0]?.mint ?? "");
  const [text, setText] = useState("");
  const [units, setUnits] = useState<bigint | null>(null);
  const [tx, setTx] = useState<TxRecord | null>(null);
  const asset = usable.find((a) => a.mint === mint);
  if (!asset) return null;
  const walletBal = p.wallet[mint] ?? 0n;
  const avail = p.vault.balances[mint]?.available ?? 0n;
  const balance = kind === "deposit" ? walletBal : avail;
  const ok = units !== null && units > 0n && units <= balance;
  const after = (u: bigint) => (kind === "deposit" ? { w: walletBal - u, v: avail + u } : { w: walletBal + u, v: avail - u });
  const reason = Object.keys(p.wallet).length === 0 ? "Connect your wallet first" : units === null || units === 0n ? "Enter an amount" : units > balance ? (kind === "deposit" ? `Your wallet holds less ${asset.symbol}` : "More than is available — reserved funds can't be withdrawn") : null;
  const submit = async () => {
    try {
      const t = await (kind === "deposit" ? backend.deposit(mint, units!) : backend.withdraw(mint, units!));
      setTx(t);
      setText("");
      setUnits(null);
      toast({ title: `${kind === "deposit" ? "Deposit" : "Withdrawal"} submitted`, detail: "Balances change when it confirms." });
    } catch (e) {
      toast({ title: "Not submitted", detail: (e as Error).message, tone: "error" });
    }
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason) void submit();
      }}
    >
      <label className="field">
        <span className="label">Asset</span>
        <select className="select" value={mint} onChange={(e) => (setMint(e.target.value), setText(""), setUnits(null))}>
          {usable.map((a) => (
            <option key={a.mint} value={a.mint}>
              {a.symbol} — {a.name}
            </option>
          ))}
        </select>
      </label>
      <AmountTicket
        label={kind === "deposit" ? "You deposit" : "You withdraw"}
        asset={asset}
        balance={balance}
        balanceLabel={kind === "deposit" ? "Wallet" : "Available"}
        value={text}
        onChange={(t, u) => (setText(t), setUnits(u))}
      />
      {ok && (
        <div className="panel panel-raised t-small" aria-live="polite">
          <span className="muted">After it confirms</span>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Wallet</span>
            <span>
              <Amount units={walletBal} mint={mint} showSymbol={false} /> <span className="faint">→</span> <Amount units={after(units!).w} mint={mint} />
            </span>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Available in vault</span>
            <span>
              <Amount units={avail} mint={mint} showSymbol={false} /> <span className="faint">→</span> <Amount units={after(units!).v} mint={mint} />
            </span>
          </div>
        </div>
      )}
      {kind === "withdraw" && (p.vault.balances[mint]?.reserved ?? 0n) > 0n && (
        <p className="t-small muted">
          <Amount units={p.vault.balances[mint]!.reserved} mint={mint} /> is reserved in futures and can't be withdrawn until a future releases it.
        </p>
      )}
      <Button variant="primary" type="submit" size="lg" disabledReason={reason}>
        {kind === "deposit" ? "Deposit" : "Withdraw"}
      </Button>
      {tx && <p className="t-small muted">Submitted — progress appears under “In flight” and in Activity.</p>}
    </form>
  );
}

/** Assigning money to a future edits its draft — nothing moves until you authorize it. Drag is a shortcut for the same form. */
function AllocateForm({ p, assets }: { p: Portfolio; assets: Map<string, AssetInfo> }) {
  const backend = useBackend();
  const { data: strategies } = useStrategies();
  const drafts = (strategies ?? []).filter((s) => !s.runtime && s.status !== "SUPERSEDED");
  const [target, setTarget] = useState<{ s: StrategyView; allocationId: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const usdc = [...assets.values()].find((a) => a.symbol === "USDC");
  const avail = usdc ? (p.vault.balances[usdc.mint]?.available ?? 0n) : 0n;
  const onDrop = (e: DragEvent, s: StrategyView) => {
    e.preventDefault();
    setOver(null);
    if (e.dataTransfer.getData("text/maybe-money") !== "available") return;
    const al = s.doc.allocations[0];
    if (al) setTarget({ s, allocationId: al.id });
  };
  return (
    <div className="stack">
      <p className="t-small muted">Set how much of your available balance a draft future will reserve. Money only moves when you sign the future.</p>
      {usdc && (
        <div
          className="draggable-chip panel panel-raised row"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/maybe-money", "available");
            e.dataTransfer.effectAllowed = "copy";
          }}
          aria-label="Available balance. Drag onto a draft, or use the Assign buttons."
        >
          <AssetDot asset={usdc} />
          <span className="grow">
            Available <Amount units={avail} mint={usdc.mint} />
          </span>
          <span className="t-micro faint hide-mobile">drag onto a draft</span>
        </div>
      )}
      {drafts.length === 0 ? (
        <p className="muted t-small">
          No drafts to assign to. <Link className="link" to="/futures/new">Start a future</Link>.
        </p>
      ) : (
        <ul className="stack">
          {drafts.map((s) => (
            <li key={s.id}>
              <div
                className="drop-target panel panel-outline"
                data-over={over === s.id}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("text/maybe-money")) {
                    e.preventDefault();
                    setOver(s.id);
                  }
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => onDrop(e, s)}
              >
                <div className="row">
                  <span className="grow strong truncate">{s.title}</span>
                </div>
                {s.doc.allocations.map((al) => (
                  <div key={al.id} className="row t-small">
                    <span className="grow muted truncate">{al.label}</span>
                    <Amount units={BigInt(al.amount)} mint={al.mint} />
                    <Button size="sm" variant="outline" onClick={() => setTarget({ s, allocationId: al.id })}>
                      Assign
                    </Button>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {target && <AllocateDialog target={target} onClose={() => setTarget(null)} available={avail} assets={assets} onSave={async (doc) => {
        await backend.saveDraft(doc);
        toast({ title: "Draft updated", detail: "Nothing has moved yet. Review and sign the future to reserve it.", tone: "ok" });
        setTarget(null);
      }} />}
    </div>
  );
}

function AllocateDialog({ target, onClose, available, assets, onSave }: { target: { s: StrategyView; allocationId: string }; onClose: () => void; available: bigint; assets: Map<string, AssetInfo>; onSave: (doc: StrategyView["doc"]) => Promise<void> }) {
  const al = target.s.doc.allocations.find((a) => a.id === target.allocationId)!;
  const asset = assets.get(al.mint)!;
  const [text, setText] = useState(formatAmount(BigInt(al.amount), asset.decimals, { grouping: false, minFraction: 0 }));
  const [units, setUnits] = useState<bigint | null>(BigInt(al.amount));
  const others = target.s.doc.allocations.filter((a) => a.id !== al.id && a.mint === al.mint).reduce((s, a) => s + BigInt(a.amount), 0n);
  const total = (units ?? 0n) + others;
  const fits = total <= available;
  const doc = useMemo(() => ({ ...target.s.doc, allocations: target.s.doc.allocations.map((a) => (a.id === al.id && units ? { ...a, amount: units.toString() } : a)) }), [target, al.id, units]);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Assign to a future" description={`${target.s.title} · ${al.label}`}>
      <AmountTicket label="Reserve for this allocation" asset={asset} balance={available} balanceLabel="Available" value={text} onChange={(t, u) => (setText(t), setUnits(u))} autoFocus />
      <div className="panel panel-raised t-small">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">This future would reserve</span>
          <Amount units={total} mint={al.mint} />
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">Available after you sign</span>
          <Amount units={available - (fits ? total : 0n)} mint={al.mint} />
        </div>
      </div>
      {!fits && <Banner tone="warn">That's more than your available balance. You can still save the draft and deposit before signing.</Banner>}
      <p className="t-small muted">This changes the draft only. Nothing moves until you review and sign.</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabledReason={!units || units === 0n ? "Enter an amount" : null} onClick={() => void onSave(doc)}>
          Update draft
        </Button>
      </div>
    </Modal>
  );
}

function ReleaseHelp({ p }: { p: Portfolio }) {
  const active = p.strategies.filter((s) => s.status === "ACTIVE" || s.status === "PAUSED");
  return (
    <>
      <div className="panel">
        <h3 className="t-head">Getting reserved money back</h3>
        <dl className="stack t-small">
          <div>
            <dt className="strong">Pause</dt>
            <dd className="muted">Stops new steps. Funds stay reserved.</dd>
          </div>
          <div>
            <dt className="strong">Cancel</dt>
            <dd className="muted">Releases everything unspent, plus anything the future bought, to available. Completed trades stay done and fees aren't refunded.</dd>
          </div>
          <div>
            <dt className="strong">Unwind a position</dt>
            <dd className="muted">Selling what a future bought is a new trade. Make a future that sells it, or withdraw it and trade elsewhere.</dd>
          </div>
          <div>
            <dt className="strong">Emergency pause</dt>
            <dd className="muted">Stops new steps everywhere. Withdrawals, cancellations and refunds always keep working.</dd>
          </div>
        </dl>
      </div>
      {active.length > 0 && (
        <div className="panel panel-flush">
          <div className="list">
            {active.map((s) => (
              <Link key={s.id} to={`/futures/${s.id}`} className="list-item">
                <span className="grow truncate">{s.title}</span>
                <span className="t-small muted">{s.doc.cancelPolicy === "locked-until-expiry" ? "Locked until expiry" : "Cancel to release"}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export { parseAmount };
