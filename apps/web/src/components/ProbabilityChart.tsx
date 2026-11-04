import { memo, useId, useMemo, useRef, useState } from "react";
import { fmtDateTime } from "../lib/time.ts";

export type Range = "1D" | "1W" | "1M" | "ALL";
const RANGE_SECONDS: Record<Range, number> = { "1D": 86_400, "1W": 7 * 86_400, "1M": 30 * 86_400, ALL: Infinity };

/**
 * Price history for one outcome, 0–100%. Crosshair follows pointer or arrow
 * keys and reports the hovered point so the headline can update. A table
 * equivalent is available for screen readers.
 */
export const ProbabilityChart = memo(function ProbabilityChart({
  points,
  height = 180,
  label,
  onHover,
}: {
  points: Array<{ t: number; bps: number }>;
  height?: number;
  label: string;
  onHover?: (p: { t: number; bps: number } | null) => void;
}) {
  const [range, setRange] = useState<Range>("1M");
  const [hover, setHover] = useState<number | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const ref = useRef<SVGSVGElement>(null);
  const id = useId();
  const W = 640;
  const H = height;
  const pad = { l: 4, r: 40, t: 10, b: 20 };
  const data = useMemo(() => {
    if (points.length === 0) return [];
    const end = points[points.length - 1]!.t;
    const span = RANGE_SECONDS[range];
    const sliced = points.filter((p) => p.t >= end - span);
    return sliced.length >= 2 ? sliced : points.slice(-2);
  }, [points, range]);
  if (data.length < 2) return <p className="muted t-small">No price history for this market.</p>;
  const t0 = data[0]!.t;
  const t1 = data[data.length - 1]!.t;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(t1 - t0, 1)) * (W - pad.l - pad.r);
  const y = (bps: number) => pad.t + (1 - bps / 10_000) * (H - pad.t - pad.b);
  const path = data.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.bps).toFixed(1)}`).join("");
  const area = `${path}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
  const last = data[data.length - 1]!;
  const h = hover !== null ? data[hover] : null;
  const setIdx = (i: number | null) => {
    setHover(i);
    onHover?.(i === null ? null : (data[i] ?? null));
  };
  const fromPointer = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0;
    let bd = Infinity;
    data.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setIdx(best);
  };
  const first = data[0]!;
  const change = last.bps - first.bps;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="segmented" role="group" aria-label="Chart range">
          {(["1D", "1W", "1M", "ALL"] as Range[]).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <span className="t-small muted">
          {h ? (
            <>
              <span className="num">{(h.bps / 100).toFixed(1)}%</span> · {fmtDateTime(h.t)}
            </>
          ) : (
            <>
              {change >= 0 ? "+" : "−"}
              <span className="num">{(Math.abs(change) / 100).toFixed(1)}</span> pts over range
            </>
          )}
        </span>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={`${id}-label`}
        tabIndex={0}
        style={{ display: "block", touchAction: "pan-y", borderRadius: 8 }}
        onPointerMove={(e) => fromPointer(e.clientX)}
        onPointerLeave={() => setIdx(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setIdx(Math.max(0, (hover ?? data.length) - 1));
          else if (e.key === "ArrowRight") setIdx(Math.min(data.length - 1, (hover ?? -1) + 1));
          else if (e.key === "Escape") setIdx(null);
          else return;
          e.preventDefault();
        }}
        onBlur={() => setIdx(null)}
      >
        <title id={`${id}-label`}>{`${label}: ${(last.bps / 100).toFixed(1)}% now, ${(first.bps / 100).toFixed(1)}% at the start of the range. Use arrow keys to inspect points.`}</title>
        {[2500, 5000, 7500].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} stroke="var(--c-line)" strokeDasharray={g === 5000 ? "0" : "2 4"} vectorEffect="non-scaling-stroke" />
            <text x={W - pad.r + 6} y={y(g) + 4} fill="var(--c-text-3)" fontSize="11" fontFamily="var(--f-mono)">
              {g / 100}%
            </text>
          </g>
        ))}
        <path d={area} fill="rgb(241 243 236 / 0.05)" />
        <path d={path} fill="none" stroke="var(--c-text)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <circle cx={x(last.t)} cy={y(last.bps)} r="3.5" fill="var(--c-text)" />
        {h && (
          <g>
            <line x1={x(h.t)} x2={x(h.t)} y1={pad.t} y2={H - pad.b} stroke="var(--c-text-3)" vectorEffect="non-scaling-stroke" />
            <circle cx={x(h.t)} cy={y(h.bps)} r="4" fill="var(--c-canvas)" stroke="var(--c-text)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} aria-expanded={tableOpen} onClick={() => setTableOpen((o) => !o)}>
        {tableOpen ? "Hide data table" : "Show data as a table"}
      </button>
      {tableOpen && (
        <div style={{ maxHeight: 220, overflowY: "auto" }}>
          <table className="table t-small">
            <caption className="sr-only">{label} history</caption>
            <thead>
              <tr>
                <th>Time</th>
                <th className="right">YES price</th>
              </tr>
            </thead>
            <tbody>
              {data
                .filter((_, i) => i % Math.max(1, Math.floor(data.length / 30)) === 0 || i === data.length - 1)
                .map((p) => (
                  <tr key={p.t}>
                    <td>{fmtDateTime(p.t)}</td>
                    <td className="right num">{(p.bps / 100).toFixed(1)}%</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});
