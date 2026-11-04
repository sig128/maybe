import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, Message, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { reservationByMint, decodePlan, type TxState } from "@maybe/core";
import { fmtUnits, type TxRecord } from "@maybe/api";
import { repoRoot, type VaultEvent } from "@maybe/sdk";
import { newId, type App } from "./app.ts";
import { Chain, ChainError, type TxPlan } from "./chain.ts";
import { withTx } from "./db.ts";
import { log, shortAddr } from "./log.ts";
import {
  createIntent,
  getIntent,
  getStrategy,
  insertTx,
  intentTxs,
  leaseIntent,
  logActivity,
  markEffect,
  releaseIntent,
  setIntent,
  setTx,
  strategyProjections,
  txRecord,
  updateStrategy,
  type IntentKind,
  type IntentRow,
  type TxRow,
} from "./store.ts";

/**
 * Intents: a user request turned into exact transaction bytes. The wallet
 * signs those bytes; the server attaches the signatures, sends the
 * transactions strictly in order, and applies each one's effects exactly once
 * after it confirms. Everything is persisted, so a restarted process resumes
 * an intent where it stopped; re-sending identical signed bytes can't apply
 * twice because the signature is the transaction's identity.
 */

export class BadRequest extends Error {
  readonly status = 400;
}

export interface BuiltIntent {
  intent: string;
  labels: string[];
  txs: string[];
}

export async function buildIntent(
  app: App,
  o: { kind: IntentKind; owner: string; actor: string; key: string; strategyId?: string; payload: Record<string, unknown>; plans: TxPlan[] },
): Promise<BuiltIntent> {
  const compiled = await app.chain.compile(o.plans, new PublicKey(o.actor));
  const id = newId("int");
  const result = await withTx(app.db, async (c) => {
    const { intent, created } = await createIntent(c, { id, key: `${o.owner}:${o.key}`, kind: o.kind, actor: o.actor, owner: o.owner, strategyId: o.strategyId ?? null, payload: o.payload });
    if (!created) return intent;
    for (const [seq, t] of compiled.entries()) await insertTx(c, { id: newId("tx"), intentId: id, seq, label: t.label, ...(t.effect ? { effect: t.effect } : {}), message: t.message, blockhash: t.blockhash, lastValidBlockHeight: t.lastValidBlockHeight });
    return intent;
  });
  const txs = await intentTxs(app.db, result.id);
  return { intent: result.id, labels: txs.map((t) => t.label), txs: txs.map((t) => Buffer.from(JSON.stringify({ message: t.message.toString("base64") })).toString("base64")) };
}

