import { PublicKey } from "@solana/web3.js";
import { Reader, eventDisc, hasDisc } from "./codec.ts";
import vaultIdl from "./idl/maybe_vault.json" with { type: "json" };

/** Program log events ("Program data: <base64>") and error-code names. */

export interface ExecutionReceiptEvent {
  name: "ExecutionReceipt";
  strategy: PublicKey;
  planHash: Uint8Array;
  action: number;
  run: number;
  skippedRuns: number;
  execNonce: bigint;
  at: number;
  kind: number;
  inMint: PublicKey;
  outMint: PublicKey;
  amount: bigint;
  fee: bigint;
  amountIn: bigint;
  amountOut: bigint;
  recipient: PublicKey;
}

export type VaultEvent =
  | ExecutionReceiptEvent
  | { name: "StrategyActivated"; strategy: PublicKey; vault: PublicKey; planHash: Uint8Array; reserved: bigint[]; byPolicy: boolean }
  | { name: "StrategyClosed"; strategy: PublicKey; mode: number; refunded: bigint[] }
  | { name: "Deposited" | "Withdrawn"; vault: PublicKey; mint: PublicKey; amount: bigint }
  | { name: "EventResolved"; event: PublicKey; status: number; outcome: number; finalAt: number }
  | { name: "PolicyChanged"; policy: PublicKey; revoked: boolean; epoch: number };

function decodeOne(data: Uint8Array): VaultEvent | null {
  const rd = new Reader(data, 8);
  if (hasDisc(data, eventDisc("ExecutionReceipt"))) {
    return {
      name: "ExecutionReceipt",
      strategy: rd.pubkey(),
      planHash: rd.fixed(32),
      action: rd.u8(),
      run: rd.u16(),
      skippedRuns: rd.u16(),
      execNonce: rd.u64(),
      at: Number(rd.i64()),
      kind: rd.u8(),
      inMint: rd.pubkey(),
      outMint: rd.pubkey(),
      amount: rd.u64(),
      fee: rd.u64(),
      amountIn: rd.u64(),
      amountOut: rd.u64(),
      recipient: rd.pubkey(),
    };
  }
  if (hasDisc(data, eventDisc("StrategyActivated"))) {
    return { name: "StrategyActivated", strategy: rd.pubkey(), vault: rd.pubkey(), planHash: rd.fixed(32), reserved: Array.from({ length: 6 }, () => rd.u64()), byPolicy: rd.bool() };
  }
  if (hasDisc(data, eventDisc("StrategyClosed"))) {
    return { name: "StrategyClosed", strategy: rd.pubkey(), mode: rd.u8(), refunded: Array.from({ length: 6 }, () => rd.u64()) };
  }
  for (const n of ["Deposited", "Withdrawn"] as const) if (hasDisc(data, eventDisc(n))) return { name: n, vault: rd.pubkey(), mint: rd.pubkey(), amount: rd.u64() };
  if (hasDisc(data, eventDisc("EventResolved"))) return { name: "EventResolved", event: rd.pubkey(), status: rd.u8(), outcome: rd.u8(), finalAt: Number(rd.i64()) };
  if (hasDisc(data, eventDisc("PolicyChanged"))) return { name: "PolicyChanged", policy: rd.pubkey(), revoked: rd.bool(), epoch: rd.u32() };
  return null;
}

/** Parse vault events from transaction log messages (only top-level "Program data" lines of our program). */
export function parseVaultEvents(logs: string[] | null | undefined, programId: PublicKey): VaultEvent[] {
  if (!logs) return [];
  const out: VaultEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program (\w+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === programId.toBase58()) {
      const ev = decodeOne(Buffer.from(line.slice("Program data: ".length), "base64"));
      if (ev) out.push(ev);
    }
  }
  return out;
}

const ERRORS: Record<number, string> = Object.fromEntries((vaultIdl as { errors: Array<{ code: number; name: string }> }).errors.map((e) => [e.code, e.name]));

/** Map an Anchor custom error code (e.g. 6034) to its name (e.g. "RouteDeltaViolation"). */
export function vaultErrorName(code: number): string | undefined {
  return ERRORS[code];
}

/** Extract the custom error code from a failed transaction's error or logs. */
export function errorCodeFrom(err: unknown, logs?: string[] | null): number | undefined {
  const s = JSON.stringify(err ?? "");
  const m = /"Custom":(\d+)/.exec(s);
  if (m) return Number(m[1]);
  for (const l of logs ?? []) {
    const x = /custom program error: 0x([0-9a-f]+)/i.exec(l);
    if (x) return Number.parseInt(x[1]!, 16);
    const y = /Error Number: (\d+)/.exec(l);
    if (y) return Number(y[1]);
  }
  return undefined;
}
