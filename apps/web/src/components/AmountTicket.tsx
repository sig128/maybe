import { useId, useState, type ReactNode } from "react";
import { MoneyError, formatAmount, parseAmount, percentOf, type AssetInfo } from "@maybe/core";
import { AssetDot, UsdEstimate, displayAmount } from "./Amount.tsx";

/**
 * Amount-first ticket. The balance and Max sit inline; percentage chips floor to
 * the asset's decimals and never exceed what can be spent. Parsing is exact:
 * extra decimal places are an error, not a silent rounding.
 */
export function AmountTicket({
  label,
  asset,
  balance,
  balanceLabel = "Available",
  value,
  onChange,
  error,
  feeReserve = 0n,
  footer,
  autoFocus,
}: {
  label: string;
  asset: AssetInfo;
  balance: bigint;
  balanceLabel?: string;
  value: string;
  onChange: (text: string, units: bigint | null) => void;
  error?: string | null;
  feeReserve?: bigint;
  footer?: ReactNode;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  let units: bigint | null = null;
  let parseError: string | null = null;
  if (value.trim() !== "") {
    try {
      units = parseAmount(value, asset.decimals);
    } catch (e) {
      parseError = e instanceof MoneyError && e.code === "TOO_MANY_DECIMALS" ? `${asset.symbol} supports at most ${asset.decimals} decimal places.` : "Enter a number like 125.50.";
    }
  }
  const over = units !== null && units > balance ? `That's more than your ${balanceLabel.toLowerCase()} balance.` : null;
  const shown = parseError ?? over ?? error ?? null;
  const set = (u: bigint) => {
    const text = formatAmount(u, asset.decimals, { grouping: false, minFraction: 0 });
    onChange(text, u);
    setTouched(true);
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="ticket" data-invalid={!!shown && touched}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label htmlFor={id} className="label">
            {label}
          </label>
          <span className="t-small muted">
            {balanceLabel}: <span className="num">{displayAmount(balance, asset)}</span>
          </span>
        </div>
        <div className="ticket-row">
          <input
            id={id}
            className="amount-input"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0"
            value={value}
            autoFocus={autoFocus}
            aria-invalid={!!shown || undefined}
            aria-describedby={`${id}-err`}
            onChange={(e) => {
              const t = e.target.value.replace(/[^0-9.,]/g, "").replace(",", ".");
              let u: bigint | null = null;
              try {
                u = t ? parseAmount(t, asset.decimals) : null;
              } catch {
                u = null;
              }
              onChange(t, u);
            }}
            onBlur={() => setTouched(true)}
          />
          <span className="asset-pill">
            <AssetDot asset={asset} />
            {asset.symbol}
          </span>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="chips" role="group" aria-label="Quick amounts">
            {[25, 50, 75].map((p) => (
              <button key={p} type="button" className="chip" onClick={() => set(percentOf(balance, p, feeReserve))} disabled={balance === 0n}>
                {p}%
              </button>
            ))}
            <button type="button" className="chip" onClick={() => set(percentOf(balance, 100, feeReserve))} disabled={balance === 0n}>
              Max
            </button>
          </div>
          {units !== null && !parseError && <UsdEstimate units={units} mint={asset.mint} />}
        </div>
      </div>
      <div id={`${id}-err`} aria-live="polite">
        {shown && (touched || parseError) && <p className="error-text">{shown}</p>}
      </div>
      {footer}
    </div>
  );
}
