import { useMemo, useState } from "react";
import { type Plan, type ScenarioValue, type SimulationReport, type Strategy } from "@maybe/core";
import { Amount } from "./Amount.tsx";
import { Pill } from "./ui.tsx";

export const BRANCH_VARS = ["var(--c-branch-1)", "var(--c-branch-2)", "var(--c-branch-3)", "var(--c-branch-4)"];

const SHORT: Record<ScenarioValue, string> = { YES: "YES", NO: "NO", VOID: "voided", UNRESOLVED: "unresolved", YES_LATE: "YES too late", NO_LATE: "NO late" };

/** Human description of a group of outcome combinations, using complements where shorter ("B not YES"). */
export function describePath(boxes: Array<Array<ScenarioValue[] | null>>, domains: ScenarioValue[][], refs: string[]): string[] {
  return boxes.map((box) => {
    const parts = box
      .map((vals, i) => {
        if (!vals) return null;
        const dom = domains[i] ?? [];
        const missing = dom.filter((v) => !vals.includes(v));
        const ref = refs[i] ?? `E${i + 1}`;
        if (missing.length === 1 && vals.length > 1) return `${ref} not ${SHORT[missing[0]!]}`;
        return `${ref} ${vals.map((v) => SHORT[v]).join(" or ")}`;
      })
      .filter(Boolean) as string[];
    return parts.length ? parts.join(", ") : "Any outcome";
  });
}

/**
 * The signature view: money at the root, forking into every distinct outcome
 * path the simulator found, each labelled with what leaves, the minimum that
 * can arrive and what comes back. 64 combinations may collapse into a handful
 * of real futures; each path lists the outcome combinations that lead to it.
 */
export function PathsDiagram({
  report,
  plan,
  doc,
  live,
  onSelect,
  selected,
}: {
  report: SimulationReport;
  plan: Plan;
  doc?: Strategy;
  live?: number | null;
  selected?: number | null;
  onSelect?: (i: number) => void;
}) {
  const [internal, setInternal] = useState<number | null>(null);
  const sel = selected ?? internal;
  const reservedMints = new Set(Object.keys(report.reservationByMint));
  const refs = doc?.events.map((e) => e.ref) ?? plan.events.map((_, i) => String.fromCharCode(65 + i));
  const label = (i: number) => doc?.actions[i]?.label ?? `Step ${i + 1}`;
  const rows = useMemo(
    () =>
      report.paths.map((p) => {
        const r = p.representative;
        const spent = Object.entries(r.spentByMint).filter(([, v]) => v > 0n);
        const got = Object.entries(r.receivedByMint).filter(([m, v]) => v > 0n && !reservedMints.has(m));
        const back = Object.entries(r.refunded).filter(([m, v]) => v > 0n && reservedMints.has(m));
        const released = r.executed.filter((e) => plan.actions[e.action]?.kind === 3).reduce((s, e) => s + e.received, 0n);
        const steps = r.executed.filter((e) => plan.actions[e.action]?.kind !== 3).map((e) => label(e.action) + (e.runs > 1 ? ` ×${e.runs}` : ""));
        return { p, spent, got, back, released, steps, when: describePath(p.boxes, report.eventDomains, refs) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, plan],
  );
  const n = rows.length;
  const reservedMint = [...reservedMints][0];
  return (
    <div className="paths">
      <div className="paths-root">
        <span className="t-small muted">Reserved</span>
        <span className="row-tight row-wrap">
          {Object.entries(report.reservationByMint).map(([m, v]) => (
            <span key={m} className="t-title">
              <Amount units={v} mint={m} />
            </span>
          ))}
        </span>
        <span className="t-small faint">
          {report.combos} outcome combination{report.combos === 1 ? "" : "s"} lead to {n} distinct path{n === 1 ? "" : "s"}
          {report.enumeration === "partial" ? " (YES/NO plus refund cases)" : ""}
        </span>
      </div>
      <ol className="paths-branches" aria-label={`${n} outcome paths`}>
        {rows.map((row, i) => {
          const color = BRANCH_VARS[i % BRANCH_VARS.length]!;
          const isLive = live === i;
          const nothing = row.steps.length === 0 && row.released === 0n;
          return (
            <li key={row.p.representative.signature} className="path-row" data-first={i === 0} data-last={i === n - 1}>
              <span className="path-wire" aria-hidden="true">
                <span className="trunk" />
                <span className="twig" style={{ borderColor: color, borderStyle: nothing ? "dashed" : "solid", borderWidth: isLive || sel === i ? "0 0 2.5px 2.5px" : "0 0 1.5px 1.5px" }} />
              </span>
              <button
                type="button"
                className="path-card"
                style={{ ["--branch" as string]: color }}
                aria-pressed={sel === i}
                onClick={() => {
                  setInternal(i);
                  onSelect?.(i);
                }}
              >
                <span className="row" style={{ alignItems: "flex-start" }}>
                  <span className="grow stack-tight">
                    {row.when.map((w, k) => (
                      <span key={k} className="t-small strong" style={{ lineHeight: "19px" }}>
                        {k > 0 && <span className="faint" style={{ fontWeight: 500 }}>or </span>}
                        If {w}
                      </span>
                    ))}
                  </span>
                  {isLive && (
                    <Pill tone="live" icon="dot">
                      Current
                    </Pill>
                  )}
                  <span className="t-micro faint nowrap">
                    {row.p.count} of {report.combos}
                  </span>
                </span>
                <span className="path-flow">
                  {row.spent.map(([m, v]) => (
                    <span key={`s${m}`}>
                      <span className="muted">Spends </span>
                      <Amount units={v} mint={m} />
                    </span>
                  ))}
                  {row.got.length > 0 && (
                    <span>
                      <span className="muted">Gets at least </span>
                      {row.got.map(([m, v], k) => (
                        <span key={m}>
                          {k > 0 && <span className="muted">, </span>}
                          <Amount units={v} mint={m} />
                        </span>
                      ))}
                    </span>
                  )}
                  {row.released > 0n && reservedMint && (
                    <span>
                      <span className="muted">Released early </span>
                      <Amount units={row.released} mint={reservedMint} />
                    </span>
                  )}
                  {row.back.map(([m, v]) => (
                    <span key={`b${m}`}>
                      <span className="muted">{row.p.representative.end === "EXPIRED" ? "Back at expiry " : "Unspent back "}</span>
                      <Amount units={v} mint={m} />
                    </span>
                  ))}
                  {nothing && row.back.length === 0 && <span className="muted">Nothing happens</span>}
                </span>
                {row.steps.length > 0 && <span className="t-micro faint truncate">Runs: {row.steps.join(" · ")}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="t-micro faint">Assets a future buys stay in it until it completes, is cancelled or expires, then return to your available balance. “Gets at least” is the guaranteed minimum. “Unresolved” means still open at expiry.</p>
    </div>
  );
}
