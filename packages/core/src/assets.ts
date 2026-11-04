/**
 * Asset metadata and token-program support rules.
 *
 * The vault only accepts mints whose transfer behaviour it can account for
 * exactly. Classic SPL Token mints are supported. Token-2022 mints are accepted
 * only with informational extensions; anything that can change balances,
 * redirect transfers, freeze by default, or move funds with a third-party
 * authority is rejected. The program enforces the same list when an asset is
 * enabled (see programs/maybe-vault/src/assets.rs).
 */

export type TokenProgramKind = "spl-token" | "token-2022";
export type AssetKind = "stablecoin" | "project-token" | "asset" | "outcome-token";
export type Environment = "simulation" | "localnet" | "devnet" | "mainnet";

export interface AssetInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  tokenProgram: TokenProgramKind;
  /** Token-2022 extension names present on the mint */
  extensions: string[];
  /** issuer can freeze token accounts (custody risk disclosed to users) */
  freezeAuthority: boolean;
  kind: AssetKind;
  environment: Environment;
  /** estimated price in quote micro-units (USD 1e-6) per whole token — display only */
  priceE6?: bigint;
  priceSource?: string;
  priceAt?: number;
  /** identity-color hint for charts (never used for P/L meaning) */
  hue?: number;
  note?: string;
}

export const ALLOWED_TOKEN2022_EXTENSIONS = [
  "MetadataPointer",
  "TokenMetadata",
  "GroupPointer",
  "GroupMemberPointer",
  "TokenGroup",
  "TokenGroupMember",
] as const;

/** Extensions that make exact vault accounting or custody impossible. */
export const FORBIDDEN_TOKEN2022_EXTENSIONS: Record<string, string> = {
  TransferFeeConfig: "transfer fees change the amount received",
  TransferHook: "transfer hooks run arbitrary programs on every transfer",
  PermanentDelegate: "a permanent delegate can move vault funds",
  NonTransferable: "tokens cannot leave the vault",
  DefaultAccountState: "new accounts may start frozen",
  ConfidentialTransferMint: "confidential balances cannot be reconciled",
  ConfidentialTransferFeeConfig: "confidential fees cannot be reconciled",
  Pausable: "the issuer can pause all transfers",
  ScaledUiAmount: "displayed amounts diverge from base units",
  InterestBearingConfig: "displayed amounts diverge from base units",
  MintCloseAuthority: "the mint can be closed and recreated",
  CpiGuard: "account-level CPI guard blocks program-controlled transfers",
  MemoTransfer: "required memos break program transfers",
};

export interface AssetSupport {
  supported: boolean;
  reasons: string[];
  warnings: string[];
}

export function assetSupport(a: Pick<AssetInfo, "tokenProgram" | "extensions" | "freezeAuthority" | "decimals">): AssetSupport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (a.decimals < 0 || a.decimals > 12) reasons.push("unsupported decimals");
  if (a.tokenProgram === "token-2022") {
    for (const ext of a.extensions) {
      const why = FORBIDDEN_TOKEN2022_EXTENSIONS[ext];
      if (why) reasons.push(`${ext}: ${why}`);
      else if (!(ALLOWED_TOKEN2022_EXTENSIONS as readonly string[]).includes(ext)) reasons.push(`${ext}: unknown extension`);
    }
  } else if (a.extensions.length > 0) {
    reasons.push("classic SPL Token mints have no extensions");
  }
  if (a.freezeAuthority) warnings.push("The issuer holds a freeze authority and could freeze the vault's token account.");
  return { supported: reasons.length === 0, reasons, warnings };
}