/** The user's wallet signed; attach, persist, and start sending. Idempotent for retries. */
export async function submitSigned(app: App, user: string, intentId: string, signed: string[]): Promise<TxRecord[]> {
  const intent = await getIntent(app.db, intentId);
  if (!intent || intent.owner !== user) throw new BadRequest("Unknown request.");
  const txs = await intentTxs(app.db, intentId);
  if (intent.state !== "BUILT") return txs.map(txRecord);
  if (signed.length !== txs.length) throw new BadRequest(`Expected ${txs.length} signed transaction(s).`);
  const attached = txs.map((t, i) => {
    let parsed: { signer: string; signature: string };
    try {
      parsed = JSON.parse(signed[i]!) as { signer: string; signature: string };
    } catch {
      throw new BadRequest("Malformed signature.");
    }
    if (parsed.signer !== intent.actor) throw new BadRequest("Signed by the wrong key.");
    try {
      return { t, raw: Chain.attach(t.message, parsed.signer, parsed.signature), signature: parsed.signature };
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  });
  const started = await withTx(app.db, async (c) => {
    const r = await c.query(`UPDATE intents SET state = 'SUBMITTING', updated_at = now() WHERE id = $1 AND state = 'BUILT'`, [intentId]);
    if (!r.rowCount) return false;
    for (const a of attached) await setTx(c, a.t.id, { state: "SIGNED", signedTx: a.raw, signature: a.signature });
    await onSigned(app, c, intent);
    return true;
  });
  if (started) {
    await app.publish(["strategies", "portfolio", "activity"]);
    void runIntent(app, intentId).catch((e) => log.error({ intent: intentId, err: (e as Error).message }, "intent runner crashed"));
  }
  return (await intentTxs(app.db, intentId)).map(txRecord);
}

/** Server-held signer (agent session key on localnet): sign the intent's messages directly. */
export async function signAndSubmitAs(app: App, intentId: string, signer: Keypair): Promise<TxRecord[]> {
  const txs = await intentTxs(app.db, intentId);
  const intent = (await getIntent(app.db, intentId))!;
  const signed = txs.map((t) => {
    const tx = Transaction.populate(Message.from(t.message));
    tx.sign(signer);
    return JSON.stringify({ signer: signer.publicKey.toBase58(), signature: bs58.encode(tx.signature!) });
  });
  return submitSigned(app, intent.owner, intentId, signed);
}

async function onSigned(app: App, c: Parameters<typeof setTx>[0], intent: IntentRow): Promise<void> {
  if (intent.kind === "authorize" && intent.strategyId) await updateStrategy(c, intent.strategyId, { status: "UPLOADING", lastError: null });
}

/** Send an intent's transactions in order. Safe to call from several processes: the lease admits one. */
export async function runIntent(app: App, intentId: string): Promise<void> {
  if (!(await leaseIntent(app.db, intentId, app.runner))) return;
  try {
    const intent = (await getIntent(app.db, intentId))!;
    const txs = await intentTxs(app.db, intentId);
    for (const t of txs) {
      if (t.state === "CONFIRMED" || t.state === "FINALIZED") {
        await applyEffect(app, intent, t, txs, null);
        continue;
      }
      if (t.state === "FAILED" || t.state === "EXPIRED") return await failRest(app, intent, txs, t, t.error ?? "An earlier step didn't land.");
      if (t.state === "SUBMITTED" && t.signature) {
        const st = await app.chain.signatureStatus(t.signature).catch(() => null);
        if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          await setTx(app.db, t.id, { state: "CONFIRMED", slot: st.slot });
          await applyEffect(app, intent, { ...t, state: "CONFIRMED", slot: st.slot }, txs, null);
          continue;
        }
      }
      await leaseIntent(app.db, intentId, app.runner);
      if (process.env.MAYBE_CRASH_BEFORE_SEND === intent.kind) {
        log.warn({ intent: intentId }, "MAYBE_CRASH_BEFORE_SEND set: exiting before sending (test hook)");
        process.exit(86);
      }
      const out = await app.chain.sendSigned(t.signedTx!, t.blockhash, t.lastValidBlockHeight, (sig) => {
        void setTx(app.db, t.id, { state: "SUBMITTED", signature: sig }).then(() => app.publish(["strategies", "portfolio"]));
      });
      if (out.ok) {
        await setTx(app.db, t.id, { state: "CONFIRMED", ...(out.slot ? { slot: out.slot } : {}) });
        await applyEffect(app, intent, { ...t, state: "CONFIRMED" }, txs, out.events);
        continue;
      }
      await setTx(app.db, t.id, { state: out.expired ? "EXPIRED" : "FAILED", error: out.error ?? "Rejected" });
      return await failRest(app, intent, txs, t, out.error ?? "Rejected");
    }
    await setIntent(app.db, intentId, "DONE");
    await app.publish(["strategies", "portfolio", "activity", "wallet", "agents"]);
  } finally {
    await releaseIntent(app.db, intentId, app.runner);
  }
}

async function failRest(app: App, intent: IntentRow, txs: TxRow[], failed: TxRow, error: string): Promise<void> {
  for (const t of txs) if (t.seq > failed.seq && (t.state === "SIGNED" || t.state === "BUILT")) await setTx(app.db, t.id, { state: "FAILED", error: "Not sent: an earlier step didn't land." });
  await setIntent(app.db, intent.id, "FAILED", error);
  if (await markEffect(app.db, intent.id, -1)) await applyFailure(app, intent, failed, error);
  await app.publish(["strategies", "portfolio", "activity", "wallet", "agents"]);
}

