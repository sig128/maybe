import { estimateValue, formatAmount, type AssetInfo } from "@maybe/core";
import { useAssetMap, usePortfolio } from "../data/queries.ts";

export function displayAmount(units: bigint, asset: Pick<AssetInfo, "decimals" | "kind"> | undefined): string {
  if (!asset) return units.toString();
  const stable = asset.kind === "stablecoin";
  const abs = units < 0n ? -units : units;
  const maxF = stable ? 2 : Math.min(asset.decimals, 4);
  if (abs > 0n && abs < 10n ** BigInt(Math.max(asset.decimals - maxF, 0))) return `${units < 0n ? "-" : ""}<${(1 / 10 ** maxF).toFixed(maxF)}`;
  return formatAmount(units, asset.decimals, { minFraction: stable ? 2 : 0, maxFraction: maxF });
}

export function Amount({ units, mint, signed, className, showSymbol = true }: { units: bigint; mint: string; signed?: boolean; className?: string; showSymbol?: boolean }) {
  const assets = useAssetMap();
  const a = assets.get(mint);
  const sign = signed && units > 0n ? "+" : "";
  return (
    <span className={`num ${className ?? ""}`}>
      {sign}
      {displayAmount(units, a)}
      {showSymbol && <span className="muted"> {a?.symbol ?? "?"}</span>}
    </span>
  );
}

/** Estimated USD value. Always labelled as an estimate, with its source available on hover. */
export function UsdEstimate({ units, mint, prefix = "≈ " }: { units: bigint; mint: string; prefix?: string }) {
  const { data } = usePortfolio();
  const assets = useAssetMap();
  const a = assets.get(mint);
  const est = data?.estimates[mint];
  if (!a || !est) return <span className="faint t-small">no price</span>;
  const usd = estimateValue(units, a.decimals, est.priceE6);
  return (
    <span className="faint t-small num" title={`Estimate from ${est.source}`}>
      {prefix}${formatAmount(usd, 6, { minFraction: 2, maxFraction: 2 })}
    </span>
  );
}

export function usdOf(units: bigint, mint: string, assets: Map<string, AssetInfo>, estimates: Record<string, { priceE6: bigint }> | undefined): bigint {
  const a = assets.get(mint);
  const p = estimates?.[mint]?.priceE6;
  if (!a || p === undefined) return 0n;
  return estimateValue(units, a.decimals, p);
}

export function formatUsd(e6: bigint, opts: { compact?: boolean } = {}): string {
  return `$${formatAmount(e6, 6, { minFraction: 2, maxFraction: 2, ...(opts.compact ? { compact: true } : {}) })}`;
}

export function AssetDot({ asset, size = 22 }: { asset: Pick<AssetInfo, "symbol" | "hue" | "kind"> | undefined; size?: number }) {
  const hue = asset?.hue ?? 0;
  const bg = asset?.kind === "stablecoin" ? "#d9e3ec" : `oklch(0.82 0.09 ${hue})`;
  const label = (asset?.symbol ?? "?").replace(/[^A-Z]/g, "").slice(0, 2) || "?";
  return (
    <span className="asset-dot" style={{ width: size, height: size, background: bg, fontSize: size < 20 ? 8 : 10 }} aria-hidden="true">
      {label}
    </span>
  );
}

export function AssetLabel({ mint }: { mint: string }) {
  const a = useAssetMap().get(mint);
  return (
    <span className="row-tight">
      <AssetDot asset={a} size={18} />
      <span>{a?.symbol ?? "Unknown"}</span>
    </span>
  );
}