// ───────────────────────────────────────── effects (exactly once per confirmed transaction)

async function applyEffect(app: App, intent: IntentRow, t: TxRow, all: TxRow[], events: VaultEvent[] | null): Promise<void> {
  if (!(await markEffect(app.db, intent.id, t.seq))) return;
  const db = app.db;
  const now = await app.now();
  const last = t.seq === all.length - 1;
  const p = intent.payload as Record<string, unknown>;
  const fmt = (m: string, u: bigint) => fmtUnits(app.fx, m, u);
  const tx: TxRecord = txRecord({ ...t, state: "CONFIRMED" });
  try {
    switch (intent.kind) {
      case "deposit":
      case "withdraw": {
        const mint = p.mint as string;
        const units = p.units as bigint;
        await app.indexer.syncVault(intent.owner);
        await logActivity(db, intent.owner, { at: now, kind: intent.kind, title: `${intent.kind === "deposit" ? "Deposited" : "Withdrew"} ${fmt(mint, units)}`, actor: "you", amounts: [{ mint, units, dir: intent.kind === "deposit" ? "in" : "out" }], tx }, `tx:${t.signature}`);
        break;
      }
      case "authorize": {
        const id = intent.strategyId!;
        // once the account exists on-chain with this plan's hash, the version is fixed
        if (t.seq === 0 && p.strategyAccount) await updateStrategy(db, id, { strategyAccount: p.strategyAccount as string });
        if (!last) {
          if (t.seq === all.length - 2) await updateStrategy(db, id, { status: "ACTIVATING" });
          break;
        }
        const s = await getStrategy(db, id);
        await updateStrategy(db, id, { status: "ACTIVE", signedAt: now, lastError: null });
        if (p.supersedes) await updateStrategy(db, p.supersedes as string, { status: "SUPERSEDED" });
        await app.indexer.syncVault(intent.owner);
        const per = s?.planBytes ? reservationByMint(decodePlan(s.planBytes)) : {};
        const via = p.policyLabel ? `Funded by an agent session key under “${p.policyLabel}”; the program checked the policy's limits. ` : "";
        await logActivity(
          db,
          intent.owner,
          { at: now, kind: "activate", title: `Authorized “${s?.title ?? "future"}”`, detail: `${via}Reserved ${Object.entries(per).map(([m, v]) => fmt(m, v)).join(" + ")}. Plan ${(s?.planHash ?? "").slice(0, 12)}…`, actor: p.policyLabel ? "agent" : "you", strategyId: id, amounts: Object.entries(per).map(([mint, units]) => ({ mint, units, dir: "move" as const })), tx },
          `tx:${t.signature}`,
        );
        break;
      }
      case "pause": {
        const paused = p.paused as boolean;
        await updateStrategy(db, intent.strategyId!, { status: paused ? "PAUSED" : "ACTIVE" });
        await app.indexer.syncVault(intent.owner);
        const s = await getStrategy(db, intent.strategyId!);
        await logActivity(db, intent.owner, { at: now, kind: "pause", title: `${paused ? "Paused" : "Resumed"} “${s?.title}”`, actor: "you", strategyId: intent.strategyId!, tx }, `tx:${t.signature}`);
        break;
      }
      case "cancel": {
        await updateStrategy(db, intent.strategyId!, { status: "CANCELLED" });
        await app.indexer.syncVault(intent.owner);
        const s = await getStrategy(db, intent.strategyId!);
        const evs = events ?? (t.signature ? await app.indexer.txEvents(t.signature) : []);
        const state = s?.strategyAccount ? (await strategyProjections(db, { accounts: [s.strategyAccount] })).get(s.strategyAccount) : undefined;
        if (state && s) for (const e of evs) await app.indexer.applyEvent(e, t.signature!, t.slot ?? 0, state, s);
        break;
      }
      case "policy-create": {
        await app.indexer.syncPolicies(intent.owner);
        await logActivity(db, intent.owner, { at: now, kind: "policy", title: `Granted “${p.label as string}”`, detail: "An agent session key may create and fund futures within these limits until it expires or you revoke it. It can never withdraw.", actor: "you", tx }, `tx:${t.signature}`);
        break;
      }
      case "policy-revoke": {
        await app.indexer.syncPolicies(intent.owner);
        await logActivity(db, intent.owner, { at: now, kind: "policy", title: `Revoked “${p.label as string}”`, actor: "you", tx }, `tx:${t.signature}`);
        break;
      }
      case "kill-switch": {
        await app.indexer.syncVault(intent.owner);
        await logActivity(db, intent.owner, { at: now, kind: "policy", title: "Kill switch: all agent authority revoked", detail: "Every policy for this vault is void. Withdrawals and refunds are unaffected.", actor: "you", tx }, `tx:${t.signature}`);
        break;
      }
    }
  } catch (e) {
    // projections catch up on the next indexer tick; the effect itself is recorded
    log.warn({ intent: intent.id, seq: t.seq, err: (e as Error).message }, "effect follow-up failed");
  }
  await app.publish(["strategies", "portfolio", "activity", "wallet", "agents", "ops"]);
}

async function applyFailure(app: App, intent: IntentRow, t: TxRow, error: string): Promise<void> {
  const db = app.db;
  const now = await app.now();
  const p = intent.payload as Record<string, unknown>;
  const tx = txRecord({ ...t, state: t.state as TxState });
  if (intent.kind === "authorize" && intent.strategyId) {
    const s = await getStrategy(db, intent.strategyId);
    await updateStrategy(db, intent.strategyId, { status: "ACTIVATION_FAILED", lastError: error });
    await logActivity(db, intent.owner, { at: now, kind: "failure", title: `Authorization of “${s?.title}” didn't complete`, detail: `${t.label}: ${error} No funds were reserved.`, actor: "system", strategyId: intent.strategyId, tx }, `fail:${intent.id}`);
    return;
  }
  const what: Record<IntentKind, string> = {
    deposit: "Deposit",
    withdraw: "Withdrawal",
    authorize: "Authorization",
    pause: "Pause",
    cancel: "Cancel",
    "policy-create": `Grant of “${String(p.label ?? "policy")}”`,
    "policy-revoke": "Revoke",
    "kill-switch": "Kill switch",
  };
  await logActivity(db, intent.owner, { at: now, kind: "failure", title: `${what[intent.kind]} didn't land`, detail: `${error} Nothing changed.`, actor: "system", ...(intent.strategyId ? { strategyId: intent.strategyId } : {}), tx }, `fail:${intent.id}`);
}

// ───────────────────────────────────────── localnet session-key keystore

/**
 * Agent session keys on localnet live in .localnet/session-keys (gitignored,
 * mode 600). A production deployment must hold them in a KMS/HSM instead;
 * the server refuses to create server-held keys outside localnet.
 */
export class LocalKeystore {
  private readonly dir = join(repoRoot(), ".localnet", "session-keys");

  constructor(private readonly app: App) {
    if (app.cfg.MAYBE_MODE !== "localnet") throw new ChainError("Server-held agent session keys are only available on localnet.");
  }

  create(): Keypair {
    mkdirSync(this.dir, { recursive: true });
    const k = this.app.chain.newSessionKey();
    const path = join(this.dir, `${k.publicKey.toBase58()}.json`);
    writeFileSync(path, JSON.stringify(Array.from(k.secretKey)));
    chmodSync(path, 0o600);
    log.info({ sessionKey: shortAddr(k.publicKey.toBase58()) }, "created localnet agent session key");
    return k;
  }

  load(pub: string): Keypair {
    const path = join(this.dir, `${pub}.json`);
    if (!existsSync(path)) throw new ChainError("This policy's session key isn't held by this server.");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  }
}
